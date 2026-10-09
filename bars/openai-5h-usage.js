/**
 * "OpenAI 5h" progress bar for the colored-tabs bar runner
 * (~/.config/opencode/plugins/colored-tabs/).
 *
 * Reports used quota of the ChatGPT/Codex 5-hour (300 min) rate-limit window.
 *
 * Primary path — direct usage endpoint: GET
 *
 *   https://chatgpt.com/backend-api/wham/usage
 *
 * authenticated with OpenCode's stored OpenAI OAuth token, read from
 *
 *   ${OPENCODE_DATA_HOME:-${XDG_DATA_HOME:-~/.local/share}}/opencode/auth.json
 *
 * (key `openai`, shape { type, refresh, access, expires, accountId }). The
 * request uses the exact headers of the official open-source Codex client
 * (openai/codex, codex-rs/backend-client): `Authorization: Bearer <access>`
 * and `chatgpt-account-id: <accountId>`. This endpoint is what the Codex CLI
 * itself polls; it is not part of the public API docs. Token material lives
 * only in the request headers — it is never logged, emitted, or persisted;
 * the cache keeps just the usage number.
 *
 * Fallback path — the documented OpenAI Codex App Server API
 *
 *   https://learn.chatgpt.com/docs/app-server
 *
 * spawn `codex app-server --listen stdio://`, speak stdio JSONL JSON-RPC
 * (`initialize` with clientInfo → `initialized` notification →
 * `account/rateLimits/read`), parse the JSONL replies. The App Server owns
 * authentication — no token files are read on this path. It is used when
 * auth.json is missing/expired/malformed or the direct endpoint fails
 * (401/403, network, malformed body).
 *
 * Runtime prerequisite: OpenCode is signed in to OpenAI (auth.json `openai`
 * entry), or the `codex` CLI is installed and logged in as fallback. When
 * neither yields data, the bar serves the last cached snapshot or hides
 * itself (returns null). It never fabricates usage.
 *
 * Caching: the bar runner re-runs scripts on every stream delta, so live
 * queries happen only on `sidebar.open` and `session.step.ended`; all other
 * events serve the cached snapshot. Only the non-secret usage number is
 * persisted at `$XDG_CACHE_HOME/opencode/openai-5h-usage.json` (mode 0600) —
 * never auth.
 */

import { spawn } from "node:child_process"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

/** The window this bar reports: the 5-hour rate-limit window, in minutes. */
const FIVE_HOUR_WINDOW_MINS = 300

/** Events worth a live query (the runner fires on every stream delta). */
const REFRESH_EVENTS = new Set(["sidebar.open", "session.step.ended"])

/**
 * Per-path timeout caps; REFRESH_BUDGET_MS bounds both paths combined so the
 * whole refresh always answers before the bar runner's 2s worker timeout.
 */
const DIRECT_TIMEOUT_MS = 1200
const APP_SERVER_TIMEOUT_MS = 1500
const REFRESH_BUDGET_MS = 1700

/** OpenCode's stored credentials (secrets — read-only, never persisted). */
const DATA_HOME = process.env.OPENCODE_DATA_HOME || process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share")
const AUTH_FILE = path.join(DATA_HOME, "opencode", "auth.json")

const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "opencode")
const CACHE_FILE = path.join(CACHE_DIR, "openai-5h-usage.json")

function clampPercent(value) {
  return Math.min(100, Math.max(0, value))
}

/** used < 80% green, 80–94.99% yellow, >= 95% red. */
function formatBar(usedPercent) {
  const pct = clampPercent(usedPercent)
  return {
    title: "OpenAI 5h",
    percentage: pct,
    color: pct < 80 ? "#22c55e" : pct < 95 ? "#eab308" : "#ef4444",
  }
}

/**
 * Extract the OpenAI OAuth entry OpenCode stores, returning only the two
 * fields the usage request needs. Null when absent, malformed, or expired
 * (then the caller falls back to the app-server path). Errors are swallowed:
 * no token material ever reaches a message, log, or file.
 */
