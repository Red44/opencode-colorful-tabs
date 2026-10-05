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
 */
import { Plugin } from "@opencode/plugin/tui"
import { appendFileSync } from "node:fs"
import { buildPalette, jitterFor, rgbToHex, hexToRgb, type Rgb } from "./colors"

type AnyObj = Record<string, any>

const OPTIONS_DEFAULTS = {
  /** master switch for all coloring (persisted; toggled via /colored-tabs) */
  enabled: true,
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

const DEBUG_FILE = "/tmp/opencode/colored-tab-plugin/plugin-debug.log"
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

export default Plugin.define({
  id: "red.colored-tabs",
  async setup(context) {
    const options = { ...OPTIONS_DEFAULTS, ...(context.options ?? {}) }
    await loadRgbClass()
    if (!context.ui.tabs.enabled()) return

    // ---- master switch (persisted; toggled via /colored-tabs) ----
    const [settings, updateSettings] = context.storage.store("settings-v1", {
      initial: { enabled: options.enabled !== false },
    })
    const isEnabled = (): boolean => settings.enabled !== false

    // ---- session -> palette index assignment (durable, rotates at 10) ----
    const [assign, updateAssign] = context.storage.store("assign-v2", {
      initial: { next: 0, bySession: {} as Record<string, number> },
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
      updateAssign((draft) => {
        if (draft.bySession[sessionID] !== undefined) return
        draft.bySession[sessionID] = draft.next % 10
        draft.next = (draft.next + 1) % 1_000_000
      }).catch(() => {})
      if (assign.bySession[sessionID] === undefined) assign.bySession[sessionID] = idx
    }

    // ---- one tree walk: tab rows + prompt boxes + prompt footer texts ----
    interface WalkResult {
      candidates: Candidate[]
      promptBoxes: any[]
      footerTextNodes: any[]
    }

    function walkTree(): WalkResult {
      const candidates: Candidate[] = []
      const promptBoxes: any[] = []
      const footerTextNodes: any[] = []
      const seen = new Set<any>()
      const H = (context.renderer.height ?? 50) as number

      const visit = (r: any, depth: number): void => {
        if (!r || seen.has(r) || depth > 45) return
        seen.add(r)
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
          // prompt input box: wide left-bordered box near the bottom
          if (
            Array.isArray(r.border) && r.border.includes("left") &&
            typeof y === "number" && y >= H - 12 &&
            typeof w === "number" && w >= 60
          ) {
            promptBoxes.push(r)
          }
        } catch {}
        // text nodes in the prompt footer zone (agent name etc.)
        try {
          const y = r.screenY
          if (
            typeof y === "number" && y >= H - 10 &&
            (Array.isArray(r?.children) || Array.isArray(r?.chunks) || r?.rootTextNode)
          ) {
            const t = textOf(r).trim()
            if (t && t.length <= 80 && !t.includes("\n")) footerTextNodes.push({ node: r, text: t })
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
      return { candidates, promptBoxes, footerTextNodes }
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
      // right side is buffer-overpainted in the renderer post-process pass
      // so overflowing titles cannot push it off the row; only the left
      // side uses the native border
      return options.dashLeft ? ["left"] : []
    }

    /**
     * Over-render the right ┃ in the post-process pass: runs after
     * root.render() and all descendant draw commands, before native output,
     * so title text can no longer overwrite the bar. drawText requires an
     * RGBA color, so convert via RGBA.fromHex() directly.
     */
    function paintCell(buffer: any, x: number, y: number, hex: string): void {
      const bw = typeof buffer?.width === "number" ? buffer.width : Number.POSITIVE_INFINITY
      const bh = typeof buffer?.height === "number" ? buffer.height : Number.POSITIVE_INFINITY
      if (x < 0 || y < 0 || x >= bw || y >= bh) return
      if (!RGBACls || typeof RGBACls.fromHex !== "function") return
      try {
        buffer.drawText("┃", x, y, RGBACls.fromHex(hex))
      } catch {}
    }

    // ---- right-edge bindings: row -> owning session ----
    const rowBindings = new Map<object, { sessionID: string }>()
    const rendererAny = context.renderer as AnyObj
    const postProcessAvailable =
      typeof rendererAny.addPostProcessFn === "function" &&
      typeof rendererAny.removePostProcessFn === "function"

    const isBindable = (row: any): boolean => {
      try {
        if (!row || row.destroyed === true || row.visible === false) return false
        if (!row.parent) return false // detached from the tree
      } catch {
        return false
      }
      return true
    }

    /** sync bindings with this frame's matches; true when something changed */
    function updateBindings(matches: Map<AnyObj, Candidate>): boolean {
      if (!options.dashRight || !postProcessAvailable) return false
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

    /** paint every bound row's right ┃ from its current post-layout geometry */
    function paintRightEdges(buffer: any): void {
      try {
        for (const [row, binding] of rowBindings) {
          try {
            const r = row as AnyObj
            const y0 = r.screenY
            const h = r.height
            if (typeof y0 !== "number" || typeof h !== "number" || h < 1) continue
            const x0 = typeof r.screenX === "number" ? r.screenX : 0
            const w = typeof r.width === "number" ? r.width : 42
            const hex = rgbToHex(colorFor(binding.sessionID))
            const x = x0 + w - 1
            const rows = Math.min(h, 3)
            for (let i = 0; i < rows; i++) paintCell(buffer, x, y0 + i, hex)
          } catch {}
        }
      } catch {}
    }

    const postProcessFn = (buffer?: any): void => {
      if (!isEnabled()) return
      const buf =
        buffer ??
        rendererAny.buffer ??
        rendererAny.rootBuffer
      if (buf) paintRightEdges(buf)
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
      try {
        for (const [box, snap] of boxSnapshots) {
          box.border = snap.border
          box.borderStyle = snap.borderStyle
          box.borderColor = snap.borderColor
          box.focusedBorderColor = snap.focusedBorderColor
        }
        for (const [node, fg] of fgSnapshots) {
          node.fg = fg
        }
      } catch {}
      boxSnapshots.clear()
      fgSnapshots.clear()
      // right-edge bars must not repaint on the next post-process pass
      rowBindings.clear()
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

    /** prompt window mirrors the active tab: side dashes + agent name */
    function syncPrompt(promptBoxes: any[], footerTextNodes: { node: any; text: string }[], activeHex: string | null): boolean {
      if (!options.promptSync || !activeHex) return false
      let changed = false
      for (const box of promptBoxes) {
        if (setBoxColor(box, activeHex, ["left", "right"])) changed = true
      }
      // agent name in the prompt footer, e.g. "Orchestrator"
      try {
        const location = context.location ?? undefined
        const agents: any[] = (context as AnyObj).data?.location?.agent?.list(location) ?? []
        const names = new Set(agents.map((a) => normalize(String(a?.name ?? ""))).filter(Boolean))
        if (names.size > 0) {
          for (const { node } of footerTextNodes) {
            for (const child of styledChildren(node)) {
              if (!names.has(normalize(child.text))) continue
              if (toHex(child.node.fg) !== activeHex) {
                snapshotFg(child.node)
                child.node.fg = asColor(activeHex)
                changed = true
              }
            }
          }
        }
      } catch {}
      return changed
    }

    // ---- frame hook ----
    let lastRun = 0
    const onFrame = (): void => {
      const now = Date.now()
      if (now - lastRun < options.throttleMs) return
      lastRun = now
      let dirty = false
      try {
        if (!isEnabled()) {
          // next frame after a disable: undo every mutation exactly once
          if (boxSnapshots.size > 0 || fgSnapshots.size > 0) restoreOriginalState()
          return
        }
        ensurePalette()
        const tabs = context.ui.tabs.list()
        if (!tabs || tabs.length === 0) return
        for (const t of tabs) assignSession(t.sessionID)

        const { candidates, promptBoxes, footerTextNodes } = walkTree()
        const matches = matchTabs(candidates, tabs as unknown as AnyObj[])
        debug(options.debug, "promptBoxes", promptBoxes.length, "footer", footerTextNodes.slice(0, 8).map((f) => f.text.slice(0, 14)))
        debug(options.debug, "tabs", tabs.length, "matches", matches.size, "active", tabs.find((t: any) => t.active)?.title?.slice?.(0, 18))
        let activeHex: string | null = null
        for (const [tab, cand] of matches) {
          if (applyRow(cand.row, tab, cand.horizontal, colorFor(String(tab.sessionID)))) dirty = true
          if (tab.active) activeHex = rgbToHex(colorFor(String(tab.sessionID)))
        }
        if (syncPrompt(promptBoxes, footerTextNodes, activeHex)) dirty = true

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

    // ---- palette/slash toggle: works while disabled (frame hook stays live) ----
    const toggleEnabled = async (): Promise<void> => {
      const next = !isEnabled()
      updateSettings((draft) => {
        draft.enabled = next
      }).catch(() => {})
      settings.enabled = next // immediate local effect, mirrors the assign pattern
      lastRun = 0 // the very next frame must not be throttled
      try {
        context.renderer.requestRender()
      } catch {}
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
              id: "red.colored-tabs.toggle",
              title: "Toggle Colored Tabs",
              group: "Colored Tabs",
              palette: true,
              slash: { name: "colored-tabs" },
              run: toggleEnabled,
            },
          ],
          bindings: ["red.colored-tabs.toggle"],
        }))
        if (typeof dispose === "function") removeKeymapLayer = dispose
      }
    } catch {}

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
      rowBindings.clear()
      boxSnapshots.clear()
      fgSnapshots.clear()
    }
  },
})
