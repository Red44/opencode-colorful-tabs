# colored-tabs

Per-tab identity colors for the OpenCode v2 TUI session tab strip, synced
with the main prompt window.

The TUI plugin API cannot restyle the built-in tab strip, so this plugin
hooks the renderer's frame event, locates the tab strip renderables in the
OpenTUI tree, and overrides their themed borders and text colors.

## What it does

- **Tab identity colors** — every open tab gets a stable color from a
  10-color palette derived from your theme's accent. Tab 1 is the exact
  accent color; the rest are OKLCH hue rotations with a lightness wave and
  deterministic per-session jitter, so neighbors are always clearly
  different. After 10 tabs the palette rotates. Colors are sticky per
  session (survive reordering and restarts) and persist across TUI
  instances.
- **Vertical tab strip** (`tabs.layout: vertical`) — each tab row gets a
  colored `│` line on its left and right edges, and the title text is
  recolored to the same value.
- **Horizontal tab strip** (`tabs.layout: horizontal`) — each tab gets a
  colored underline instead.
- **Prompt sync** — the main prompt window mirrors the ACTIVE tab: its
  left + right `┃` side dashes and the agent name in the prompt footer
  (e.g. "Orchestrator") are recolored to the active tab's color. The
  color of the prompt tells you which tab you are in without reading the
  tab strip.
- Status indicators (busy/error dots) keep their own colors.

## Install

Already installed at `~/.config/opencode/plugins/colored-tabs/` — global
plugin discovery loads it automatically. Requires tabs to be enabled
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

- `tui.ts` — TUI plugin: tree walk, tab matching, border/text overrides
- `colors.ts` — OKLCH palette engine (zero dependencies)

## Notes

- Internals-based: it matches tab rows by geometry + title text each
  frame (~7x/sec, throttled). OpenCode version 2.0.23 verified; a TUI
  refactor may require matcher tweaks (`debug: true` logs what it sees).
- Color assignments live in plugin storage key `assign-v2`. Delete
  sessions' entries there (or bump the key) to reshuffle colors.
