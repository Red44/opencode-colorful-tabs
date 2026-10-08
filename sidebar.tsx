/**
 * sidebar.tsx — compact session overview for the official `sidebar.content` slot.
 *
 * Presentation-only: every value arrives via props, nothing here talks to the
 * OpenCode client. The parent (tui.ts) owns data collection and renders this
 * inside its slot:
 *
 *   sidebar_content(_ctx, props) {
 *     return <SidebarOverview branch={...} model={...} totalTokens={...} ... />
 *   }
 *
 * Design rules (matching the tab strip's visual language):
 *  - One accent, one accent only. The heavy `┃` next to the section heading is
 *    painted in the active tab's identity color (pass the palette hex as
 *    `accent`), echoing the tab strip and prompt side dashes. Everything else
 *    stays quiet: muted labels, normal values, one semantic status color.
 *  - Fixed 6-char label column so values align into a scannable table.
 *  - Rows with no data disappear; with no data at all the whole section
 *    disappears, so the slot never renders an empty shell.
 *  - The heading folds like the official sidebar sections: `▼ Session` open,
 *    `▶ Session` collapsed, open on mount. The whole heading row toggles on
 *    mouse press — the same event the official sections use — and answers
 *    Enter/Space while focused, the only keyboard channel OpenTUI gives a
 *    box. Pressing it never steals focus from the prompt.
 *  - `visibleRows` lets the parent hide individual rows from persisted
 *    settings: absent or true keeps a row, an explicit false hides it.
 *  - `bars` renders script progress meters as compact single-line rows:
 *    truncated title, a thin solid-over-shade track, and the percentage,
 *    all sharing one line. A meter's own `color` (validated hex from the
 *    script) tints both its title and its filled segments; the theme
 *    primary (success at 100%) remains the fallback. Percentages clamp
 *    to 0–100, and the whole area vanishes when empty — while folding
 *    with the section like every other line.
 *  - Motion: a single slow blink (900 ms) on the running dot. Nothing else
 *    moves — the terminal already repaints often enough. The dot rests
 *    while the section is folded.
 *
 * Values may be passed plain or as Solid accessors, so the parent can wire
 * signals later without changing this component.
 */

/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, For, onCleanup, Show, type Accessor } from "solid-js"
import type { JSX } from "@opentui/solid"
import type { ProgressBar } from "./bar-scripts"

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Session activity. Anything else (or nothing) hides the status row. */
export type SidebarOverviewStatus = "running" | "idle"

/**
 * Anything OpenTUI accepts as a color: a hex string ("#aabbcc", straight from
 * colors.ts) or a host RGBA instance (theme colors are structurally compatible).
 */
export type SidebarColor = string | { readonly r: number; readonly g: number; readonly b: number; readonly a?: number }

/** The slice of TuiThemeCurrent this component needs. All optional. */
export interface SidebarOverviewTheme {
  text?: SidebarColor
  textMuted?: SidebarColor
  primary?: SidebarColor
  success?: SidebarColor
  error?: SidebarColor
}

/** A prop value: plain data now, or an accessor returning it later. */
export type SidebarValue<T> = T | Accessor<T>
export type SidebarOverviewRow = "branch" | "tokens" | "rate" | "status" | "bars"

