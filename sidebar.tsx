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
 *  - Motion: a single slow blink (900 ms) on the running dot. Nothing else
 *    moves — the terminal already repaints often enough. The dot rests
 *    while the section is folded.
 *
 * Values may be passed plain or as Solid accessors, so the parent can wire
 * signals later without changing this component.
 */

/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, onCleanup, Show, type Accessor } from "solid-js"
import type { JSX } from "@opentui/solid"

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
}

/** A prop value: plain data now, or an accessor returning it later. */
export type SidebarValue<T> = T | Accessor<T>
export type SidebarOverviewRow = "branch" | "tokens" | "rate" | "status"

export interface SidebarOverviewProps {
  /** Git branch, e.g. "main". Hidden when absent. */
  branch?: SidebarValue<string | null | undefined>
  /** Total session tokens. 0 renders as "0" (fresh session); null hides the row. */
  totalTokens?: SidebarValue<number | null | undefined>
  /** Output tokens/sec. Hidden when absent or <= 0 (a 0 rate is noise). */
  outputTps?: SidebarValue<number | null | undefined>
  /** Marks an in-progress character-based rate as approximate. */
  outputTpsEstimated?: SidebarValue<boolean | undefined>
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

/** Neutral fallback — only used until the parent wires ctx.theme.current. */
const FALLBACK_THEME: Required<SidebarOverviewTheme> = {
  text: "#bcbcbc",
  textMuted: "#8a8a8a",
  primary: "#9a9a9a",
  success: "#6a9955",
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

/** 47 -> "47 t/s", 6.53 -> "6.5 t/s", 1234 -> "1,234 t/s". */
function formatTps(n: number): string {
  const v = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10
  return `${thousands(v)} t/s`
}

/** Hard-clamp long branch/model names; flex clipping alone wraps ugly. */
function clampLabel(text: string): string {
  return text.length <= MAX_VALUE_CHARS ? text : `${text.slice(0, MAX_VALUE_CHARS - 1)}…`
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
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? thousands(raw) : null
  }
  const tps = () => {
    const raw = read(props.outputTps)
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? formatTps(raw) : null
  }
  const rateValue = () => {
    const raw = read(props.outputTps)
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null
    return `${read(props.outputTpsEstimated) ? "~" : ""}${formatTps(raw)}`
  }
  const status = () => {
    const raw = read(props.status)
    return raw === "running" || raw === "idle" ? raw : null
  }
  const visible = (row: SidebarOverviewRow) => read(props.visibleRows)?.[row] !== false

  const colors = () => {
    const t = read(props.theme)
    return {
      text: safeColor(t?.text, FALLBACK_THEME.text),
      textMuted: safeColor(t?.textMuted, FALLBACK_THEME.textMuted),
      primary: safeColor(t?.primary, FALLBACK_THEME.primary),
      success: safeColor(t?.success, FALLBACK_THEME.success),
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

  const hasAny = () => Boolean(branch() ?? tokens() ?? tps() ?? status())
  const toggle = () => setExpanded((value) => !value)

  return (
    <Show when={hasAny()}>
      <box gap={1}>
        <Heading color={colors().text} expanded={expanded()} toggle={toggle} />
        <Show when={expanded()}>
          <box>
            <Show when={visible("branch") && branch()}>
              {(name) => (
                <Row label="Branch" labelColor={colors().textMuted} valueColor={colors().text}>
                  {name()}
                </Row>
              )}
            </Show>
            <Show when={visible("tokens") && tokens()}>
              {(count) => (
                <Row label="Tokens" labelColor={colors().textMuted} valueColor={colors().text}>
                  {count()}
                </Row>
              )}
            </Show>
            <Show when={visible("rate") && rateValue()}>
              {(rate) => (
                <Row label="Rate" labelColor={colors().textMuted} valueColor={colors().text}>
                  {rate()}
                </Row>
              )}
            </Show>
            <Show when={visible("status") && status()}>
              <Row label="Status" labelColor={colors().textMuted} valueColor={statusColor()}>
                {dot()}{" "}{statusLabel()}
              </Row>
            </Show>
          </box>
        </Show>
      </box>
    </Show>
  )
}
