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
  `sidebar.content` slot with the session Git branch, cumulative token total,
  live estimated and per-response output/reasoning tok/s, and running/idle
  status. The model itself is omitted because OpenCode already shows it in the
  prompt. Rows can be folded with the `▼` / `▶` heading and individually shown
  or hidden in plugin settings. Branch is omitted outside a Git repo.

## Plugin settings

Colored tabs and the sidebar rows are enabled by default. Open the command
palette (`Ctrl+P`) and choose **OpenCode Utilities Settings**, or run
`/utilities` (also `/colored-tabs`). Select an item to toggle it; the dialog
reopens with the updated state. Choices persist across TUI restarts. This is a
plugin-owned settings dialog, not an entry in OpenCode's built-in **Open
settings** menu (the plugin API has no settings registration hook).

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
- `sidebar.tsx` — compact session overview panel
- `colors.ts` — OKLCH palette engine (zero dependencies)

## Notes

- Internals-based: it matches tab rows by geometry + title text each
  frame (~7x/sec, throttled). OpenCode version 2.0.23 verified; a TUI
  refactor may require matcher tweaks (`debug: true` logs what it sees).
- Color assignments live in plugin storage key `assign-v2`. Delete
  sessions' entries there (or bump the key) to reshuffle colors.
