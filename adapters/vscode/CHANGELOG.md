# Changelog

## 0.1.6

- **Fix repeated HTTP 429 with multiple windows open.** All VS Code windows now share one cached
  result (per machine) and only one window calls the endpoint per interval, guarded by a
  cross-window lock and polling jitter. Many open windows no longer compound into a permanent
  rate-limit.

## 0.1.5

- Polished the extension page: badges, a richer Features list, a Resources section, and a gallery
  banner. No functional changes.

## 0.1.4

- New `claudeUsage.showReset` option (and a menu toggle) to show the time until the 5-hour window
  resets right in the status bar.
- Don't show a dangling "resets" with no time when the account doesn't report a reset time
  (e.g. some enterprise accounts).

## 0.1.3

- **macOS:** read the token from the Keychain (`Claude Code-credentials`) when
  `~/.claude/.credentials.json` is absent — which is the default on macOS. You may be prompted to
  allow Keychain access the first time.

## 0.1.2

- Fix **macOS/Linux**: the core binary unpacked from the `.vsix` lost its execute bit, so it
  failed to run with `EACCES`. The extension now restores the execute permission before spawning.

## 0.1.1

- Add an extension icon and bundle the README so the Extensions page shows details and features.
- No functional changes to the indicator.

## 0.1.0

First release.

- 5-hour usage percentage in the VS Code status bar; hover for 5-hour + weekly windows with
  reset countdowns in days/hours/minutes.
- Click opens an options menu (refresh, set interval, show/hide weekly, set label, open settings).
- Automatic back-off that honors the endpoint's `Retry-After` on HTTP 429.
- Read-only handling of the Claude OAuth token. Prebuilt core binaries for Windows, macOS, and
  Linux (x64 + arm64) bundled in the `.vsix`.
