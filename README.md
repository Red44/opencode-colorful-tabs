# OpenCode Colorful Tabs + Utilities

An OpenCode v2 TUI utility plugin: per-tab identity colors synced with the
main prompt, plus a compact session overview in the supported sidebar slot.

The TUI plugin API cannot restyle the built-in tab strip or register settings
inside OpenCode's built-in **Open settings** menu. This plugin
locates the tab strip renderables in the OpenTUI tree, overrides their themed
borders and text colors, and post-processes the final frame to keep right-edge
bars visible even when long titles reach the edge.

## What it does

- **Tab identity colors** — every open tab gets a stable color from a
  10-color palette derived from your theme's accent. Tab 1 is the exact
  accent color; the rest are OKLCH hue rotations with a lightness wave and
  deterministic per-session jitter, so neighbors are always clearly
  different. After 10 tabs the palette rotates. Colors are sticky per
  session (survive reordering and restarts) and persist across TUI
  instances.
- **Vertical tab strip** (`tabs.layout: vertical`) — each tab row gets
  colored heavy `┃` lines on both edges, and the title text is recolored to
  the same value.
- **Horizontal tab strip** (`tabs.layout: horizontal`) — each tab gets a
  colored underline instead.
- **Prompt sync** — the main prompt window mirrors the ACTIVE tab: its
  left + right `┃` side dashes and the agent name in the prompt footer
  (e.g. "Orchestrator") are recolored to the active tab's color. The
  color of the prompt tells you which tab you are in without reading the
  tab strip.
- Status indicators (busy/error dots) keep their own colors.
- **Session overview** — adds a compact panel through OpenCode's supported
  `sidebar.content` slot with the session Git branch, cumulative token total
  (compact `14.1K` / `2.5M` units) with hit rate (`94% hr`), live estimated and
  per-response output/reasoning tok/s with time to first output
  (`4886ms ttfb` suffix), and running/idle status, plus user-authored progress
  bars. The
  model itself is omitted because
  OpenCode already shows it in the prompt. Rows can be folded with the `▼` / `▶`
  heading and individually shown or hidden in plugin settings. Outside a Git
  repo the Branch row reads `no git`.

## Plugin settings

Colored tabs and the sidebar rows are enabled by default. Open the command
palette (`Ctrl+P`) and choose **OpenCode Utilities Settings**, or run
`/utilities`. Use ↑/↓ to select a row and Enter or Space
to toggle it in place; the dialog stays open until Esc. Choices persist across
TUI restarts. This is a plugin-owned settings dialog, not an entry in OpenCode's
built-in **Open settings** menu (the plugin API has no settings registration
hook).

## Progress bar scripts

Add `.js` files directly to either directory:

- Global: `$OPENCODE_CONFIG_DIR/bars/` when set; otherwise
  `$XDG_CONFIG_HOME/opencode/bars/` (defaults to `~/.config/opencode/bars/`)
- Project-local: `<project>/.opencode/bars/`

Global bars appear before project-local bars; files within each directory are
ordered by filename. Both scopes are enabled by default and can be toggled
independently in **OpenCode Utilities Settings**. The project toggle applies to
every project you open; all discovered scripts in an enabled scope run.

A script exports a default function or named `getProgress` function. It receives
the current session and update event, and returns a title and percentage (or
`null` to hide that bar). It may also return an optional `color` (bar fill)
and/or `titleColor` (name only), each an exact `"#RRGGBB"` hex string:

```js
export default async function getProgress({ sessionID, directory, event }) {
  return { title: "Tests", percentage: 42, color: "#22c55e", titleColor: "#a78bfa" }
}
```

Colors are fully script-controlled: the script decides if and when to set them
(for example red while tests fail, green once they pass). `color` tints only
the bar; `titleColor` tints only the name. When omitted, the fill falls back to
the theme (success color at 100%) and the name stays muted. Colors other than
an exact `"#RRGGBB"` hex string (e.g. `#fff` or `red`) are rejected like any
other invalid result: the run reports an error and the bar is hidden for that
refresh.

Scripts refresh on `session.step.started`, `session.step.streamed`, text and
reasoning deltas, `session.step.ended`, and `session.idle`; rapid updates are
debounced. They execute as JavaScript in OpenCode's process, not in a sandbox;
only add scripts you trust. Each script has a two-second timeout; a timed-out
script is skipped until its file changes.

## Install

Already installed at `~/.config/opencode/plugins/colored-tabs/` — global
plugin discovery loads it automatically. The session overview uses the
official sidebar slot; tab coloring requires tabs enabled
(`tabs.mode: on|auto` in `cli.json`).

## Options

Add to `~/.config/opencode/opencode.json` (or per-project) if you want to
change defaults:

```jsonc
{
  "plugin": [
    {
      "package": "./plugins/colored-tabs",
      "options": {
        "enabled": true,       // initial state on first run; dialog choice persists
        "sidebar": {           // which overview rows to show by default
          "branch": true,
          "tokens": true,
          "rate": true,
          "status": true
        },
        "accentStep": "500",   // accent scale step anchoring the palette
        "dashLeft": true,      // left line on vertical tab rows
        "dashRight": true,     // right line on vertical tab rows
        "recolorTitle": true,  // title text matches the line color
        "promptSync": true,    // prompt dashes + agent name follow active tab
        "debug": false         // log matcher decisions to /tmp/opencode/...
      }
    }
  ]
}
```

## Files

- `tui.ts` — TUI plugin: tab styling, prompt sync, utility data and slots
- `bar-scripts.ts` — discovers and evaluates global/project progress scripts
- `bar-script-worker.ts` — per-invocation worker that loads and validates a script
- `sidebar.tsx` — compact session overview panel
- `colors.ts` — OKLCH palette engine (zero dependencies)

## Notes

- Internals-based: it matches tab rows by geometry + title text each
  frame (~7x/sec, throttled). OpenCode version 2.0.23 verified; a TUI
  refactor may require matcher tweaks (`debug: true` logs what it sees).
- Color assignments live in plugin storage key `assign-v2`. Delete
  sessions' entries there (or bump the key) to reshuffle colors.
