/**
 * "Z.AI 5h" progress bar for the colored-tabs bar runner
 * (~/.config/opencode/plugins/colored-tabs/).
 *
 * Reports used quota of the Z.AI coding-plan 5-hour rate-limit window,
 * read from the reverse-engineered console endpoint (verified against
 * z.ai console bundles):
 *
 *   GET https://api.z.ai/api/monitor/usage/quota/limit
 *
 * authenticated with OpenCode's stored Z.AI coding-plan API key, read at
 * runtime from
 *
 *   ${OPENCODE_DATA_HOME:-${XDG_DATA_HOME:-~/.local/share}}/opencode/auth.json
 *
 * (key `zai-coding-plan`, field `key`). Headers mirror the console client:
 * `Authorization: Bearer <key>` and `Accept: application/json`. The key
 * lives only in the request headers — it is never logged, emitted, or
 * persisted; the cache keeps just the usage number.
 *
 * The endpoint answers the envelope { code, msg, success, data }; failures
 * can arrive with HTTP 200, so the bar requires `success === true` (or
 * `code === 200`) AND a `data.limits` array. Inside `limits`, the 5h window
 * is the entry with `unit === 3 && number === 5` (type TOKENS_LIMIT or
 * CREDIT_LIMIT); weekly (unit 6) and MCP (TIME_LIMIT) entries are ignored.
 * `percentage` is the used percent and may arrive as a string — it is
 * coerced with Number. No 5h entry means the bar hides itself (null);
 * usage is never fabricated.
 *
 * Caching: the bar runner re-runs scripts on every stream delta, so live
 * queries happen only on `sidebar.open` and `session.step.ended`; all
 * other events serve the cached snapshot with zero fetches. Only the
 * non-secret usage number and a timestamp are persisted at
 * `$XDG_CACHE_HOME/opencode/zai-5h-usage.json` (dir 0700, file 0600) —
 * never auth. 401/403, success:false, and network errors keep the last
 * valid snapshot or hide the bar.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit"

/** Events worth a live query (the runner fires on every stream delta). */
const REFRESH_EVENTS = new Set(["sidebar.open", "session.step.ended"])

/** Per-request timeout cap, well under the bar runner's 2s worker timeout. */
const FETCH_TIMEOUT_MS = 1200

/** OpenCode's stored credentials (secrets — read-only, never persisted). */
const DATA_HOME = process.env.OPENCODE_DATA_HOME || process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share")
const AUTH_FILE = path.join(DATA_HOME, "opencode", "auth.json")

const CACHE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "opencode")
const CACHE_FILE = path.join(CACHE_DIR, "zai-5h-usage.json")

function clampPercent(value) {
  return Math.min(100, Math.max(0, value))
}

/** used < 80% green, 80–94.99% yellow, >= 95% red. */
function formatBar(usedPercent) {
  const pct = clampPercent(usedPercent)
  return {
    title: "Z.AI 5h",
    percentage: pct,
    color: pct < 80 ? "#22c55e" : pct < 95 ? "#eab308" : "#ef4444",
  }
}

/**
 * Extract the Z.AI coding-plan API key OpenCode stores. Null when absent
 * or malformed. Errors are swallowed: the key never reaches a message,
 * log, or file.
 */
async function readZaiKey() {
  try {
    const parsed = JSON.parse(await readFile(AUTH_FILE, "utf8"))
    const entry = parsed && typeof parsed === "object" ? parsed["zai-coding-plan"] : null
    if (!entry || typeof entry !== "object") return null
    const key = typeof entry.key === "string" && entry.key ? entry.key : null
    return key
  } catch {
    return null
  }
}

/**
 * GET the quota endpoint with the console client's headers. Resolves with
 * the parsed envelope object, or null on any failure (401/403, network,
 * timeout, malformed body). Failures are silent by design: header/key
 * values must never leak into error strings.
 */
function fetchQuotaEnvelope(key, timeoutMs) {
  return new Promise((resolve) => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, timeoutMs)
    fetch(QUOTA_URL, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Accept": "application/json",
      },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          resolve(null) // 401/403 etc. -> keep/hide via the cache path
          return
        }
        const payload = await response.json()
        resolve(payload && typeof payload === "object" ? payload : null)
      })
      .catch(() => resolve(null))
      .finally(() => clearTimeout(timer))
  })
}

/** Number coercion for wire fields that may arrive as numbers or strings. */
function asFiniteNumber(value) {
  if (typeof value === "string" && value.trim() === "") return null
  const num = Number(value)
  return typeof num === "number" && Number.isFinite(num) ? num : null
}

/**
 * Extract the 5h used percent from the quota envelope. Requires a
 * success-shaped envelope (`success === true` or `code === 200`) with a
 * `data.limits` array, then picks the entry with `unit === 3` and
 * `number === 5` among the TOKENS_LIMIT/CREDIT_LIMIT windows — the 5-hour
 * bucket. Weekly (unit 6) and MCP (TIME_LIMIT) entries are ignored.
 * Returns null when the envelope is a failure, malformed, or carries no
 * 5h entry.
 */
function parseFiveHourPercent(envelope) {
  if (!envelope || typeof envelope !== "object") return null
  if (envelope.success !== true && envelope.code !== 200) return null
  const limits = envelope.data && typeof envelope.data === "object" ? envelope.data.limits : null
  if (!Array.isArray(limits)) return null
  for (const entry of limits) {
    if (!entry || typeof entry !== "object") continue
    const type = typeof entry.type === "string" ? entry.type.toUpperCase() : ""
    if (type !== "TOKENS_LIMIT" && type !== "CREDIT_LIMIT") continue // MCP/TIME_LIMIT etc.
    if (asFiniteNumber(entry.unit) !== 3) continue // 6 = weekly
    if (asFiniteNumber(entry.number) !== 5) continue
    const percent = asFiniteNumber(entry.percentage)
    if (percent === null) continue
    return clampPercent(percent)
  }
  return null
}

/** Read the non-secret cached snapshot; null when absent or malformed. */
async function readCache() {
  try {
    const parsed = JSON.parse(await readFile(CACHE_FILE, "utf8"))
    if (parsed && typeof parsed.percentage === "number" && Number.isFinite(parsed.percentage)) {
      return { percentage: clampPercent(parsed.percentage) }
    }
  } catch {}
  return null
}

/** Persist only the usage number (non-secret), with restrictive permissions. */
async function writeCache(percentage) {
  try {
    await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 })
    const payload = JSON.stringify({ percentage, updatedAt: new Date().toISOString() }) + "\n"
    await writeFile(CACHE_FILE, payload, { mode: 0o600 })
    await chmod(CACHE_FILE, 0o600) // in case the file already existed
  } catch {}
}

export default async function getProgress({ event } = {}) {
  // Deltas and other frequent events never query anything.
  if (!REFRESH_EVENTS.has(event)) {
    const cached = await readCache()
    return cached ? formatBar(cached.percentage) : null
  }

  let percentage = null
  const key = await readZaiKey()
  if (key) {
    try {
      percentage = parseFiveHourPercent(await fetchQuotaEnvelope(key, FETCH_TIMEOUT_MS))
    } catch {
      percentage = null
    }
  }

  if (percentage !== null) {
    await writeCache(percentage)
    return formatBar(percentage)
  }

  // Failure (missing key, 401/403, success:false, network, malformed,
  // no 5h entry): keep the last valid snapshot or hide the bar.
  const cached = await readCache()
  return cached ? formatBar(cached.percentage) : null
}
