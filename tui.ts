/**
 * colored-tabs — per-tab identity colors for the OpenCode TUI session tabs,
 * synced with the main prompt window.
 *
 * Mechanism (no official API restyles the built-in tab strip, so this plugin
 * rides the renderer frame event and overrides the themed border / text
 * renderables in the OpenTUI tree):
 *
 *   1. Every open tab gets a stable identity color from a 10-color palette
 *      derived from the theme accent (tab 1 = exact accent; the others are
 *      OKLCH hue rotations with deterministic per-session jitter and a
 *      lightness wave so neighbors are never similar). After 10, rotate.
 *      Assignments persist per session ID (durable storage).
 *   2. Tab rows get a colored left line (native themed box border), a
 *      colored right ┃ over-painted in the renderer's post-process pass
 *      (after all draw commands, so overflowing titles cannot push it off
 *      the row), and their title text recolored to the same value. When
 *      the tab strip is horizontal, the color becomes an underline instead
 *      (bottom border).
 *   3. The main prompt window mirrors the ACTIVE tab: its left+right side
 *      dash and the agent name in the prompt footer ("Orchestrator …")
 *      are recolored to the active tab's color — the prompt itself tells
 *      you which tab you are in without reading the tab strip.
 *   4. The supported sidebar.content slot shows Git branch, model, token
 *      usage, output rate, and session status for the current session.
 */
import { Plugin } from "@opencode/plugin/tui"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { createComponent, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { buildPalette, jitterFor, rgbToHex, hexToRgb, type Rgb } from "./colors"
import { SidebarOverview, type SidebarOverviewProps } from "./sidebar"
import { UtilitiesSettingsDialog, type DialogField } from "./settings-dialog"

type AnyObj = Record<string, any>
type SidebarField = "branch" | "tokens" | "rate" | "status"

/** Plugin-owned settings file: TUI storage.store is not durable in 2.0.23. */
const SETTINGS_FILE = path.join(
  homedir(),
  ".config/opencode/plugins/colored-tabs/settings.json",
)

interface PersistedState {
  enabled?: boolean
  sidebar?: Record<string, boolean>
  assign?: { next: number; bySession: Record<string, number> }
}

function loadPersistedState(): PersistedState {
  try {
    const raw = readFileSync(SETTINGS_FILE, "utf8")
    return JSON.parse(raw) as PersistedState
  } catch {
    return {}
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function persistStateSoon(getState: () => AnyObj): void {
  if (saveTimer) return // coalesce bursts
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
      writeFileSync(SETTINGS_FILE, JSON.stringify(getState(), null, 2))
    } catch {}
  }, 150)
}

const OPTIONS_DEFAULTS = {
  /** master switch for all coloring (persisted; toggled via /colored-tabs) */
  enabled: true,
  sidebar: { branch: true, tokens: true, rate: true, status: true },
  /** accent scale step used to anchor the palette */
  accentStep: "500",
  /** colored line on the left edge of vertical tab rows */
  dashLeft: true,
  /** colored line on the right edge of vertical tab rows */
  dashRight: true,
  /** recolor tab title text to the tab color */
  recolorTitle: true,
  /** mirror the active tab color onto the prompt window (side dashes + agent name) */
  promptSync: true,
  debug: false,
  throttleMs: 150,
}

const DEBUG_FILE = `/tmp/opencode/colored-tab-plugin/plugin-debug-${process.pid}.log`
function debug(enable: boolean, ...args: unknown[]): void {
  if (!enable) return
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

let RGBACls: any = null
async function loadRgbClass(): Promise<void> {
  if (RGBACls !== null) return
  try {
    const core: any = await import("@opentui/core")
    RGBACls = core.RGBA ?? false
  } catch {
    RGBACls = false
  }
}
const asColor = (hex: string): any =>
  RGBACls && typeof RGBACls.fromHex === "function" ? RGBACls.fromHex(hex) : hex

function toHex(value: unknown): string | null {
  if (value == null) return null
  const anyV = value as AnyObj
  try {
    if (typeof anyV.toHex === "function") return anyV.toHex()
    const s = String(value)
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s)
    if (m) {
      return rgbToHex({ r: parseFloat(m[1]) * 255, g: parseFloat(m[2]) * 255, b: parseFloat(m[3]) * 255 })
    }
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase()
  } catch {}
  return null
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "")

function collectTextNode(tn: any, depth = 0): string {
  if (!tn || depth > 8) return ""
  let out = ""
  const kids = tn.children
  if (Array.isArray(kids)) {
    for (const k of kids) {
      if (typeof k === "string") out += k
      else out += collectTextNode(k, depth + 1)
    }
  }
  return out
}

/** joined plain text of a text-like renderable */
function textOf(node: any): string {
  try {
    const ch = node?.chunks
    if (Array.isArray(ch) && ch.length) {
      const t = ch.map((c: any) => (typeof c === "string" ? c : String(c?.text ?? ""))).join("")
      if (t.trim()) return t
    }
  } catch {}
  try {
    const tn = node?.textNode ?? node?.rootTextNode
    if (tn) {
      const t = collectTextNode(tn)
      if (t.trim()) return t
    }
    if (Array.isArray(node?.children)) {
      const t = collectTextNode(node)
      if (t.trim()) return t
    }
  } catch {}
  try {
    if (typeof node?.gatherWithInheritedStyle === "function") {
      const t = node
        .gatherWithInheritedStyle()
        .map((c: any) => String(c?.text ?? ""))
        .join("")
      if (t.trim()) return t
    }
  } catch {}
  return ""
}

interface Candidate {
  row: any
  title: string
  y: number
  x: number
  horizontal: boolean
  /** filled in by matchTabs so bindings can be built from matches.values() */
  sessionID?: string
}

interface PromptParts {
  textarea: any
  mainBorder: any
  closingCap: any
  metadata: any[]
}

