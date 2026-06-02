# Changelog

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
