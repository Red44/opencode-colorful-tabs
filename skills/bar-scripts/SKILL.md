---
name: bar-scripts
description: Write and debug progress-bar scripts for the colored-tabs plugin sidebar. Use when creating, editing, or troubleshooting sidebar progress bars (bars/*.js returning { title, percentage, color? }).
---

# Colored-tabs bar scripts

Progress bars are plain `.js` files the colored-tabs plugin discovers and runs.
Each script reports one sidebar meter. Reference implementations live in the
plugin repo under `bars/` (`openai-5h-usage.js`, `zai-5h-usage.js`).

## Locations

- Global: `$OPENCODE_CONFIG_DIR/bars/` when set; otherwise
  `$XDG_CONFIG_HOME/opencode/bars/` (default `~/.config/opencode/bars/`)
- Project-local: `<project>/.opencode/bars/`

Global bars render before project bars; files sort by name inside each scope.
Both scopes are user-togglable in OpenCode Utilities Settings.

## Contract

Export a default function or named `getProgress`. It receives a frozen context
`{ sessionID, directory, event }` and returns either `null` (hide the bar this
refresh) or:

```js
export default function getProgress({ sessionID, directory, event }) {
  return {
    title: "Tests",        // non-empty string, truncated to fit
    percentage: 42,        // finite number, clamped to 0-100
    color: "#22c55e",      // optional: bar fill (#RRGGBB)
    titleColor: "#a78bfa", // optional: name color (#RRGGBB)
  }
}
```

Validation is strict: non-string/empty titles, non-finite percentages, and
anything but exact `#RRGGBB` colors reject the whole result — the bar hides for
that refresh and the error surfaces via the debug log.

## Execution model (matters for design)

- Every invocation runs in a **fresh Web Worker** — no module cache, no shared
  state between calls. Keep scripts stateless; persist state in a cache file.
- **2-second timeout per script**; a timed-out script is skipped until its file
  mtime changes. A global budget of 4 concurrent workers is shared across
  sessions.
- Scripts are not sandboxed — they run with OpenCode's process permissions.
  Only install scripts from trusted sources.
- Refresh events: `session.step.started`, `session.step.streamed`,
  `session.text.delta`, `session.reasoning.delta`, `session.step.ended`,
  `session.idle`, plus `sidebar.open` on session switch. Bursts are debounced
  (300 ms) with a 1 s max-wait.

## Network-backed bars (quota/usage)

Delta events fire constantly during streaming — do NOT hit a network API on
every event. Use the pattern from the shipped scripts:

- Live query only on `sidebar.open` and `session.step.ended`.
- Every other event serves a cached snapshot; cache only non-secret numbers
  (`{ percentage, updatedAt }`) under `$XDG_CACHE_HOME/opencode/` (dir 0700,
  file 0600).
- Secrets (API keys) are read at request time from their source (e.g. OpenCode's
  `auth.json`), used only in headers, never logged, never persisted.
- Failures keep the prior snapshot or hide the bar — never fabricate a value.
- Keep total work well under 2 s (AbortController ~1.2 s for fetches).

## Testing and debugging

Run one refresh outside the TUI through the real pipeline:

```sh
bun -e 'import { runBarScripts } from "<plugin>/bar-scripts.ts"; \
  console.log(await runBarScripts({ globalDirectory: "~/.config/opencode/bars", \
  context: { sessionID: "t", event: "sidebar.open" } }))'
```

- `COLORED_TABS_DEBUG=1` before launching the TUI logs bar errors and events to
  `/tmp/opencode/colored-tab-plugin/plugin-debug-*.log`.
- Cache files under `~/.cache/opencode/*-usage.json` can be deleted to force a
  fresh live query.