export default Plugin.define({
  id: "red.colored-tabs",
  async setup(context) {
    const options = { ...OPTIONS_DEFAULTS, ...(context.options ?? {}) }
    await loadRgbClass()

    // ---- master switch and utility display settings (persisted to a JSON
    // file next to the plugin: TUI plugin storage.store does not reliably
    // persist in 2.0.23, and multiple TUI instances echo stale state over
    // live-sync, so the file is the single source of truth) ----
    const persisted = loadPersistedState()
    const sidebarDefaults = {
      ...OPTIONS_DEFAULTS.sidebar,
      ...((options as AnyObj).sidebar ?? {}),
    }
    const [settings, setSettings] = createStore<{
      enabled: boolean
      sidebar: Record<SidebarField, boolean>
    }>({
      enabled: persisted.enabled !== false,
      sidebar: { ...sidebarDefaults, ...(persisted.sidebar ?? {}) },
    })
    const isEnabled = (): boolean => settings.enabled !== false
    const isSidebarFieldEnabled = (field: SidebarField): boolean => settings.sidebar?.[field] !== false

    // ---- session -> palette index assignment (rotates at 10) ----
    const [assign, setAssign] = createStore<{
      next: number
      bySession: Record<string, number>
    }>({
      next: persisted.assign?.next ?? 0,
      bySession: persisted.assign?.bySession ?? {},
    })
    const colorCache = new Map<string, Rgb>()
    let palette: { hex: string; anchor: ReturnType<typeof buildPalette>[number]["anchor"] }[] = []
    let paletteAccentHex: string | null = null

    function ensurePalette(): void {
      const step = String(options.accentStep)
      const accentValue = (context.theme as AnyObj)?.hue?.accent?.[step]
      const accentHex = toHex(accentValue) ?? "#c0c0c0"
      if (accentHex !== paletteAccentHex || palette.length === 0) {
        paletteAccentHex = accentHex
        palette = buildPalette(hexToRgb(accentHex))
        colorCache.clear()
      }
    }

    function colorFor(sessionID: string): Rgb {
      let c = colorCache.get(sessionID)
      if (!c) {
        ensurePalette()
        const idx = assign.bySession[sessionID]
        const entry = palette[idx ?? 0]
        c = idx === 0 ? hexToRgb(entry.hex) : jitterFor(entry.hex, entry.anchor, sessionID)
        colorCache.set(sessionID, c)
      }
      return c
    }

    function assignSession(sessionID: string): void {
      if (assign.bySession[sessionID] !== undefined) return
      ensurePalette()
      const idx = assign.next % palette.length
      setAssign("bySession", sessionID, assign.next % 10)
      setAssign("next", (assign.next + 1) % 1_000_000)
      if (assign.bySession[sessionID] === undefined) assign.bySession[sessionID] = idx
      persistStateSoon(() => ({
        enabled: settings.enabled,
        sidebar: { ...settings.sidebar },
        assign: { next: assign.next, bySession: { ...assign.bySession } },
      }))
    }

    // ---- utility-sidebar data ----
    const vcsSyncRequested = new Set<string>()
    const messageSyncRequested = new Set<string>()
    /**
     * Per-turn tok/s tracker. Matches OpenCode's own footer math: a turn
     * aggregates all assistant steps after the latest input; each step only
     * contributes its streamed time (created → streamed), so tool execution
     * time between steps is excluded. During streaming, the rate is a live
     * character-based estimate that freezes while tools run.
     */
    interface ActiveStep {
      sessionID: string
      startedAt: number
      streamedAt?: number
      textChars: number
      reasoningChars: number
      lastEstimateAt: number
    }
    interface TurnRate {
      value: number
      exact: boolean
    }
    interface TurnAccumulator {
      output: number
      durationMs: number
    }
    const activeSteps = new Map<string, ActiveStep>() // assistantMessageID -> step
    const turnAccumulators = new Map<string, TurnAccumulator>() // sessionID -> aggregate
    const turnRates = new Map<string, TurnRate>() // sessionID -> displayed rate
    const [rateRevision, setRateRevision] = createSignal(0)

    const stopRateEvents = [
      context.data.on("session.step.started", (event) => {
        const data = event.data as AnyObj
        const assistantMessageID = String(data.assistantMessageID ?? "")
        if (!assistantMessageID) return
        activeSteps.set(assistantMessageID, {
          sessionID: String(data.sessionID),
          startedAt: Number(data.started ?? event.created),
          textChars: 0,
          reasoningChars: 0,
          lastEstimateAt: 0,
        })
        setRateRevision((revision) => revision + 1)
      }),
      context.data.on("session.step.streamed", (event) => {
        const step = activeSteps.get(String(event.data.assistantMessageID ?? ""))
        if (step && step.streamedAt === undefined) step.streamedAt = Number(event.created)
      }),
      context.data.on("session.idle", (event) => {
        // Turn boundary: the next turn starts its own aggregate. The last
        // rate stays displayed until a new response begins.
        turnAccumulators.delete(String(event.data.sessionID ?? ""))
      }),
    ]

    const updateLiveEstimate = (event: AnyObj, isReasoning: boolean): void => {
      const data = event.data as AnyObj
      const step = activeSteps.get(String(data.assistantMessageID ?? ""))
      if (!step || step.sessionID !== String(data.sessionID)) return
      if (step.streamedAt === undefined) return
      const chars = String(data.delta ?? "").length
      if (chars <= 0) return
      if (isReasoning) step.reasoningChars += chars
      else step.textChars += chars

      const now = Date.now()
      if (now - step.lastEstimateAt < 150) return // bound redraws, keep it live
      step.lastEstimateAt = now
      const elapsedSeconds = (now - step.streamedAt) / 1_000
      if (elapsedSeconds <= 0.2) return
      const tokens = (step.textChars + step.reasoningChars) / 4
      if (tokens < 2) return
      turnRates.set(step.sessionID, { value: tokens / elapsedSeconds, exact: false })
      setRateRevision((revision) => revision + 1)
    }

    stopRateEvents.push(
      context.data.on("session.text.delta", (event) => updateLiveEstimate(event, false)),
      context.data.on("session.reasoning.delta", (event) => updateLiveEstimate(event, true)),
      context.data.on("session.step.ended", (event) => {
        const data = event.data as AnyObj
        const assistantMessageID = String(data.assistantMessageID ?? "")
        const step = activeSteps.get(assistantMessageID)
        if (!step || step.sessionID !== String(data.sessionID)) return
        activeSteps.delete(assistantMessageID)
        if (step.streamedAt === undefined) return // no visible streaming this step

        const streamedMs = Math.max(0, Number(event.created) - step.streamedAt)
        const tokens = data.tokens as AnyObj | undefined
        const output = Number(tokens?.output ?? 0) + Number(tokens?.reasoning ?? 0)
        const accumulator = turnAccumulators.get(step.sessionID) ?? { output: 0, durationMs: 0 }
        accumulator.output += output
        accumulator.durationMs += streamedMs
        turnAccumulators.set(step.sessionID, accumulator)

        // Ignore micro-steps (<300 ms streamed): their timing is noise.
        if (accumulator.durationMs < 300 || accumulator.output <= 0) return
        const rate = accumulator.output / (accumulator.durationMs / 1_000)
        if (Number.isFinite(rate) && rate > 0 && rate <= 400) {
          turnRates.set(step.sessionID, { value: rate, exact: true })
        }
        setRateRevision((revision) => revision + 1)
      }),
    )

    function tokenTotal(usage: AnyObj | undefined): number | undefined {
      if (!usage) return undefined
      const cache = usage.cache ?? {}
      const values = [usage.input, usage.output, usage.reasoning, cache.read, cache.write]
      if (!values.some((value) => typeof value === "number" && Number.isFinite(value))) return undefined
      return values.reduce((sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0)
    }

    function readOutputRate(sessionID: string): TurnRate | undefined {
      rateRevision() // make the sidebar accessor reactive to streaming deltas/events
      return turnRates.get(sessionID)
    }

    function locationForSession(sessionID: string): AnyObj | undefined {
      return context.data.session.get(sessionID)?.location ?? context.location ?? undefined
    }

    // ---- one tree walk: tab rows + the marked composer textarea ----
    interface WalkResult {
      candidates: Candidate[]
      prompt: PromptParts | null
      renderables: any[]
    }

    function childrenOf(node: any): any[] {
      try {
        const children = node?.getChildren?.()
        return Array.isArray(children) ? children : []
      } catch {
        return []
      }
    }

    function hasBorderSide(box: any, side: "left" | "right" | "bottom"): boolean {
      try {
        if (box?.borderSides?.[side] === true) return true
        return Array.isArray(box?.border) && box.border.includes(side)
      } catch {
        return false
      }
    }

    /** Reject detached, destroyed, or hidden renderables and ancestors. */
    function isInVisibleTree(node: any): boolean {
      const root = context.renderer.root
      let current = node
      let depth = 0
      while (current && depth++ < 48) {
        try {
          if (current.isDestroyed === true || current.destroyed === true || current.visible === false) return false
        } catch {
          return false
        }
        if (current === root) return true
        current = current.parent
      }
      return false
    }

    /**
     * The host tags its prompt textarea with an own getClipboardText callback.
     * Walk from that marker through its exact parent chain instead of guessing
     * from screen position or an arbitrary wide left-bordered box.
     */
    function findPromptParts(renderables: any[]): PromptParts | null {
      for (const textarea of renderables) {
        try {
          if (
            !Object.prototype.hasOwnProperty.call(textarea, "getClipboardText") ||
            typeof textarea.getClipboardText !== "function" ||
            !isInVisibleTree(textarea)
          ) continue

          const content = textarea.parent
          const mainBorder = content?.parent
          const anchor = mainBorder?.parent
          if (!content || !mainBorder || !anchor) continue
          if (!childrenOf(content).includes(textarea)) continue
          if (!childrenOf(anchor).includes(mainBorder)) continue
          if (!hasBorderSide(mainBorder, "left")) continue
          const chars = mainBorder.customBorderChars
          if (chars && chars.vertical !== "┃") continue
          if (chars && chars.bottomLeft !== "╹") continue

          const cap = childrenOf(anchor).find((sibling) => {
            if (sibling === mainBorder || !hasBorderSide(sibling, "left") || sibling.height !== 1) return false
            return childrenOf(sibling).some((child) => hasBorderSide(child, "bottom"))
          })
          if (!cap) continue
          const metadata = childrenOf(content).filter((child) => child !== textarea)
          if (metadata.length === 0 || !childrenOf(anchor).includes(cap)) continue

          return { textarea, mainBorder, closingCap: cap, metadata }
        } catch {}
      }
      return null
    }

    function walkTree(): WalkResult {
      const candidates: Candidate[] = []
      const renderables: any[] = []
      const seen = new Set<any>()

      const visit = (r: any, depth: number): void => {
        if (!r || seen.has(r) || depth > 45) return
        seen.add(r)
        renderables.push(r)
        try {
          const x = r.screenX
          const y = r.screenY
          const w = r.width
          const h = r.height
          // any tab-shaped container: left strip rows and top strip cells
          if (
            typeof r.getChildren === "function" &&
            typeof x === "number" && typeof y === "number" &&
            typeof w === "number" && w >= 8 && w <= 60 &&
            typeof h === "number" && h >= 1 && h <= 4
          ) {
            const title = findTitle(r, 0)
            if (title && title.length >= 3) candidates.push({ row: r, title, y, x, horizontal: false })
          }
        } catch {}
        let kids: any[] = []
        try {
          if (typeof r?.getChildren === "function") kids = r.getChildren()
        } catch {}
        for (const k of kids) visit(k, depth + 1)
      }
      visit(context.renderer.root, 0)

      // orientation: >=2 title-matching candidates on one row => horizontal
      // strip (underline); otherwise left-edge containers with h>=2 are
      // vertical strip rows (side lines)
      const tabTitles = context.ui.tabs.list().map((t) => normalize(String(t.title ?? "")))
      const plausiblyTab = (c: Candidate): boolean => {
        const nc = normalize(c.title)
        if (!nc) return false
        return tabTitles.some((nt) => nt && (nt.startsWith(nc.slice(0, 10)) || nc.startsWith(nt.slice(0, 10))))
      }
      const plausible = candidates.filter(plausiblyTab)
      // drop candidates nested inside other candidates (row vs its title box)
      const isDescendant = (node: any, ancestor: any): boolean => {
        let p = node?.parent
        let guard = 0
        while (p && guard++ < 8) {
          if (p === ancestor) return true
          p = p.parent
        }
        return false
      }
      const outer = plausible.filter((c) => !plausible.some((o) => o !== c && isDescendant(c.row, o.row)))
      // horizontal strip cells are siblings side by side: same y AND same parent
      const byKey = new Map<string, Candidate[]>()
      for (const c of outer) {
        const key = `${c.y}|${c.row?.parent?.num ?? "?"}`
        const arr = byKey.get(key) ?? []
        arr.push(c)
        byKey.set(key, arr)
      }
      const horizontalRows = new Set<Candidate>()
      for (const group of byKey.values()) {
        if (group.length >= 2) for (const c of group) horizontalRows.add(c)
      }
      const final = outer.filter((c) => horizontalRows.has(c) || (c.x <= 1 && (c.row?.height ?? 0) >= 2))
      debug(options.debug, "cands", final.map((c) => ({ y: c.y, x: c.x, h: c.row?.height, w: c.row?.width, hz: c.horizontal, t: c.title.slice(0, 18) })))
      for (const c of final) c.horizontal = horizontalRows.has(c)
      candidates.length = 0
      candidates.push(...final)
      candidates.sort((a, b) => (a.y - b.y) || (a.x - b.x))
      const prompt = findPromptParts(renderables)
      const markerNodes = renderables.filter((r) =>
        Object.prototype.hasOwnProperty.call(r, "getClipboardText") && typeof r.getClipboardText === "function",
      )
      const describePromptNode = (node: any) => ({
        x: node?.screenX, y: node?.screenY, w: node?.width, h: node?.height,
        parent: node?.parent && [node.parent.screenX, node.parent.screenY, node.parent.width, node.parent.height],
        border: node?.parent?.parent && [node.parent.parent.screenX, node.parent.parent.screenY, node.parent.parent.width, node.parent.parent.height],
        anchor: node?.parent?.parent?.parent && [node.parent.parent.parent.screenX, node.parent.parent.parent.screenY, node.parent.parent.parent.width, node.parent.parent.parent.height],
      })
      const focused = (context.renderer as AnyObj).currentFocusedRenderable
      debug(options.debug, "prompt markers", markerNodes.map(describePromptNode), "focused", focused && describePromptNode(focused))
      debug(options.debug, "prompt parts", prompt && {
        textarea: [prompt.textarea.screenX, prompt.textarea.screenY, prompt.textarea.width, prompt.textarea.height],
        mainBorder: [prompt.mainBorder.screenX, prompt.mainBorder.screenY, prompt.mainBorder.width, prompt.mainBorder.height],
        cap: [prompt.closingCap.screenX, prompt.closingCap.screenY, prompt.closingCap.width, prompt.closingCap.height],
        metadata: prompt.metadata.map((node) => textOf(node).slice(0, 60)),
      })
      return { candidates, prompt, renderables }
    }

    /** longest text inside a row (the tab title) */
    function findTitle(row: any, depth: number): string {
      if (!row || depth > 8) return ""
      let best = ""
      try {
        const t = textOf(row).trim()
        if (t.length >= 3) best = t
      } catch {}
      let kids: any[] = []
      try {
        if (typeof row?.getChildren === "function") kids = row.getChildren()
      } catch {}
      for (const k of kids) {
        const sub = findTitle(k, depth + 1)
        if (sub.length > best.length) best = sub
      }
      return best
    }

    /** text nodes inside a row whose text matches the tab title */
    function findTitleNodes(row: any, titleNorm: string): any[] {
      const out: any[] = []
      const visit = (r: any, depth: number): void => {
        if (!r || depth > 8) return
        const t = textOf(r).trim()
        if (t.length >= 3) {
          const nt = normalize(t)
          if (nt && (nt.startsWith(titleNorm.slice(0, 10)) || titleNorm.startsWith(nt.slice(0, 10)))) {
            out.push(r.textNode ?? r.rootTextNode ?? r)
          }
        }
        let kids: any[] = []
        try {
          if (typeof r?.getChildren === "function") kids = r.getChildren()
        } catch {}
        for (const k of kids) visit(k, depth + 1)
      }
      visit(row, 0)
      return out
    }

    function matchTabs(candidates: Candidate[], tabs: readonly AnyObj[]): Map<AnyObj, Candidate> {
      const map = new Map<AnyObj, Candidate>()
      const normTabs = tabs.map((t) => normalize(String(t.title ?? "")))
      const usable = candidates.filter((c) => {
        const nc = normalize(c.title)
        if (!nc) return false
        return normTabs.some((nt) => nt && (nt.startsWith(nc.slice(0, 10)) || nc.startsWith(nt.slice(0, 10))))
      })
      if (usable.length === tabs.length) {
        tabs.forEach((t, i) => {
          usable[i].sessionID = String(t.sessionID)
          map.set(t, usable[i])
        })
        return map
      }
      for (const c of usable) {
        const nc = normalize(c.title)
        const hit = tabs.find((t, i) => {
          if (map.has(t)) return false
          const nt = normTabs[i]
          return nt && (nt.startsWith(nc.slice(0, 10)) || nc.startsWith(nt.slice(0, 10)))
        })
        if (hit) {
          c.sessionID = String(hit.sessionID)
          map.set(hit, c)
        }
      }
      return map
    }

    // ---- application ----
    const sideBorder = (horizontal: boolean): string[] => {
      if (horizontal) return ["bottom"]
      // Vertical side bars are both painted in the renderer post-process pass.
      // Avoid mutating tab boxes so disabling the plugin cannot strand a bar.
      return []
    }

    /**
     * Over-render the right ┃ in the post-process pass: runs after
     * root.render() and all descendant draw commands, before native output,
     * so title text can no longer overwrite the bar. drawText requires an
     * RGBA color, so convert via RGBA.fromHex() directly.
     */
    function paintCell(buffer: any, x: number, y: number, hex: string, glyph = "┃"): void {
      const bw = typeof buffer?.width === "number" ? buffer.width : Number.POSITIVE_INFINITY
      const bh = typeof buffer?.height === "number" ? buffer.height : Number.POSITIVE_INFINITY
      if (x < 0 || y < 0 || x >= bw || y >= bh) return
      if (!RGBACls || typeof RGBACls.fromHex !== "function") return
      try {
        buffer.drawText(glyph, x, y, RGBACls.fromHex(hex))
      } catch {}
    }

    // ---- vertical tab edge bindings: row -> owning session ----
    const rowBindings = new Map<object, { sessionID: string }>()
    const promptEdgeBindings = new Map<object, string>()
    const promptCapBindings = new Map<object, string>()
    const promptLabelBindings = new Map<object, string>()
    const rendererAny = context.renderer as AnyObj
    const postProcessAvailable =
      typeof rendererAny.addPostProcessFn === "function" &&
      typeof rendererAny.removePostProcessFn === "function"

    const isBindable = (row: any): boolean => {
      return isInVisibleTree(row)
    }

    /** sync bindings with this frame's matches; true when something changed */
    function updateBindings(matches: Map<AnyObj, Candidate>): boolean {
      if ((!options.dashLeft && !options.dashRight) || !postProcessAvailable) return false
      let changed = false
      const seen = new Set<object>()
      for (const cand of [...matches.values()]) {
        if (cand.horizontal || !cand.sessionID) continue
        if (!isBindable(cand.row)) continue
        const row = cand.row as object
        seen.add(row)
        const prev = rowBindings.get(row)
        if (!prev) {
          rowBindings.set(row, { sessionID: cand.sessionID })
          changed = true
        } else if (prev.sessionID !== cand.sessionID) {
          prev.sessionID = cand.sessionID
          changed = true
        }
      }
      // drop stale rows: no longer matched, destroyed, hidden or detached
      for (const row of [...rowBindings.keys()]) {
        let dead = !seen.has(row)
        if (!dead) dead = !isBindable(row)
        if (dead) {
          rowBindings.delete(row)
          changed = true
        }
      }
      return changed
    }

    /** paint bound tab rows' enabled side bars from current post-layout geometry */
    function paintTabEdges(buffer: any): void {
      try {
        for (const [row, binding] of rowBindings) {
          try {
            const r = row as AnyObj
            if (!isBindable(r)) continue
            const y0 = r.screenY
            const h = r.height
            if (typeof y0 !== "number" || typeof h !== "number" || h < 1) continue
            const x0 = typeof r.screenX === "number" ? r.screenX : 0
            const w = typeof r.width === "number" ? r.width : 42
            const hex = rgbToHex(colorFor(binding.sessionID))
            const right = x0 + w - 1
            const rows = Math.min(h, 3)
            for (let i = 0; i < rows; i++) {
              if (options.dashLeft) paintCell(buffer, x0, y0 + i, hex)
              if (options.dashRight && right > x0) paintCell(buffer, right, y0 + i, hex)
            }
          } catch {}
        }
      } catch {}
    }

    /** paint full composer sides and half-height colored bottom-corner joins */
    function paintPromptEdges(buffer: any): void {
      for (const [box, hex] of promptEdgeBindings) {
        try {
          const b = box as AnyObj
          if (!isBindable(b)) continue
          const x0 = b.screenX
          const y0 = b.screenY
          const w = b.width
          const h = b.height
          if (
            typeof x0 !== "number" || typeof y0 !== "number" ||
            typeof w !== "number" || typeof h !== "number" || w < 2 || h < 1
          ) continue
          const right = x0 + w - 1
          for (let row = 0; row < h; row++) {
            paintCell(buffer, x0, y0 + row, hex)
            paintCell(buffer, right, y0 + row, hex)
          }
        } catch {}
      }
      for (const [cap, hex] of promptCapBindings) {
        try {
          const b = cap as AnyObj
          if (!isBindable(b)) continue
          const x0 = b.screenX
          const y = b.screenY
          const w = b.width
          if (typeof x0 !== "number" || typeof y !== "number" || typeof w !== "number" || w < 2) continue
          // ╹ extends the side bar halfway into the bottom-cap row without
          // carrying a full extra row below the composer.
          paintCell(buffer, x0, y, hex, "╹")
          paintCell(buffer, x0 + w - 1, y, hex, "╹")
        } catch {}
      }
    }

    /** Repaint the exact agent label after the host's themed text render. */
    function paintPromptLabels(buffer: any): void {
      if (!RGBACls || typeof RGBACls.fromHex !== "function") return
      for (const [node, hex] of promptLabelBindings) {
        try {
          if (!isBindable(node)) continue
          const text = textOf(node).trim()
          const x = node.screenX
          const y = node.screenY
          if (!text || typeof x !== "number" || typeof y !== "number") continue
          buffer.drawText(text, x, y, RGBACls.fromHex(hex))
        } catch {}
      }
    }

    const postProcessFn = (buffer?: any): void => {
      if (!isEnabled()) return
      const buf =
        buffer ??
        rendererAny.buffer ??
        rendererAny.rootBuffer
      if (buf) {
        paintTabEdges(buf)
        paintPromptEdges(buf)
        paintPromptLabels(buf)
      }
    }

    // ---- pre-mutation snapshots: exact restore when the toggle turns off ----
    interface BoxSnapshot {
      border: unknown
      borderStyle: unknown
      borderColor: unknown
      focusedBorderColor: unknown
    }
    const boxSnapshots = new Map<object, BoxSnapshot>()
    const fgSnapshots = new Map<object, unknown>()

    /** capture a box's current styling once, before the plugin first mutates it */
    function snapshotBox(box: any): void {
      try {
        if (boxSnapshots.has(box)) return
        boxSnapshots.set(box, {
          border: box.border,
          borderStyle: box.borderStyle,
          borderColor: box.borderColor,
          focusedBorderColor: box.focusedBorderColor,
        })
      } catch {}
    }

    /** capture a text node/chunk's current fg once, before the first recolor */
    function snapshotFg(node: any): void {
      try {
        if (fgSnapshots.has(node)) return
        fgSnapshots.set(node, node.fg)
      } catch {}
    }

    /** put every touched box and text node/chunk back to its pre-plugin state */
    function restoreOriginalState(): void {
      debug(options.debug, "restore snapshots", boxSnapshots.size, fgSnapshots.size)
      // per-item guards: one destroyed/detached renderable must not prevent
      // the restore of every other box/text node
      for (const [box, snap] of boxSnapshots) {
        try {
          box.border = snap.border
          box.borderStyle = snap.borderStyle
          box.borderColor = snap.borderColor
          box.focusedBorderColor = snap.focusedBorderColor
        } catch {}
      }
      for (const [node, fg] of fgSnapshots) {
        try {
          node.fg = fg
        } catch {}
      }
      boxSnapshots.clear()
      fgSnapshots.clear()
      // right-edge bars must not repaint on the next post-process pass
      rowBindings.clear()
      promptEdgeBindings.clear()
      promptCapBindings.clear()
      promptLabelBindings.clear()
      debug(options.debug, "restore complete")
      process.nextTick(() => {
        try {
          context.renderer.requestRender()
        } catch {}
      })
    }

    function setBoxColor(box: any, hex: string, sides: string[]): boolean {
      let changed = false
      try {
        snapshotBox(box)
        if (Array.isArray(box.border) && box.border.join(",") === sides.join(",")) {
          // sides already correct
        } else {
          box.border = sides
          changed = true
        }
        if (box.borderStyle !== "heavy") {
          box.borderStyle = "heavy"
          changed = true
        }
        if (toHex(box.borderColor) !== hex) {
          box.borderColor = asColor(hex)
          changed = true
        }
        const fbc = toHex(box.focusedBorderColor)
        if (fbc !== null && fbc !== hex) {
          box.focusedBorderColor = asColor(hex)
          changed = true
        }
      } catch {}
      return changed
    }

    function applyRow(row: any, tab: AnyObj, horizontal: boolean, rgb: Rgb): boolean {
      let changed = false
      const hex = rgbToHex(rgb)

      const sides = sideBorder(horizontal)
      if (sides.length > 0 && row) {
        if (setBoxColor(row, hex, sides)) changed = true
      }

      if (options.recolorTitle) {
        try {
          const titleNorm = normalize(String(tab.title ?? ""))
          if (titleNorm) {
            for (const tn of findTitleNodes(row, titleNorm)) {
              if (toHex(tn.fg) !== hex) {
                snapshotFg(tn)
                tn.fg = asColor(hex)
                changed = true
              }
              if (Array.isArray(tn.chunks)) {
                for (const c of tn.chunks) {
                  if (c && typeof c === "object" && toHex(c.fg) !== hex) {
                    snapshotFg(c)
                    c.fg = asColor(hex)
                  }
                }
              }
            }
          }
        } catch {}
      }
      return changed
    }

    /** yield styled child text nodes with their text (for chunk-level recolor) */
    function styledChildren(node: any): { node: any; text: string }[] {
      const out: { node: any; text: string }[] = []
      try {
        const tn = node?.textNode ?? node?.rootTextNode ?? node
        const kids = tn?.children
        if (Array.isArray(kids)) {
          for (const k of kids) {
            if (k && typeof k === "object") {
              const t = collectTextNode(k).trim()
              if (t) out.push({ node: k, text: t })
            }
          }
        }
      } catch {}
      return out
    }

    function findExactTextNodes(root: any, names: Set<string>): any[] {
      const found: any[] = []
      const seen = new Set<any>()
      const visit = (node: any, depth: number): void => {
        if (!node || seen.has(node) || depth > 20) return
        seen.add(node)
        if (names.has(normalize(textOf(node).trim()))) found.push(node)
        for (const child of childrenOf(node)) visit(child, depth + 1)
      }
      visit(root, 0)
      return found
    }

    /** prompt composer mirrors the active tab: both edges + agent name */
    function syncPrompt(prompt: PromptParts | null, renderables: any[], activeHex: string | null): boolean {
      let changed = false
      if (!options.promptSync || !activeHex || !prompt) {
        if (promptEdgeBindings.size > 0 || promptCapBindings.size > 0 || promptLabelBindings.size > 0) {
          promptEdgeBindings.clear()
          promptCapBindings.clear()
          promptLabelBindings.clear()
          changed = true
        }
        return changed
      }

      // The closing cap is the row immediately below the composer. Painting it
      // with a vertical glyph extends both side bars one row too far, so keep
      // its native bottom-corner rendering untouched.
      const boxes = [prompt.mainBorder].filter(isBindable)
      const live = new Set<object>()
      for (const box of boxes) {
        live.add(box)
        const previous = promptEdgeBindings.get(box)
        if (previous !== activeHex) {
          promptEdgeBindings.set(box, activeHex)
          changed = true
        }
      }
      for (const box of [...promptEdgeBindings.keys()]) {
        if (!live.has(box)) {
          promptEdgeBindings.delete(box)
          changed = true
        }
      }
      if (isBindable(prompt.closingCap)) {
        const previous = promptCapBindings.get(prompt.closingCap)
        if (previous !== activeHex) {
          promptCapBindings.set(prompt.closingCap, activeHex)
          changed = true
        }
      }
      for (const cap of [...promptCapBindings.keys()]) {
        if (cap !== prompt.closingCap || !isBindable(cap)) {
          promptCapBindings.delete(cap)
          changed = true
        }
      }

      // The agent label is in the composer's metadata sibling, not the
      // prompt.footer status slot. Post-process the exact label after the
      // host renders it, so reactive host styling cannot overwrite the color.
      try {
        const location = context.location ?? undefined
        const agents: any[] = (context as AnyObj).data?.location?.agent?.list(location) ?? []
        const names = new Set(agents.map((a) => normalize(String(a?.name ?? ""))).filter(Boolean))
        names.add("orchestrator")
        const labels = prompt.metadata.flatMap((node) => findExactTextNodes(node, names)).filter(isBindable)
        const activeNames = new Set(labels.map((node) => normalize(textOf(node).trim())).filter(Boolean))
        const sidebarLabels = renderables.filter((node) => {
          const label = normalize(textOf(node).trim())
          return (
            activeNames.has(label) &&
            typeof node?.screenX === "number" &&
            node.screenX >= (context.renderer.width ?? 0) * 0.7 &&
            isBindable(node)
          )
        })
        labels.push(...sidebarLabels)
        const liveLabels = new Set<object>()
        for (const label of labels) {
          const node = label as object
          liveLabels.add(node)
          if (promptLabelBindings.get(node) !== activeHex) {
            promptLabelBindings.set(node, activeHex)
            changed = true
          }
        }
        for (const label of [...promptLabelBindings.keys()]) {
          if (!liveLabels.has(label)) {
            promptLabelBindings.delete(label)
            changed = true
          }
        }
        debug(options.debug, "agent labels", labels.map((node) => ({
          text: textOf(node), x: node.screenX, y: node.screenY, w: node.width, h: node.height,
        })))
      } catch {}
      return changed
    }

    // ---- frame hook ----
    let lastRun = 0
    let lastActiveSessionID: string | null = null
    const onFrame = (): void => {
      // Read the active tab BEFORE the throttle gate. OpenCode emits `frame`
      // after native output and may stop rendering while idle, so the frame
      // carrying a real Ctrl+X tab switch can be the last frame for a while:
      // it must never be throttled away, or the prompt stays stale forever.
      let activeSessionID: string | null = null
      try {
        const at = context.ui.tabs.list().find((t: any) => t.active)
        if (at) activeSessionID = String(at.sessionID)
      } catch {}
      const activeChanged = activeSessionID !== null && activeSessionID !== lastActiveSessionID
      lastActiveSessionID = activeSessionID
      const now = Date.now()
      if (!activeChanged && now - lastRun < options.throttleMs) return
      lastRun = now
      let dirty = false
      try {
      if (!isEnabled()) {
          // next frame after a disable: undo every mutation exactly once
          if (boxSnapshots.size > 0 || fgSnapshots.size > 0) restoreOriginalState()
          return
        }
        ensurePalette()
        debug(options.debug, "runtime", process.pid, process.stdout?.isTTY, context.ui.router.current(), {
          width: context.renderer.width,
          height: context.renderer.height,
          screenMode: rendererAny.screenMode,
          renderOffset: rendererAny.renderOffset,
        })
        const tabs = context.ui.tabs.list()
        if (!tabs || tabs.length === 0) return
        for (const t of tabs) assignSession(t.sessionID)

        const { candidates, prompt, renderables } = walkTree()
        const matches = matchTabs(candidates, tabs as unknown as AnyObj[])
        debug(options.debug, "prompt found", !!prompt, "metadata", prompt ? textOf(prompt.metadata).slice(0, 80) : "")
        debug(options.debug, "tabs", tabs.length, "matches", matches.size, "active", tabs.find((t: any) => t.active)?.title?.slice?.(0, 18))
        // The active color comes from the tab list itself, not from matched
        // rows: the active tab's row can be clipped/unmatched in the tree
        // while the prompt window still has to mirror it.
        const activeTab = tabs.find((t: any) => t.active)
        const activeHex: string | null = activeTab ? rgbToHex(colorFor(String(activeTab.sessionID))) : null
        for (const [tab, cand] of matches) {
          if (applyRow(cand.row, tab, cand.horizontal, colorFor(String(tab.sessionID)))) dirty = true
        }
        if (syncPrompt(prompt, renderables, activeHex)) dirty = true

        // Right-edge bars paint in the post-process pass from current layout
        // geometry; no per-frame render requests. Ask for a render only when
        // styling changed or new/changed bindings appeared (new rows need one
        // frame before their bar is painted into the buffer).
        if (updateBindings(matches)) dirty = true

        if (dirty) {
          process.nextTick(() => {
            try {
              context.renderer.requestRender()
            } catch {}
          })
        }
      } catch {}
    }

    // postProcessFns run after root.render() and every descendant draw
    // command, before native output — the only point where the right ┃
    // survives overflowing title text. Register/remove the same reference.
    if (postProcessAvailable) {
      try {
        rendererAny.addPostProcessFn(postProcessFn)
      } catch {}
    }

    // ---- plugin-owned utility settings dialog; toggles are persistent ----
    // A custom JSX dialog: rows toggle in place (Enter/Space/click) and the
    // dialog STAYS OPEN. The built-in select always closes on Enter, which
    // made real settings interaction impossible.
    type UtilitySetting = "tabs" | SidebarField
    const utilityItems: Array<{ field: UtilitySetting; label: string; description: string }> = [
      {
        field: "tabs",
        label: "Colored tab identity + prompt sync",
        description: "Color tab borders, titles, and the active prompt.",
      },
      {
        field: "branch",
        label: "Git branch",
        description: "Branch of the current session in the sidebar.",
      },
      {
        field: "tokens",
        label: "Total tokens",
        description: "Cumulative token usage in the sidebar.",
      },
      {
        field: "rate",
        label: "Output rate",
        description: "Live and per-response tok/s in the sidebar.",
      },
      {
        field: "status",
        label: "Session status",
        description: "Running/idle indicator in the sidebar.",
      },
    ]
    const isUtilityEnabled = (field: UtilitySetting): boolean =>
      field === "tabs" ? isEnabled() : isSidebarFieldEnabled(field)
    const applyUtility = (field: UtilitySetting): void => {
      const next = !isUtilityEnabled(field)
      if (field === "tabs") {
        setSettings("enabled", next)
        lastRun = 0
      } else {
        setSettings("sidebar", field as SidebarField, next)
      }
      persistStateSoon(() => ({ enabled: settings.enabled, sidebar: { ...settings.sidebar }, assign: { ...assign } }))
      try {
        context.renderer.requestRender()
      } catch {}
    }

    // While the dialog is open the host switches keyboard input to "modal"
    // mode (only Esc/Ctrl+C by default). Registering our navigation layer in
    // that same mode is what makes the rows actually selectable.
    const [dialogOpen, setDialogOpen] = createSignal(false)
    const [dialogHighlight, setDialogHighlight] = createSignal(0)

    let removeDialogKeymap: (() => void) | null = null
    try {
      const keymapAny = context.keymap as AnyObj
      removeDialogKeymap = keymapAny.layer(() => ({
        mode: "modal",
        enabled: dialogOpen(),
        priority: 50,
        commands: [
          { id: "red.utilities.up", bind: "up", run: () => setDialogHighlight((i) => (i - 1 + utilityItems.length) % utilityItems.length) },
          { id: "red.utilities.down", bind: "down", run: () => setDialogHighlight((i) => (i + 1) % utilityItems.length) },
          { id: "red.utilities.toggle-enter", bind: "return", run: () => applyUtility(utilityItems[dialogHighlight()].field) },
          { id: "red.utilities.toggle-space", bind: "space", run: () => applyUtility(utilityItems[dialogHighlight()].field) },
        ],
      }))
    } catch {}

    const closeUtilities = (): void => {
      setDialogOpen(false)
      try {
        context.ui.dialog.clear()
      } catch {}
    }

    const openSettings = (): void => {
      if (dialogOpen()) return // already open
      setDialogHighlight(0)
      setDialogOpen(true)

      const theme = context.theme as AnyObj
      const highlightBg = theme?.background?.raised?.high

      context.ui.dialog.show(
        () =>
          createComponent(UtilitiesSettingsDialog, {
            theme,
            highlightBg,
            highlight: dialogHighlight,
            rows: utilityItems.map((item) => ({
              field: item.field as DialogField,
              label: item.label,
              description: item.description,
            })),
            isEnabled: (field) => isUtilityEnabled(field as UtilitySetting),
            onMove: (delta) => setDialogHighlight((i) => (i + delta + utilityItems.length) % utilityItems.length),
            onToggle: (field) => applyUtility(field as UtilitySetting),
          }),
        () => {
          setDialogOpen(false)
        },
      )
    }

    let removeKeymapLayer: (() => void) | null = null
    try {
      const keymapAny = context.keymap as AnyObj | undefined
      if (keymapAny && typeof keymapAny.layer === "function") {
        const dispose = keymapAny.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [
            {
              id: "red.colored-tabs.settings",
              title: "OpenCode Utilities Settings",
              group: "Utilities",
              palette: true,
              slash: { name: "utilities", aliases: ["colored-tabs"] },
              run: openSettings,
            },
          ],
          bindings: ["red.colored-tabs.settings"],
        }))
        if (typeof dispose === "function") removeKeymapLayer = dispose
      }
    } catch {}

    // ---- utility sidebar: session branch, model, cumulative tokens, rate ----
    const syncedVcsDirectories = new Set<string>()
    const syncedMessageSessions = new Set<string>()
    const removeSidebarSlot = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        if (!sessionID) return null

        assignSession(sessionID)
        const currentSession = () => context.data.session.get(sessionID)
        const currentLocation = () => currentSession()?.location ?? context.location ?? undefined

        const location = currentLocation()
        const directory = location?.directory
        const vcs = location ? context.data.location.vcs.info(location as any) : undefined
        if (directory && !vcs?.branch?.current && !syncedVcsDirectories.has(directory)) {
          syncedVcsDirectories.add(directory)
          void context.data.location.vcs.sync(location as any).catch(() => {
            syncedVcsDirectories.delete(directory)
          })
        }

        const messages = context.data.session.message.list(sessionID) ?? []
        if (messages.length === 0 && !syncedMessageSessions.has(sessionID)) {
          syncedMessageSessions.add(sessionID)
          void context.data.session.message.sync(sessionID).catch(() => {
            syncedMessageSessions.delete(sessionID)
          })
        }

        const modelRef = (): AnyObj | undefined => {
          const sessionModel = currentSession()?.model as AnyObj | undefined
          if (sessionModel?.id) return sessionModel
          const selected = context.ui.model.current()
          return selected ? { id: selected.modelID, providerID: selected.providerID } : undefined
        }

        const readRate = () => readOutputRate(sessionID)
        const outputTps = () => readRate()?.value
        const outputTpsEstimated = () => readRate()?.exact === false

        const theme = () => {
          const colors = context.theme as AnyObj
          return {
            text: colors.text?.base,
            textMuted: colors.text?.muted,
            primary: colors.text?.action?.primary?.base,
            success: colors.text?.feedback?.success?.base,
          }
        }

        return createComponent(SidebarOverview, {
          branch: () => {
            const here = currentLocation()
            return here ? context.data.location.vcs.info(here as any)?.branch.current : undefined
          },
          totalTokens: () => tokenTotal(currentSession()?.tokens as AnyObj | undefined),
          outputTps,
          outputTpsEstimated,
          status: () => context.data.session.status(sessionID),
          visibleRows: () => ({
            branch: isSidebarFieldEnabled("branch"),
            tokens: isSidebarFieldEnabled("tokens"),
            rate: isSidebarFieldEnabled("rate"),
            status: isSidebarFieldEnabled("status"),
          }),
          accent: () => isEnabled() ? rgbToHex(colorFor(sessionID)) : undefined,
          theme,
        } satisfies SidebarOverviewProps)
      },
    })

    context.renderer.on("frame", onFrame)
    return () => {
      try {
        context.renderer.off("frame", onFrame)
      } catch {}
      try {
        if (postProcessAvailable) rendererAny.removePostProcessFn(postProcessFn)
      } catch {}
      try {
        if (removeKeymapLayer) removeKeymapLayer()
      } catch {}
      try {
        removeSidebarSlot()
      } catch {}
      for (const stop of stopRateEvents) {
        try {
          stop()
        } catch {}
      }
      try {
        activeSteps.clear()
        turnAccumulators.clear()
        turnRates.clear()
      } catch {}
      // Restore pre-plugin styles from the snapshots BEFORE clearing them, so
      // a plugin disable/reload cannot strand colored borders/text behind.
      // restoreOriginalState() also clears the snapshots, the row bindings,
      // and schedules one render so the undo actually hits the screen.
      try {
        restoreOriginalState()
      } catch {}
    }
  },
})
