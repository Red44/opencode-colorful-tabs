/**
 * Load and evaluate user-authored progress bar scripts.
 *
 * Scripts live directly in the global or project `.opencode/bars` directory.
 * Each `.js` module exports either a default function or a named
 * `getProgress(context)` function and returns `{ title, percentage }`
 * (plus an optional script-controlled `color` as a `"#RRGGBB"` hex string)
 * or `null` to hide its bar.
 *
 * Every invocation runs inside its own short-lived Web Worker
 * (see ./bar-script-worker.ts), which lets a stuck script be terminated on
 * timeout or abort instead of racing an untimed in-process call. Workers
 * isolate and bound execution; they are not a security sandbox — scripts
 * still run with OpenCode's process permissions, so project-local scripts
 * should be treated as trusted code.
 */

import { readdir, stat } from "node:fs/promises"
import path from "node:path"

export type BarScope = "global" | "project"

export interface ProgressBar {
  id: string
  title: string
  percentage: number
  /** Script-provided accent color as `"#RRGGBB"`; absent when not returned. */
  color?: string
  scope: BarScope
}

export interface BarScriptContext {
  sessionID: string
  directory?: string
  event: string
}

interface RunBarScriptsOptions {
  globalDirectory?: string
  projectDirectory?: string
  context: BarScriptContext
  timeoutMs?: number
  signal?: AbortSignal
  onError?: (file: string, error: unknown) => void
}

/** Message sent from the parent to a freshly spawned bar script worker. */
interface WorkerRequest {
  file: string
  context: BarScriptContext
}

/** Serializable reply from a bar script worker. */
type WorkerResponse =
  | { ok: true; bar: { title: string; percentage: number; color?: string } | null }
  | { ok: false; message: string }

interface ScriptFile {
  scope: BarScope
  path: string
  filename: string
  mtimeMs: number
}

const DEFAULT_TIMEOUT_MS = 2_000

// Global budget shared across overlapping runBarScripts calls so that many
// concurrent refreshes cannot each spawn an unbounded number of workers.
const MAX_ACTIVE_WORKERS = 4
let activeWorkers = 0
const workerWaiters: Array<() => void> = []

const timedOutScripts = new Map<string, number>()

class ScriptTimeoutError extends Error {
  constructor(file: string, timeoutMs: number) {
    super(`${path.basename(file)} timed out after ${timeoutMs}ms`)
  }
}

class ScriptAbortedError extends Error {
  constructor() {
    super("bar script run aborted")
  }
}

async function acquireWorkerSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new ScriptAbortedError()
  if (activeWorkers < MAX_ACTIVE_WORKERS) {
    activeWorkers++
    return
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort)
    const waiter = () => {
      cleanup()
      resolve()
    }
    const onAbort = () => {
      const index = workerWaiters.indexOf(waiter)
      if (index !== -1) workerWaiters.splice(index, 1)
      cleanup()
      reject(new ScriptAbortedError())
    }
    workerWaiters.push(waiter)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function releaseWorkerSlot(): void {
  // Hand the freed slot straight to the next queued caller instead of
  // decrementing first, so a racing acquire can never overshoot the budget.
  const next = workerWaiters.shift()
  if (next) {
    next()
    return
  }
  activeWorkers--
}

async function discover(directory: string | undefined, scope: BarScope): Promise<ScriptFile[]> {
  if (!directory) return []

  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }

  const files: ScriptFile[] = []
  for (const filename of names.filter((name) => name.endsWith(".js")).sort()) {
    const file = path.join(directory, filename)
    try {
      const info = await stat(file)
      if (info.isFile()) files.push({ scope, path: file, filename, mtimeMs: info.mtimeMs })
    } catch {
      // A script may have been removed between readdir and stat.
    }
  }
  return files
}

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function runWorkerScript(
  file: ScriptFile,
  context: Readonly<BarScriptContext>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProgressBar | null> {
  return new Promise<ProgressBar | null>((resolve, reject) => {
    const worker = new Worker(new URL("./bar-script-worker.ts", import.meta.url).href)
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const onAbort = () => settle(() => reject(new ScriptAbortedError()))

    // The single settle path: clears the timeout and abort listeners,
    // terminates the worker (timeout, abort, and completion alike), then
    // resolves or rejects exactly once.
    function settle(finish: () => void) {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      worker.terminate()
      finish()
    }

    worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
      const response = event.data
      if (response && response.ok) {
        const bar = response.bar
        if (!bar) {
          settle(() => resolve(null))
          return
        }
        settle(() =>
          resolve({
            id: `${file.scope}:${file.filename}`,
            title: bar.title,
            percentage: clampPercentage(bar.percentage),
            ...(bar.color !== undefined ? { color: bar.color } : {}),
            scope: file.scope,
          }),
        )
        return
      }
      settle(() => reject(new Error(response?.message ?? "bar script worker failed")))
    })

    worker.addEventListener("error", (event) => {
      const source = event as { error?: unknown; message?: string }
      const error =
        source.error instanceof Error ? source.error : new Error(source.message || "bar script worker crashed")
      settle(() => reject(error))
    })

    worker.addEventListener("exit", () => {
      if (!settled) settle(() => reject(new Error("bar script worker exited without a result")))
    })

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    timer = setTimeout(() => settle(() => reject(new ScriptTimeoutError(file.path, timeoutMs))), timeoutMs)

    try {
      worker.postMessage({ file: file.path, context } satisfies WorkerRequest)
    } catch (error) {
      settle(() => reject(error))
    }
  })
}

async function runOne(
  file: ScriptFile,
  context: Readonly<BarScriptContext>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProgressBar | null> {
  await acquireWorkerSlot(signal)
  try {
    return await runWorkerScript(file, context, timeoutMs, signal)
  } finally {
    releaseWorkerSlot()
  }
}

/** Run global scripts first, followed by project-local scripts. */
export async function runBarScripts(options: RunBarScriptsOptions): Promise<ProgressBar[]> {
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(50, options.timeoutMs)
      : DEFAULT_TIMEOUT_MS
  if (options.signal?.aborted) return []

  const [globalFiles, projectFiles] = await Promise.all([
    discover(options.globalDirectory, "global"),
    discover(options.projectDirectory, "project"),
  ])
  const files = [...globalFiles, ...projectFiles]
  const context = Object.freeze({ ...options.context })

  // Run independent scripts concurrently (bounded by the global worker
  // budget), then retain the discovery order in the result regardless of
  // completion order.
  const settled = await Promise.all(
    files.map(async (file): Promise<ProgressBar | null> => {
      // A script that timed out is only retried once its mtime changes.
      if (timedOutScripts.get(file.path) === file.mtimeMs) return null
      try {
        return await runOne(file, context, timeoutMs, options.signal)
      } catch (error) {
        if (error instanceof ScriptTimeoutError) timedOutScripts.set(file.path, file.mtimeMs)
        // Aborts are request cancellations, not script failures.
        if (!(error instanceof ScriptAbortedError)) {
          try {
            options.onError?.(file.path, error)
          } catch {}
        }
        return null
      }
    }),
  )
  return settled.filter((bar): bar is ProgressBar => bar !== null)
}
