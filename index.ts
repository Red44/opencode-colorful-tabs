/**
 * colored-tabs — server-side entry.
 *
 * Opt-in MCP session injection: stamps the live OpenCode session ID into
 * every outgoing MCP tool call as `opencode_session`, and widens each MCP
 * tool's declared input schema so the extra argument validates.
 *
 * Why: MCP servers can use the session ID to call back into the session via
 * the HTTP API (e.g. POST /api/session/{id}/synthetic for machine events, or
 * /prompt for a real turn). Off by default; enable per project:
 *
 *   "plugins": [{
 *     "package": "/path/to/colored-tabs",
 *     "options": { "mcpSessionInjection": true }
 *   }]
 *
 * Caveats (by design, see README):
 *  - Strict-validating MCP servers (additionalProperties: false) reject the
 *    widened field unless they declare it themselves — use the per-server
 *    allowlist to exclude them.
 *  - Only inject into servers you trust: the session ID lets them write into
 *    your session through the HTTP API.
 *
 * Loaded as a plain plugin object: importing the SDK package does not resolve
 * for local directory plugins on OpenCode 2.0.23.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"

type AnyObj = Record<string, any>

interface Options {
  mcpSessionInjection?: boolean
  mcpSessionInjectionServers?: string[]
  debug?: boolean
}

const DEBUG_FILE = `/tmp/opencode/colored-tab-plugin/mcp-injection-${process.pid}.log`
function debug(enable: boolean, ...args: unknown[]): void {
  if (!enable && process.env.COLORED_TABS_DEBUG !== "1") return
  try {
    appendFileSync(
      DEBUG_FILE,
      `${new Date().toISOString()} ${args.map((a) => {
        try {
          return typeof a === "string" ? a : JSON.stringify(a)
        } catch {
          return String(a)
        }
      }).join(" ")}\n`,
    )
  } catch {}
}

const plugin = {
  id: "red.colored-tabs.server",
  async setup(ctx: AnyObj) {
    const options = (ctx.options ?? {}) as Options
    debug(true, "mcp:setup", "injection", options.mcpSessionInjection === true)
    if (options.mcpSessionInjection !== true) return
    const debugOn = options.debug === true
    const toolCtx = ctx.tool as AnyObj | undefined
    if (!toolCtx || typeof toolCtx.transform !== "function" || typeof toolCtx.hook !== "function") {
      debug(debugOn, "mcp:unavailable", "tool transform/hook APIs missing in this OpenCode version")
      return
    }

    // MCP tool ids are `<server>_<tool>` (dots become `_`). Servers connect
    // asynchronously after setup, so the name cache refreshes periodically;
    // transforms replay on every catalog refresh and pick up the new names.
    let serverNames = new Set<string>()
    const knownNames = new Set<string>()
    const refreshServers = async (): Promise<void> => {
      let names = new Set<string>()
      try {
        const listed = await ctx.mcp.list()
        const data = (listed as AnyObj)?.data ?? listed
        const entries = Array.isArray(data)
          ? data
          : data && typeof data === "object"
            ? Object.values(data)
            : []
        for (const entry of entries) {
          const name =
            typeof entry === "string"
              ? entry
              : Array.isArray(entry)
                ? entry[0]
                : ((entry as AnyObj)?.name ?? (entry as AnyObj)?.id)
          if (name) names.add(String(name).replace(/\./g, "_"))
        }
      } catch (error) {
        debug(debugOn, "mcp:list failed", error)
      }
      const fingerprint = [...names].sort().join(",")
      if (!knownNames.has(fingerprint)) {
        knownNames.add(fingerprint)
        debug(debugOn, "mcp:servers", [...names])
      }
      serverNames = names
    }
    await refreshServers()
    // Refresh frequently at first (servers connect within seconds), then back
    // off. Whenever the set changes, replay transforms so newly connected
    // servers' tools are widened immediately.
    let serverRefreshTimer: ReturnType<typeof setTimeout> | undefined
    let refreshDelay = 2_000
    const scheduleRefresh = (): void => {
      serverRefreshTimer = setTimeout(() => {
        void (async () => {
          const before = [...serverNames].sort().join(",")
          await refreshServers()
          const after = [...serverNames].sort().join(",")
          if (before !== after && typeof toolCtx.reload === "function") {
            try {
              await toolCtx.reload()
            } catch {}
          }
          refreshDelay = Math.min(15_000, refreshDelay * 2)
          scheduleRefresh()
        })()
      }, refreshDelay)
    }
    scheduleRefresh()

    const allow = (options.mcpSessionInjectionServers ?? []).map((name) => String(name).replace(/\./g, "_"))
    // With an allowlist, only those servers match; otherwise every connected
    // MCP server's tools are injected.
    const isEnabled = (toolID: string): boolean => {
      for (const name of allow.length > 0 ? allow : serverNames) {
        if (toolID === name || toolID.startsWith(`${name}_`)) return true
      }
      return false
    }

    // 1. Widen every injected MCP tool's input schema so `opencode_session`
    //    validates. Transforms replay over MCP catalog refreshes.
    const transformRegistration = await toolCtx.transform((editor: AnyObj) => {
      let widened = 0
      for (const tool of editor.list()) {
        if (!isEnabled(String(tool.id))) continue
        editor.update(String(tool.id), (t: AnyObj) => {
          const input = (t.input ?? { type: "object", properties: {} }) as AnyObj
          t.input = {
            ...input,
            properties: { ...(input.properties ?? {}), opencode_session: { type: "string" } },
          }
        })
        widened++
      }
      debug(debugOn, "mcp:widened", widened, "servers", [...serverNames])
    })

    // 2. Stamp the live session ID into every outgoing injected MCP call.
    const hookRegistration = await toolCtx.hook("execute.before", (event: AnyObj) => {
      const toolID = String(event?.tool ?? "")
      if (!isEnabled(toolID)) return
      event.input = { ...(event.input ?? {}), opencode_session: event.sessionID }
      debug(debugOn, "mcp:injected", toolID, String(event?.sessionID ?? ""))
    })

    debug(debugOn, "mcp:session-injection active", [...serverNames])

    // ---- agent-facing cross-session tools: opencode.session_search / .session_message ----
    const sessionCtx = ctx.session as AnyObj | undefined

    /** Dependency-free subsequence scorer: contiguity + word-start bonuses, shorter wins ties. */
    function fuzzyScore(query: string, target: string): number {
      const q = query.toLowerCase()
      const t = target.toLowerCase()
      if (!q) return 0
      let score = 0
      let ti = 0
      let streak = 0
      for (const ch of q) {
        const idx = t.indexOf(ch, ti)
        if (idx === -1) return -1
        if (idx === ti) {
          streak++
          score += 10 + streak * 4
        } else {
          streak = 0
          score += 6
        }
        if (idx === 0 || /[^a-z0-9]/i.test(t[idx - 1] ?? "")) score += 8
        ti = idx + 1
      }
      return score - Math.max(0, t.length - q.length) * 0.1
    }

    /** All sessions: v2 SQLite store first, legacy JSON storage as fallback. */
    function listSessions(): AnyObj[] {
      const dataHome = process.env.OPENCODE_DATA_HOME ?? process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share")
      const rows: AnyObj[] = []
      try {
        const dbPath = process.env.OPENCODE_DB ?? path.join(dataHome, "opencode", "opencode.db")
        const db = new Database(dbPath, { readonly: true })
        const found = db
          .query(
            "SELECT id, title, directory, time_updated AS updated, time_created AS created FROM session_v2 ORDER BY time_updated DESC LIMIT 500",
          )
          .all()
        rows.push(...(found as AnyObj[]))
        db.close()
      } catch {}
      if (rows.length > 0) {
        return rows.map((row) => ({
          id: String(row.id ?? ""),
          title: String(row.title ?? "(untitled)"),
          directory: String(row.directory ?? ""),
          time: { updated: Number(row.updated ?? 0), created: Number(row.created ?? 0) },
        }))
      }
      // Legacy fallback: JSON files under storage/session/<project>/ses_*.json.
      const root = path.join(dataHome, "opencode", "storage", "session")
      const out: AnyObj[] = []
      let projects: string[] = []
      try {
        projects = readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      } catch {
        return out
      }
      for (const project of projects) {
        let files: string[] = []
        try {
          files = readdirSync(path.join(root, project))
        } catch {
          continue
        }
        for (const file of files) {
          if (!file.startsWith("ses_") || !file.endsWith(".json")) continue
          try {
            const parsed = JSON.parse(readFileSync(path.join(root, project, file), "utf8")) as AnyObj
            if (parsed?.id) out.push(parsed)
          } catch {}
        }
      }
      return out
    }

    const messagingRegistration = await toolCtx.transform((editor: AnyObj) => {
      editor.add({
        name: "session_search",
        description:
          "Fuzzy-search OpenCode sessions by title, directory, or session ID. Returns id, title, directory, and last-updated time — use it to pick a target before messaging a session.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Fuzzy text matched against titles, directories, and session IDs" },
            limit: { type: "number", description: "Maximum results (default 8)" },
          },
          required: ["query"],
          additionalProperties: false,
        },
        options: { namespace: "opencode", codemode: true },
        execute: async (input: AnyObj) => {
          debug(debugOn, "tools:search called", String(input?.query ?? ""))
          try {
            const query = String(input?.query ?? "")
            const limit = Math.min(25, Math.max(1, Number(input?.limit) || 8))
            const sessions = listSessions()
            const ranked = sessions
              .map((s) => {
                const id = String(s?.id ?? "")
                const title = String(s?.title ?? "(untitled)")
                const directory = String(s?.directory ?? "")
                const score = Math.max(fuzzyScore(query, title), fuzzyScore(query, directory), id === query ? 1e6 : id.startsWith(query) ? 5e5 : fuzzyScore(query, id))
                return score < 0
                  ? null
                  : {
                      id,
                      title,
                      directory,
                      updated: (s?.time?.updated ?? s?.time?.created ?? null) as number | null,
                      score: Math.round(score * 10) / 10,
                    }
              })
              .filter((x): x is NonNullable<typeof x> => x !== null)
              .sort((a, b) => b.score - a.score || (b.updated ?? 0) - (a.updated ?? 0))
              .slice(0, limit)
              .map(({ score: _score, ...rest }) => rest)
            debug(debugOn, "tools:search", query, "hits", ranked.length, "of", sessions.length)
            return { content: JSON.stringify(ranked) }
          } catch (error) {
            debug(debugOn, "tools:search failed", error instanceof Error ? error.message : String(error))
            return { content: `session_search failed: ${error instanceof Error ? error.message : String(error)}` }
          }
        },
      })

      editor.add({
        name: "session_message",
        description:
          'Send text to another OpenCode session. kind "synthetic" adds a machine message to its history (no agent turn); kind "prompt" submits a real prompt and triggers agent work. Use delivery "steer" to interrupt an idle/running session immediately or "queue" to append. Use session_search to find the target ID.',
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "Target session ID (ses_...)" },
            text: { type: "string", description: "Message text to deliver" },
            kind: { type: "string", enum: ["synthetic", "prompt"], description: "Default: synthetic" },
            delivery: { type: "string", enum: ["steer", "queue"], description: "Delivery mode for prompt kind" },
            dryRun: { type: "boolean", description: "Validate the target and preview the send without delivering" },
          },
          required: ["sessionID", "text"],
          additionalProperties: false,
        },
        options: { namespace: "opencode", codemode: true },
        execute: async (input: AnyObj) => {
          try {
            const sessionID = String(input?.sessionID ?? "")
            const text = String(input?.text ?? "")
            const kind = input?.kind === "prompt" ? "prompt" : "synthetic"
            const delivery = input?.delivery === "queue" ? "queue" : input?.delivery === "steer" ? "steer" : undefined
            if (!sessionID || !text) return { content: "session_message requires sessionID and text" }
            let targetTitle = ""
            try {
              const target = await sessionCtx?.get?.({ sessionID })
              targetTitle = String(target?.title ?? "")
            } catch {
              return { content: `session_message: session ${sessionID} not found` }
            }
            if (input?.dryRun === true) {
              return { content: JSON.stringify({ dryRun: true, sessionID, title: targetTitle, kind, delivery: delivery ?? null, textLength: text.length }) }
            }
            const admitted =
              kind === "prompt"
                ? await sessionCtx?.prompt?.({ sessionID, text, delivery })
                : await sessionCtx?.synthetic?.({ sessionID, text, delivery })
            const messageID = String((admitted as AnyObj)?.id ?? (admitted as AnyObj)?.data?.id ?? "")
            debug(debugOn, "tools:message", kind, sessionID, "delivered", messageID)
            return {
              content: JSON.stringify({ sessionID, title: targetTitle, kind, delivery: delivery ?? null, messageID }),
            }
          } catch (error) {
            debug(debugOn, "tools:message failed", error)
            return { content: `session_message failed: ${error instanceof Error ? error.message : String(error)}` }
          }
        },
      })
    })

    return () => {
      clearTimeout(serverRefreshTimer)
      for (const registration of [transformRegistration, hookRegistration, messagingRegistration]) {
        try {
          registration?.dispose?.()
        } catch {}
      }
    }
  },
}

export default plugin
