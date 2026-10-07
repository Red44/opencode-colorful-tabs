/**
 * settings-dialog.tsx — plugin-owned settings dialog for the utilities.
 *
 * Custom JSX dialog (the built-in select always closes on Enter, which made
 * row toggles impossible). Rows toggle in place on Enter/Space/click and the
 * dialog stays open until Esc. The parent owns keymap + persistence.
 */

/** @jsxImportSource @opentui/solid */
import { For, type Accessor } from "solid-js"
import type { JSX } from "@opentui/solid"

export type DialogField = "tabs" | "branch" | "tokens" | "rate" | "status"

export interface SettingsDialogProps {
  theme: any
  highlightBg: any
  highlight: Accessor<number>
  rows: Array<{ field: DialogField; label: string; description: string }>
  isEnabled: (field: DialogField) => boolean
  onMove: (delta: number) => void
  onToggle: (field: DialogField) => void
}

export function UtilitiesSettingsDialog(props: SettingsDialogProps): JSX.Element {
  return (
    <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1}>
      <text fg={props.theme?.text?.base}>
        <b>OpenCode Utilities</b>
      </text>
      <For each={props.rows}>
        {(item, index) => {
          const selected = () => props.highlight() === index()
          const on = () => props.isEnabled(item.field)
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
                <span style={{ fg: props.theme?.text?.muted }}> — {item.description}</span>
              </text>
            </box>
          )
        }}
      </For>
            <text fg={props.theme?.text?.muted}>↑↓ move · Enter/Space toggle · Esc close</text>
    </box>
  )
}