export interface SidebarOverviewProps {
  /** Git branch, e.g. "main". Hidden when absent. */
  branch?: SidebarValue<string | null | undefined>
  /** Total session tokens. 0 renders as "0" (fresh session); null hides the row. */
  totalTokens?: SidebarValue<number | null | undefined>
  /** Share of session input tokens served from cache, 0-100. Muted suffix when known. */
  cacheRate?: SidebarValue<number | null | undefined>
  /** Output tokens/sec. Hidden when absent or <= 0 (a 0 rate is noise). */
  outputTps?: SidebarValue<number | null | undefined>
  /** Mean time to first streamed output of the last response, in ms. Shown beside the rate. */
  ttfbMs?: SidebarValue<number | null | undefined>
  /** Marks an in-progress character-based rate as approximate. */
  outputTpsEstimated?: SidebarValue<boolean | undefined>
  /**
   * Progress meters from bar-scripts.ts, already ordered by the parent
   * (global first, then project). Rendered in the received order; hidden
   * when absent, empty, or switched off via visibleRows.bars.
   */
  bars?: SidebarValue<ProgressBar[] | null | undefined>
  /** Running sessions blink their dot; idle ones sit still and mute. */
  status?: SidebarValue<SidebarOverviewStatus | null | undefined>
  /** Per-row visibility. An omitted row defaults to visible. */
  visibleRows?: SidebarValue<Partial<Record<SidebarOverviewRow, boolean>>>
  /** Active tab identity color (hex from colors.ts). Falls back to theme primary. */
  accent?: SidebarValue<SidebarColor | null | undefined>
  /** Host theme colors (pass ctx.theme.current). Falls back to neutral grays. */
  theme?: SidebarValue<SidebarOverviewTheme | null | undefined>
}

// ---------------------------------------------------------------------------
// Constants + helpers
// ---------------------------------------------------------------------------

const BAR = "┃" // same heavy bar as the tab strip
const LABEL_WIDTH = 6 // "Branch" / "Model" / "Tokens" / "Rate" / "Status"
const LABEL_GAP = 2
const MAX_VALUE_CHARS = 28 // 6 + 2 + 28 fits the 37-col slot with room to spare
const BLINK_MS = 900
const BAR_FILL = "▄" // meter fill — lower-half block keeps the strip thin
const BAR_TRACK = "▄" // same glyph, muted: fill and track share one thin height
const BAR_WIDTH = 12 // thin track leaves room for the inline title
const BAR_PCT_CHARS = 4 // "100%" — fixed column keeps every track aligned
const BAR_TITLE_CHARS = 37 - BAR_WIDTH - BAR_PCT_CHARS - 2 // title + track + pct on one 37-col line

/** Neutral fallback — only used until the parent wires ctx.theme.current. */
const FALLBACK_THEME: Required<SidebarOverviewTheme> = {
  text: "#bcbcbc",
  textMuted: "#8a8a8a",
  primary: "#9a9a9a",
  success: "#6a9955",
  error: "#c0504d",
}

const HEX = /^#[0-9a-f]{3,8}$/i

/** Normalize a plain-or-accessor prop. */
function read<T>(input: SidebarValue<T> | undefined): T | undefined {
  return typeof input === "function" ? (input as Accessor<T>)() : input
}

/** Guard against garbage colors: a thrown parse would take down the frame. */
function safeColor(color: SidebarColor | undefined, fallback: SidebarColor): SidebarColor {
  if (color === undefined || color === null) return fallback
  if (typeof color === "string") {
    const hex = color.trim()
    return HEX.test(hex) ? hex : fallback
  }
  return color
}

/** 12345 -> "12,345", deterministic (no Intl). */
function thousands(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** 999 -> "999", 14107 -> "14.1K", 2500000 -> "2.5M" — compact token units. */
function compactTokens(n: number): string {
  const units = ["", "K", "M", "G", "T"]
  let unit = 0
  let value = n
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000
    unit++
  }
  let shown = unit === 0 ? Math.trunc(value) : Math.round(value * 10) / 10
  if (shown >= 1_000 && unit < units.length - 1) {
    unit++
    shown = Math.round((shown / 1_000) * 10) / 10
  }
  return `${shown}${units[unit]}`
}

/** 47 -> "47 t/s", 6.53 -> "6.5 t/s", 1234 -> "1,234 t/s". */
function formatTps(n: number): string {
  const v = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10
  return `${thousands(v)} t/s`
}

/** Hard-clamp long branch/model names; flex clipping alone wraps ugly. */
function clampLabel(text: string): string {
  return text.length <= MAX_VALUE_CHARS ? text : `${text.slice(0, MAX_VALUE_CHARS - 1)}…`
}

/** Inline meter titles get a tighter clamp so title + track + pct share one line. */
function clampBarTitle(text: string): string {
  return text.length <= BAR_TITLE_CHARS ? text : `${text.slice(0, BAR_TITLE_CHARS - 1)}…`
}

