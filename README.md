# Claude Code Usage Indicator

An always-visible indicator of your Claude usage, right in the VS Code status bar — the same
data the `/usage` slash command shows (the 5-hour rolling rate-limit window, the weekly window,
and when they reset) — so you never have to stop and type `/usage` again.

```
 …  Go Live   Ln 12, Col 4   Spaces: 2   UTF-8   ⟁ Claude 87%
                                                  └─ click to refresh, hover for details
```

## Features

- **5-hour window at a glance** — your current rate-limit usage as a live percentage in the status bar.
- **Rich tooltip** — hover to see both the 5-hour and weekly windows, each with a reset countdown
  in days / hours / minutes.
- **Click to refresh** — one click re-checks immediately.
- **Configurable** — refresh interval, status-bar label, and whether to show the weekly window too.
- **Read-only & safe** — it only *reads* your existing Claude credentials; it never modifies,
  refreshes, or transmits them anywhere except to Anthropic's own usage endpoint (the same one
  Claude Code uses).

## Requirements

- **VS Code** 1.85 or newer.
- **Claude Code** installed and **logged in** at least once on this machine — the indicator reads
  the OAuth token that Claude Code stores in `~/.claude/.credentials.json`. If you've never logged
  in, or the token has expired, the indicator will say so and ask you to open Claude Code.

> Currently verified on **Windows**. macOS/Linux support is on the roadmap (the token location and
> a per-OS core binary still need to be wired up).

## Installation

A packaged `.vsix` / Marketplace listing is planned. For now, build it from source:

### Prerequisites (build-time only)

- [Go](https://go.dev/dl/) 1.23+ — to compile the core binary.
- [Node.js](https://nodejs.org/) 18+ — to compile the extension.

> End users who install a future packaged release will **not** need Go or Node — the core is
> shipped as a prebuilt binary and the extension runs on VS Code's built-in runtime.

### Build & run

```bash
# 1. Build the core
cd core
go build -o usage-core.exe .          # or: go build -o usage-core .   (macOS/Linux)

# 2. Make the core available to the extension
mkdir -p ../adapters/vscode/bin
cp usage-core.exe ../adapters/vscode/bin/    # copy the binary you just built

# 3. Build the extension
cd ../adapters/vscode
npm install
npm run compile
```

Then open the repository folder in VS Code and press **F5** to launch an
*Extension Development Host* with the indicator loaded. Look at the bottom-right of the status bar.

To install it permanently, package it with [`vsce`](https://github.com/microsoft/vscode-vsce)
(`npx vsce package`) and install the resulting `.vsix` via *Extensions → … → Install from VSIX*.

## Usage

Once active, the indicator sits at the bottom-right of the VS Code status bar:

- **Hover** — full breakdown of the 5-hour and weekly windows and their reset times.
- **Click** — refresh now.
- **Command Palette** (`Ctrl/Cmd+Shift+P`):
  - `Claude Usage: Refresh now`
  - `Claude Usage: Set refresh interval`

## Configuration

Settings (search "Claude Usage" in VS Code settings):

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeUsage.refreshIntervalSeconds` | `90` | How often to re-check usage. Values between 1 and the floor are raised to the floor (30 s) to avoid hammering the endpoint. `0` = manual refresh only. |
| `claudeUsage.label` | `"Claude"` | Short text before the percentage (e.g. `Claude Code usage`, or empty for just the number). |
| `claudeUsage.showWeekly` | `false` | Also show the weekly (7-day) window percentage in the status bar, not just the 5-hour one. |
| `claudeUsage.corePath` | `""` | Absolute path to the `usage-core` binary. Leave empty to use the binary bundled in `bin/`. |

The refresh interval can be changed on the fly via *Set refresh interval* — no window reload needed.

## How it works

A small shared **core** (a Go binary) does all the sensitive work; a thin **VS Code adapter**
(TypeScript) just spawns it and renders the result.

```
~/.claude/.credentials.json ──── read-only ──▶  usage-core (Go)
                                                 • read accessToken
api.anthropic.com/api/oauth/usage ◀── Bearer ──  • GET usage endpoint
                                                 • normalize → JSON
                                                        │
                                          VS Code adapter renders it in the status bar
```

### Safety

The access token is the **same** one Claude Code itself uses. The core is strictly **read-only**
on your credentials: it reads `accessToken` and never refreshes or rewrites the file. If the token
is expired it degrades gracefully ("open Claude Code to refresh") rather than rotating it — which
would break Claude Code's own auth. The token is sent only to Anthropic's official usage endpoint,
nowhere else. The exact request/response is documented in [`docs/usage-endpoint.md`](docs/usage-endpoint.md).

## Roadmap

- [x] **Phase 0** — validate the usage endpoint + freeze the response schema.
- [x] **Phase 1** — Go core + VS Code status-bar indicator (the MVP).
- [ ] **Phase 2** — package a `.vsix` / publish to the Marketplace; prebuilt core per OS/arch (Windows, macOS, Linux).
- [ ] **Phase 3** — JetBrains (Rider / IntelliJ) status-bar widget reusing the same core.
- [ ] **Phase 4** — optional shared daemon (one fetch/cache across hosts).
- [ ] **Phase 5** — Claude Desktop tray app (Windows & macOS).

The indicator intentionally lives in the **host's status bar**, not injected into the Claude Code
panel itself.

## Contributing

Issues and PRs welcome. The core and the adapter are deliberately decoupled, so adding a new host
(JetBrains, a tray app, …) means writing a new thin adapter against the same `usage-core` JSON
contract — no need to touch the credential/endpoint logic.

## License

MIT — see [LICENSE](LICENSE).
