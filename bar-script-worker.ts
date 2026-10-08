/**
 * Per-invocation worker for bar scripts (see ./bar-scripts.ts).
 *
 * The parent spawns one short-lived Web Worker per script invocation and
 * sends a single `{ file, context }` request. This worker then:
 *
 *   1. imports the script module (ESM or CJS, see `exportedFunction`),
 *   2. calls the exported function with a frozen `{ sessionID, directory,
 *      event }` context,
 *   3. validates the `{ title, percentage, color?, titleColor? }` / null
 *      result,
 *   4. posts one serializable response back to the parent.
 *
 * Every failure — missing export, thrown error, invalid result shape — is
 * reported as `{ ok: false, message }` instead of crashing the worker. The
 * parent terminates the worker on timeout, abort, or completion, so a
 * runaway script cannot keep executing. This isolates execution but is not
 * a security sandbox: scripts still run with OpenCode's process
 * permissions and must be treated as trusted code.
 */

import { pathToFileURL } from "node:url"
import type { BarScriptContext, WorkerRequest, WorkerResponse } from "./bar-scripts"

type BarFunction = (context: Readonly<BarScriptContext>) => unknown | Promise<unknown>

function exportedFunction(module: Record<string, unknown>): BarFunction | undefined {
  if (typeof module.getProgress === "function") return module.getProgress as BarFunction
  if (typeof module.default === "function") return module.default as BarFunction

  // CommonJS `module.exports = { getProgress }` appears under default.
  const commonJs = module.default
  if (commonJs && typeof commonJs === "object" && "getProgress" in commonJs) {
    const getProgress = (commonJs as Record<string, unknown>).getProgress
    if (typeof getProgress === "function") return getProgress as BarFunction
  }
  return undefined
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

/** A script-provided color is optional but must be an exact `#RRGGBB` hex string. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

async function handle(request: WorkerRequest): Promise<WorkerResponse> {
  try {
    // Each invocation gets a fresh worker runtime, so there is no stale
    // module cache: edits to a script take effect on the next
    // event-triggered refresh without restarting the TUI.
    const loaded = (await import(pathToFileURL(request.file).href)) as Record<string, unknown>
    const execute = exportedFunction(loaded)
    if (!execute) throw new TypeError("expected a default function or named getProgress(context) export")

    const context = Object.freeze({
      sessionID: request.context.sessionID,
      directory: request.context.directory,
      event: request.context.event,
    } satisfies BarScriptContext)

    const raw = await execute(context)
    if (raw == null) return { ok: true, bar: null }
    if (typeof raw !== "object") throw new TypeError("expected { title, percentage } or null")

    const result = raw as Record<string, unknown>
    if (typeof result.title !== "string" || !result.title.trim()) {
      throw new TypeError("bar title must be a non-empty string")
    }
    if (typeof result.percentage !== "number" || !Number.isFinite(result.percentage)) {
      throw new TypeError("bar percentage must be a finite number")
    }
    // `color` and `titleColor` are optional; null/undefined mean "no script
    // color". Anything else must be an exact "#RRGGBB" hex string.
    let color: string | undefined
    if (result.color !== undefined && result.color !== null) {
      if (typeof result.color !== "string" || !HEX_COLOR_PATTERN.test(result.color)) {
        throw new TypeError('optional bar color must be a "#RRGGBB" hex string')
      }
      color = result.color
    }
    let titleColor: string | undefined
    if (result.titleColor !== undefined && result.titleColor !== null) {
      if (typeof result.titleColor !== "string" || !HEX_COLOR_PATTERN.test(result.titleColor)) {
        throw new TypeError('optional bar titleColor must be a "#RRGGBB" hex string')
      }
      titleColor = result.titleColor
    }
    const bar: { title: string; percentage: number; color?: string; titleColor?: string } = {
      title: result.title.trim(),
      percentage: result.percentage,
    }
    if (color !== undefined) bar.color = color
    if (titleColor !== undefined) bar.titleColor = titleColor
    return { ok: true, bar }
  } catch (error) {
    return { ok: false, message: failureMessage(error) }
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void handle(event.data).then((response) => self.postMessage(response))
}