/** Clamp to 0–100, then carve the thin meter into solid + track segments. */
function barSegments(percentage: number): { filled: string; track: string } {
  const clamped = Math.min(100, Math.max(0, percentage))
  const filledCount = Math.round((clamped / 100) * BAR_WIDTH)
  return {
    filled: BAR_FILL.repeat(filledCount),
    track: BAR_TRACK.repeat(BAR_WIDTH - filledCount),
  }
}

/** Structural guard: malformed meter entries are skipped, never rendered. */
function toRenderableBars(raw: unknown): ProgressBar[] {
  if (!Array.isArray(raw)) return []
  const bars: ProgressBar[] = []
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue
    const bar = item as Partial<ProgressBar>
    if (typeof bar.title !== "string" || !bar.title.trim()) continue
    if (typeof bar.percentage !== "number" || !Number.isFinite(bar.percentage)) continue
    bars.push(item as ProgressBar)
  }
  return bars
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Heading(props: { color: SidebarColor; expanded: boolean; toggle: () => void }): JSX.Element {
  const onKeyDown = (event: any) => {
    const key = String(event?.name ?? event?.key ?? "").toLowerCase()
    if (key === "enter" || key === "space" || key === " ") props.toggle()
  }
  return (
    <box
      flexDirection="row"
      gap={1}
      focusable
      onMouseDown={() => props.toggle()}
      onKeyDown={onKeyDown}
    >
      <text fg={props.color}>{props.expanded ? "▼" : "▶"}</text>
      <text fg={props.color}>
        <b>Session</b>
      </text>
    </box>
  )
}

function Row(props: { label: string; labelColor: SidebarColor; valueColor: SidebarColor; children: JSX.Element }): JSX.Element {
  return (
    <box flexDirection="row" gap={LABEL_GAP}>
      <text flexShrink={0} width={LABEL_WIDTH} fg={props.labelColor}>
        {props.label}
      </text>
      <text flexGrow={1} fg={props.valueColor}>
        {props.children}
      </text>
    </box>
  )
}

