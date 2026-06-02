# Usage endpoint — frozen schema (Phase 0)

The data behind the `/usage` slash command. Verified read-only against a live token.

## Request

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <accessToken>
anthropic-beta: oauth-2025-04-20
anthropic-version: 2023-06-01
```

- `<accessToken>` comes from `claudeAiOauth.accessToken` in `~/.claude/.credentials.json`
  (Windows/Linux). macOS storage still to be verified (Keychain).
- **Read-only:** the core only reads the token. It never refreshes/rewrites credentials.
  Confirmed: file hash + `accessToken`/`expiresAt` unchanged before vs. after a call.

## Response (HTTP 200)

Example body (values are illustrative):

```json
{
  "five_hour": { "utilization": 83.0, "resets_at": "2026-06-02T08:30:00.701157+00:00" },
  "seven_day": { "utilization": 14.0, "resets_at": "2026-06-04T11:00:00.701180+00:00" },
  "seven_day_oauth_apps": null,
  "seven_day_opus": null,
  "seven_day_sonnet": null,
  "seven_day_cowork": null,
  "seven_day_omelette": null,
  "tangelo": null,
  "iguana_necktie": null,
  "omelette_promotional": null,
  "cinder_cove": null,
  "extra_usage": {
    "is_enabled": false,
    "monthly_limit": null,
    "used_credits": null,
    "utilization": null,
    "currency": null,
    "disabled_reason": null
  }
}
```

### Fields we rely on

| Field | Type | Meaning |
|-------|------|---------|
| `five_hour.utilization` | number (0–100) | % of the 5‑hour rolling rate-limit window used |
| `five_hour.resets_at` | RFC3339 string | when the 5‑hour window resets |
| `seven_day.utilization` | number (0–100) | % of the weekly window used |
| `seven_day.resets_at` | RFC3339 string | when the weekly window resets |
| `extra_usage.*` | object | pay-as-you-go credits (off here); render only when `is_enabled` |

### Notes / unknowns

- The many `null` keys (`seven_day_opus`, `tangelo`, `iguana_necktie`, …) appear to be
  per-segment or feature-flagged buckets that are inactive on this account. Treat **any**
  top-level key as optional: parse defensively, ignore unknown/null keys.
- `utilization` observed as a whole-ish number with a `.0`; parse as float, display rounded.
- `resets_at` carries a numeric offset (`+00:00`); parse as RFC3339.

## Normalized core output

The core flattens the above to a stable shape the adapters render (host-agnostic):

```json
{
  "five_hour":  { "utilization": 83, "resets_at": "2026-06-02T08:30:00Z" },
  "seven_day":  { "utilization": 14, "resets_at": "2026-06-04T11:00:00Z" },
  "extra_usage": { "enabled": false },
  "fetched_at": "2026-06-02T08:05:00Z",
  "stale": false,
  "error": null
}
```

On failure (expired token, network) the core still returns this shape with `error` set and
`stale: true`, so adapters can show a muted last-known value instead of breaking.
