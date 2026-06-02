# Claude Code Usage Indicator

An always-visible indicator of your Claude usage, right in the VS Code status bar — the same
data the `/usage` slash command shows (the 5-hour rolling rate-limit window, the weekly window,
and when they reset) — so you never have to stop and type `/usage` again.

```
 …  Go Live   Ln 12, Col 4   Spaces: 2   UTF-8   ⟁ Claude 87%
                                                  └─ click for options, hover for details
```

## Features

- **5-hour window at a glance** — your current rate-limit usage as a live percentage in the status bar.
- **Rich tooltip** — hover to see both the 5-hour and weekly windows, each with a reset countdown
  in days / hours / minutes.
- **Click for an options menu** — refresh, change refresh interval, show/hide the weekly window,
  set the label, or open settings.
- **Polls politely** — conservative default interval plus automatic back-off that honors the
  endpoint's `Retry-After` if it rate-limits (HTTP 429).
- **Read-only & safe** — it only *reads* your existing Claude credentials; it never modifies,
  refreshes, or transmits them anywhere except to Anthropic's own usage endpoint (the same one
  Claude Code uses).

## Requirements

- **VS Code** 1.85 or newer.
- **Claude Code** installed and **logged in** at least once on this machine — the indicator reads
  the OAuth token Claude Code stores in `~/.claude/.credentials.json` (Windows/Linux) or the
  **macOS Keychain** (`Claude Code-credentials`). On macOS you may be prompted once to allow
  Keychain access. If you've never logged in, or the token has expired, the indicator says so and
  asks you to open Claude Code.

> You do **not** need Go, Node, or any other toolchain to use the extension — it ships ready to run.

## Installation

1. Download the latest `claude-code-usage-indicator-<version>.vsix` from the
   [**Releases**](https://github.com/orbenozio/claude-code-usage-indicator/releases) page.
2. In VS Code: open the **Extensions** view → `…` menu → **Install from VSIX…** → pick the file.
   (Or from a terminal: `code --install-extension claude-code-usage-indicator-<version>.vsix`.)
3. Reload the window. The indicator appears at the bottom-right of the status bar.

> Verified on **Windows**. The `.vsix` also bundles prebuilt core binaries for macOS and Linux
> (x64 + arm64), but those are not yet verified end-to-end — feedback welcome.

## Usage

The indicator sits at the bottom-right of the status bar:

- **Hover** — full breakdown of the 5-hour and weekly windows and their reset times.
- **Click** — open the options menu (refresh, set interval, show/hide weekly, set label, settings).
- **Command Palette** (`Ctrl/Cmd+Shift+P`): `Claude Usage: Open menu`, `Claude Usage: Refresh now`,
  `Claude Usage: Set refresh interval`.

## Configuration

Settings (search "Claude Usage" in VS Code settings):

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeUsage.refreshIntervalSeconds` | `300` | How often to re-check usage. The endpoint enforces its own cooldown, so values below the floor (60 s) are raised to it; on HTTP 429 the extension backs off and honors `Retry-After`. `0` = manual refresh only. |
| `claudeUsage.label` | `"Claude"` | Short text before the percentage (e.g. `Claude Code usage`, or empty for just the number). |
| `claudeUsage.showWeekly` | `false` | Also show the weekly (7-day) window percentage in the status bar, not just the 5-hour one. |
| `claudeUsage.showReset` | `false` | Also show the time until the 5-hour window resets (e.g. `· 2h 12m`). Hidden automatically when the account doesn't report a reset time. |
| `claudeUsage.corePath` | `""` | Absolute path to a `usage-core` binary. Leave empty to use the bundled one. |

The refresh interval can be changed on the fly from the click menu — no window reload needed.

## How it works

A small shared **core** (a Go binary, prebuilt per OS/arch) does all the sensitive work; a thin
**VS Code adapter** (TypeScript) just spawns it and renders the result. The same core is meant to
be reused by future hosts (JetBrains, a desktop tray) behind their own thin adapters.

```
~/.claude/.credentials.json ──── read-only ──▶  usage-core (Go)
                                                 • read accessToken
api.anthropic.com/api/oauth/usage ◀── Bearer ──  • GET usage endpoint
                                                 • normalize → JSON
                                                        │
                                          VS Code adapter renders it in the status bar
```

**Safety.** The access token is the **same** one Claude Code uses. The core is strictly read-only
on your credentials: it reads `accessToken` and never refreshes or rewrites the file. If the token
is expired it degrades gracefully ("open Claude Code to refresh") rather than rotating it — which
would break Claude Code's own auth. The token is sent only to Anthropic's official usage endpoint.
The exact request/response is documented in [`docs/usage-endpoint.md`](docs/usage-endpoint.md).

## Roadmap

- [x] Validate the usage endpoint and freeze the response schema.
- [x] Go core + VS Code status-bar indicator (the MVP) — released as **v0.1.0**.
- [ ] Verify macOS / Linux end-to-end.
- [ ] Publish to the VS Code Marketplace (currently distributed as a `.vsix` via Releases).
- [ ] JetBrains (Rider / IntelliJ) status-bar widget reusing the same core.
- [ ] Optional shared daemon — one fetch/cache shared across hosts.
- [ ] Claude Desktop tray app (Windows & macOS).

The indicator intentionally lives in the **host's status bar**, not injected into the Claude Code panel.

## Development

You only need these to *build* the project — not to use it.

- [Go](https://go.dev/dl/) 1.23+ (compiles the core) and [Node.js](https://nodejs.org/) 18+ (compiles the extension).

```bash
# Build the core for your machine and make it available to the extension
cd core
go build -o ../adapters/vscode/bin/usage-core.exe .   # drop the .exe on macOS/Linux

# Build the extension, then press F5 in VS Code to launch an Extension Development Host
cd ../adapters/vscode
npm install
npm run compile
```

To produce binaries for **all** platforms at once, run `scripts/build-core.ps1` (outputs
`usage-core-<platform>-<arch>` into the adapter's `bin/`). Package a `.vsix` with
[`vsce`](https://github.com/microsoft/vscode-vsce): `npx @vscode/vsce package`.

Issues and PRs welcome. The core and adapter are deliberately decoupled, so adding a new host means
writing a thin adapter against the same `usage-core` JSON contract — no need to touch the
credential/endpoint logic.

## License

MIT — see [LICENSE](LICENSE).