/** One meter: truncated title, thin solid-over-shade track, and pct — one line. */
function BarRow(props: {
  title: string
  percentage: number
  titleColor: SidebarColor
  fillColor: SidebarColor
  trackColor: SidebarColor
  pctColor: SidebarColor
}): JSX.Element {
  const pct = `${Math.round(Math.min(100, Math.max(0, props.percentage)))}%`.padStart(BAR_PCT_CHARS)
  const { filled, track } = barSegments(props.percentage)
  return (
    <box flexDirection="row" gap={1}>
      <text flexShrink={1} flexGrow={1} fg={props.titleColor}>
        {clampBarTitle(props.title)}
      </text>
      <text flexShrink={0} fg={props.fillColor}>{filled}</text>
      <text flexShrink={0} fg={props.trackColor}>{track}</text>
      <text flexShrink={0} fg={props.pctColor}>{pct}</text>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SidebarOverview(props: SidebarOverviewProps): JSX.Element | null {
  const [expanded, setExpanded] = createSignal(true)
  const branch = () => {
    const raw = read(props.branch)
    return typeof raw === "string" && raw.trim() ? clampLabel(raw.trim()) : null
  }
  const tokens = () => {
    const raw = read(props.totalTokens)
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? compactTokens(raw) : null
  }
  const tps = () => {
    const raw = read(props.outputTps)
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? formatTps(raw) : null
  }
  const rateValue = () => {
    const raw = read(props.outputTps)
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? `${read(props.outputTpsEstimated) ? "~" : ""}${formatTps(raw)}`
      : null
  }
  /** Small muted suffix, number first: ` 488ms ttfb` or ` 1.2s ttfb`. */
  const ttfbSuffix = () => {
    const ttfb = read(props.ttfbMs)
    if (!(typeof ttfb === "number" && Number.isFinite(ttfb) && ttfb > 0)) return ""
    const value =
      ttfb < 1_000 ? `${Math.round(ttfb)}ms` : `${(Math.round(ttfb / 100) / 10).toFixed(1)}s`
    return ` ${value} ttfb`
  }
  /** Small muted suffix: ` 94% hr` (hit rate). */
  const cacheSuffix = () => {
    const rate = read(props.cacheRate)
    return typeof rate === "number" && Number.isFinite(rate) && rate > 0
      ? ` ${Math.round(rate)}% hr`
      : ""
  }
  const status = () => {
    const raw = read(props.status)
    return raw === "running" || raw === "idle" ? raw : null
  }
  const bars = () => {
    if (read(props.visibleRows)?.bars === false) return []
    return toRenderableBars(read(props.bars))
  }
  const visible = (row: SidebarOverviewRow) => read(props.visibleRows)?.[row] !== false

  const colors = () => {
    const t = read(props.theme)
    return {
      text: safeColor(t?.text, FALLBACK_THEME.text),
      textMuted: safeColor(t?.textMuted, FALLBACK_THEME.textMuted),
      primary: safeColor(t?.primary, FALLBACK_THEME.primary),
      success: safeColor(t?.success, FALLBACK_THEME.success),
      error: safeColor(t?.error, FALLBACK_THEME.error),
    }
  }
  const accent = () => safeColor(read(props.accent), colors().primary)

  // The one moving part: the dot blinks only while running.
  const [blink, setBlink] = createSignal(false)
  createEffect(() => {
    if (!expanded() || status() !== "running") {
      setBlink(false)
      return
    }
    setBlink(true)
    const timer = setInterval(() => setBlink((x) => !x), BLINK_MS)
    onCleanup(() => clearInterval(timer))
  })
  const dot = () => {
    if (status() !== "running") return "○"
    return blink() ? "○" : "●"
  }
  const statusColor = () => (status() === "running" ? colors().success : colors().textMuted)
  const statusLabel = () => (status() === "running" ? "Running" : "Idle")

  const hasAny = () => visible("branch") || Boolean(tokens() ?? tps() ?? status() ?? (bars().length > 0))
  const toggle = () => setExpanded((value) => !value)

  return (
    <Show when={hasAny()}>
      <box gap={1}>
        <Heading color={colors().text} expanded={expanded()} toggle={toggle} />
        <Show when={expanded()}>
          <box>
            <Show when={visible("branch")}>
              <Row
                label="Branch"
                labelColor={colors().textMuted}
                valueColor={branch() ? colors().text : colors().error}
              >
                {branch() ?? "no git"}
              </Row>
            </Show>
            <Show when={visible("tokens") && tokens()}>
              {(count) => (
                <Row label="Tokens" labelColor={colors().textMuted} valueColor={colors().text}>
                  {count()}
                  <span style={{ fg: colors().textMuted }}>{cacheSuffix()}</span>
                </Row>
              )}
            </Show>
            <Show when={visible("rate") && rateValue()}>
              {(rate) => (
                <Row label="Rate" labelColor={colors().textMuted} valueColor={colors().text}>
                  {rate()}
                  <span style={{ fg: colors().textMuted }}>{ttfbSuffix()}</span>
                </Row>
              )}
            </Show>
            <Show when={visible("status") && status()}>
              <Row label="Status" labelColor={colors().textMuted} valueColor={statusColor()}>
                {dot()}{" "}{statusLabel()}
              </Row>
            </Show>
            <Show when={bars().length > 0}>
              <box marginTop={1}>
                <For each={bars()}>
                  {(bar) => (
                    <BarRow
                      title={bar.title}
                      percentage={bar.percentage}
                      titleColor={safeColor(bar.titleColor ?? bar.color, colors().textMuted)}
                      fillColor={safeColor(bar.color, bar.percentage >= 100 ? colors().success : colors().primary)}
                      trackColor={colors().textMuted}
                      pctColor={colors().text}
                    />
                  )}
                </For>
              </box>
            </Show>
          </box>
        </Show>
      </box>
    </Show>
  )
}