async function readOpenAiAuth() {
  try {
    const parsed = JSON.parse(await readFile(AUTH_FILE, "utf8"))
    const entry = parsed && typeof parsed === "object" ? parsed.openai : null
    if (!entry || typeof entry !== "object") return null
    const access = typeof entry.access === "string" ? entry.access : ""
    const accountId = typeof entry.accountId === "string" ? entry.accountId : ""
    // `expires` is a ms epoch in OpenCode; tolerate a seconds epoch too.
    const expires =
      typeof entry.expires === "number" && Number.isFinite(entry.expires)
        ? entry.expires >= 1e12
          ? entry.expires
          : entry.expires * 1000
        : 0
    if (!access || !accountId || expires <= Date.now()) return null
    return { access, accountId }
  } catch {
    return null
  }
}

/**
 * Primary path: GET the usage endpoint with the official client's headers.
 * Resolves with the 5h used percent, or null on any failure (401/403,
 * network, timeout, malformed body) so the caller falls back. Failures are
 * silent by design: header/token values must never leak into error strings.
 */
function fetchUsageDirect(auth, timeoutMs) {
  return new Promise((resolve) => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, timeoutMs)
    fetch(WHAM_USAGE_URL, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${auth.access}`,
        "chatgpt-account-id": auth.accountId,
        "Accept": "application/json",
      },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          resolve(null) // 401/403 etc. -> fall back to the app server
          return
        }
        const payload = await response.json()
        resolve(parseRateLimits(payload))
      })
      .catch(() => resolve(null))
      .finally(() => clearTimeout(timer))
  })
}

/** Window length field, snake_case (wire) or camelCase (older shapes). */
function windowDurationOf(node) {
  for (const key of ["windowDurationMins", "window_duration_mins", "window_minutes", "windowMinutes"]) {
    const value = node[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

/**
 * Recursively collect objects that look like rate-limit windows (have a
 * numeric window length), remembering whether they sit inside a `codex`
 * bucket (`limit_id`/`name`/`model` "codex" or a `codex` key) and whether
 * they are the bucket's primary window.
 */
function collectWindows(node, ctx, out) {
  if (!node || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const item of node) collectWindows(item, ctx, out)
    return
  }
  const underCodex =
    ctx.underCodex || ctx.key === "codex" || node.limit_id === "codex" || node.name === "codex" || node.model === "codex"
  const duration = windowDurationOf(node)
  if (duration !== null) {
    out.push({ windowDurationMins: duration, underCodex, isPrimary: ctx.key === "primary", window: node })
    return
  }
  for (const [key, value] of Object.entries(node)) collectWindows(value, { underCodex, key }, out)
}

/** Read used percent from a window, tolerating common field namings. */
function usedPercentOf(window) {
  for (const key of ["used_percent", "usedPercent", "percent_used", "used_percentage", "utilization"]) {
    if (typeof window[key] === "number" && Number.isFinite(window[key])) return clampPercent(window[key])
  }
  if (
    typeof window.used === "number" &&
    typeof window.limit === "number" &&
    window.limit > 0
  ) {
    return clampPercent((window.used / window.limit) * 100)
  }
  return null
}

/**
 * Extract the 5h usage percent from either data source. Prefers the primary
 * window of a `codex` bucket (the official client prefers `limit_id` ==
 * "codex"); falls back to any 300-min window. Returns null when no 300-min
 * window or no usable usage number exists (malformed / missing data).
 */
function parseRateLimits(result) {
  if (!result || typeof result !== "object") return null
  const windows = []
  collectWindows(result, { underCodex: false, key: "" }, windows)
  const fiveHour = windows.filter((w) => w.windowDurationMins === FIVE_HOUR_WINDOW_MINS)
  const chosen =
    fiveHour.find((w) => w.underCodex && w.isPrimary) ||
    fiveHour.find((w) => w.underCodex) ||
    fiveHour[0]
  if (!chosen) return null
  return usedPercentOf(chosen.window)
}

/**
 * Fallback path: one `codex app-server` query (documented App Server API).
 * Resolves with the 5h used percent, or null on any failure (missing binary,
 * protocol error, malformed data, timeout). The child is killed on every
 * exit path; the timeout stays under the bar runner's 2s worker timeout.
 */
function queryAppServer(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let child
    let timer
    let buffer = ""

    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (child) {
        child.removeAllListeners()
        child.stdout?.removeAllListeners()
        try {
          child.kill("SIGKILL")
        } catch {}
        try {
          child.stdin?.destroy()
        } catch {}
      }
      resolve(value)
    }

    timer = setTimeout(() => finish(null), timeoutMs)

    try {
      child = spawn("codex", ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "ignore"], // stderr ignored: it can be chatty
      })
    } catch {
      finish(null)
      return
    }

    const send = (message) => {
      try {
        child.stdin.write(JSON.stringify(message) + "\n")
      } catch {
        finish(null)
      }
    }

    const handleLine = (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let parsed
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        return // tolerate non-JSONL noise between replies
      }
      if (!parsed || typeof parsed !== "object") return
      if (parsed.id === 0 && parsed.result) {
        send({ jsonrpc: "2.0", method: "initialized" })
        send({ jsonrpc: "2.0", id: 1, method: "account/rateLimits/read" })
        return
      }
      if (parsed.id === 1) {
        finish(parsed.error ? null : parseRateLimits(parsed.result))
      }
    }

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf("\n")) !== -1) {
        handleLine(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
      }
    })
    // Spawn failure (e.g. `codex` not installed) or early exit.
    child.on("error", () => finish(null))
    child.on("exit", () => {
      if (buffer.trim()) handleLine(buffer) // flush a trailing partial line
      finish(null)
    })

    send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        clientInfo: { name: "opencode-openai-usage-bar", title: "OpenCode usage bar", version: "1.0.0" },
      },
    })
  })
}

/** Read the non-secret cached snapshot; null when absent or malformed. */
async function readCache() {
  try {
    const parsed = JSON.parse(await readFile(CACHE_FILE, "utf8"))
    if (parsed && typeof parsed.usedPercent === "number" && Number.isFinite(parsed.usedPercent)) {
      return { usedPercent: clampPercent(parsed.usedPercent) }
    }
  } catch {}
  return null
}

/** Persist only the usage number (non-secret), with restrictive permissions. */
async function writeCache(usedPercent) {
  try {
    await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 })
    const payload = JSON.stringify({ usedPercent, updatedAt: new Date().toISOString() }) + "\n"
    await writeFile(CACHE_FILE, payload, { mode: 0o600 })
    await chmod(CACHE_FILE, 0o600) // in case the file already existed
  } catch {}
}

export default async function getProgress({ event } = {}) {
  // Deltas and other frequent events never query anything.
  if (!REFRESH_EVENTS.has(event)) {
    const cached = await readCache()
    return cached ? formatBar(cached.usedPercent) : null
  }

  // Both paths share one deadline so a refresh always answers in time.
  const startedAt = Date.now()
  const remaining = (cap) => Math.max(50, Math.min(cap, startedAt + REFRESH_BUDGET_MS - Date.now()))

  // Primary: direct usage endpoint with OpenCode's stored OpenAI token.
  let usedPercent = null
  const auth = await readOpenAiAuth()
  if (auth) {
    try {
      usedPercent = await fetchUsageDirect(auth, remaining(DIRECT_TIMEOUT_MS))
    } catch {
      usedPercent = null
    }
  }

  // Fallback: documented Codex App Server (spawns the `codex` CLI).
  if (usedPercent === null) {
    try {
      usedPercent = await queryAppServer(remaining(APP_SERVER_TIMEOUT_MS))
    } catch {
      usedPercent = null
    }
  }

  if (usedPercent !== null) {
    await writeCache(usedPercent)
    return formatBar(usedPercent)
  }

  // Both paths failed (or malformed): keep the last valid snapshot.
  const cached = await readCache()
  return cached ? formatBar(cached.usedPercent) : null
}
