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
import { appendFileSync } from "node:fs"

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

    return () => {
      clearTimeout(serverRefreshTimer)
      for (const registration of [transformRegistration, hookRegistration]) {
        try {
          registration?.dispose?.()
        } catch {}
      }
    }
  },
}

export default plugin
