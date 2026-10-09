/**
 * settings-dialog.tsx — plugin-owned settings dialog for the utilities.
 *
 * Custom JSX dialog (the built-in select always closes on Enter, which made
 * row toggles impossible). Rows toggle in place on Enter/Space/click and the
 * dialog stays open until Esc. The parent owns keymap + persistence.
 *
 * The bar-script rows carry quiet scope notes ("all projects" vs "this
 * project only"), and a static warning sits below the rows: project-local
 * bar scripts auto-run in every project you open and execute as trusted
 * JavaScript with OpenCode's full process permissions — no sandbox. The
 * warning is pure presentation (no handlers, not selectable), so the
 * keyboard and mouse interactions are untouched.
 */

/** @jsxImportSource @opentui/solid */
import { For, type Accessor } from "solid-js"
import type { JSX } from "@opentui/solid"

export type DialogField =
  | "tabs"
  | "branch"
  | "tokens"
  | "rate"
  | "status"
  | "bars-global"
  | "bars-project"
  | "mcp-injection"

export interface SettingsDialogProps {
  theme: any
  highlightBg: any
  highlight: Accessor<number>
  setHighlight: (index: number) => void
  rows: Array<{ field: DialogField; label: string; description: string }>
  isEnabled: (field: DialogField) => boolean
  onMove: (delta: number) => void
  onToggle: (field: DialogField) => void
}

/** Quiet scope clarification appended to the bar-script row labels. */
const SCOPE_NOTES: Partial<Record<DialogField, string>> = {
  "bars-global": "all projects",
  "bars-project": "per-project files, all projects",
}

export function UtilitiesSettingsDialog(props: SettingsDialogProps): JSX.Element {
  const warnColor =
    props.theme?.text?.feedback?.warning?.base ??
    props.theme?.text?.feedback?.error?.base ??
    props.theme?.text?.base
  return (
    <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1}>
      <text fg={props.theme?.text?.base}>
        <b>OpenCode Utilities</b>
      </text>
      <For each={props.rows}>
        {(item, index) => {
          const selected = () => props.highlight() === index()
          const on = () => props.isEnabled(item.field)
          const scope = SCOPE_NOTES[item.field]
          return (
            <box
              flexDirection="row"
              gap={1}
              backgroundColor={selected() ? props.highlightBg : undefined}
              onMouseDown={() => {
                props.setHighlight(index())
                props.onToggle(item.field)
              }}
            >
              <text flexShrink={0} fg={on() ? props.theme?.text?.feedback?.success?.base : props.theme?.text?.muted}>
                {on() ? "✓" : "○"}
              </text>
              <text fg={props.theme?.text?.base}>
                {item.label}
                <span style={{ fg: props.theme?.text?.muted }}>
                  {scope ? ` (${scope})` : ""} — {item.description}
                </span>
              </text>
            </box>
          )
        }}
      </For>
      <box flexDirection="column">
        <text fg={warnColor}>
          <b>⚠ Project bar scripts are not a sandbox</b>
        </text>
        <text fg={props.theme?.text?.base}>
          When enabled, a project's .opencode/bars scripts auto-run in every project
        </text>
        <text fg={props.theme?.text?.base}>
          you open — trusted JavaScript with OpenCode process permissions:
        </text>
        <text fg={props.theme?.text?.base}>
          filesystem, network, processes. Only enable for repositories you trust.
        </text>
      </box>
      <text fg={props.theme?.text?.muted}>↑↓ move · Enter/Space toggle · Esc close</text>
    </box>
  )
}
