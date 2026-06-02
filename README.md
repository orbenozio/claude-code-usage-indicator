# claude-code-usage-indicator

An always-visible indicator for your Claude usage — the same data the `/usage` slash
command shows (5‑hour rolling rate‑limit window, weekly window, and reset times) — so you
never have to type `/usage` again.

Planned to work across multiple hosts and platforms from day one:

- **VS Code** — Claude Code panel (status bar first, then an optional indicator next to the `+` button).
- **JetBrains** (Rider / IntelliJ) — native status‑bar widget.
- **Claude Desktop** (Windows & macOS) — a small tray / menu‑bar app.

## Architecture

A single shared **core** (Go binary, one per OS/arch) does all the sensitive work, with thin
per‑host UI **adapters** that only render a number.

```
~/.claude/.credentials.json (Win/Linux)            ┌──────────────────────────┐
macOS Keychain (to verify)        ──── read‑only ──▶│  usage-core (Go)         │
                                                    │  • read accessToken      │
api.anthropic.com/api/oauth/usage ◀── Bearer ───────│  • GET usage endpoint    │
                                                    │  • normalize → JSON      │
                                                    └─────────────┬────────────┘
                                                      --json / --serve
                        ┌───────────────────────┬───────────────────┬───────────────────┐
                        ▼                       ▼                   ▼
                  VS Code adapter        JetBrains adapter     Desktop tray app
```

### Safety rule (non‑negotiable)

The access token is the **same** token Claude Code itself uses. The core is **read‑only** on
credentials: it reads `accessToken`, **never** refreshes or rewrites them. If the token is
expired it degrades gracefully ("open Claude Code to refresh") instead of rotating it — which
would break Claude Code's own auth.

## Roadmap

- **Phase 0** — Validation spike: confirm the endpoint + headers work with the file token, read‑only, and freeze the response schema.
- **Phase 1** — Core + VS Code status bar (the MVP).
- **Phase 2** — VS Code: optional indicator injected next to the `+` button.
- **Phase 3** — JetBrains status‑bar widget.
- **Phase 4** — Optional shared daemon (one fetch/cache across hosts).
- **Phase 5** — Desktop tray app (Win + Mac); experimental in‑app injector behind disclaimers.

## Configuration

- **Refresh interval** — how often the indicator re-checks usage is user‑configurable per host
  (e.g. `refreshIntervalSeconds`), with a sensible default (~90 s) and a **minimum floor**
  (~30–60 s) to avoid hammering the endpoint and burning rate limit. `0` = manual refresh only.
- **Instant change** — like the RTL extension's YOLO countdown, the interval can be changed on
  the fly (right‑click / click menu on the indicator) without reloading the window; the setting
  is only the initial default.
- Scheduling lives in each **adapter**; the **core** only performs a single fetch when asked.

## Status

Pre‑Phase‑0. Validating the official usage endpoint before writing the core.

## License

TBD.
