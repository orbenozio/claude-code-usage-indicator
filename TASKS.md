# TASKS

מסמך מעקב משימות חי. סמן `[x]` כשמשימה הושלמה; הוסף משימות חדשות מתחת תוך כדי עבודה.

## Done
- [x] Phase 0 — אימות ה-usage endpoint מול token אמיתי (HTTP 200, קריאה-בלבד, ללא rotation)
- [x] `setup_project` — קישור ל-Agents hub המרכזי (junctions ל-commands/docs, skills ריק, TASKS.md)
- [x] יצירת סוכן-משנה `architect` + כלל workflow ב-CLAUDE.md הגלובלי
- [x] הקפאת ה-response schema ב-`docs/usage-endpoint.md` (תוצר Phase 0)
- [x] התקנת toolchains (winget — Go 1.26.3, Node.js 24.16 LTS)
- [x] Phase 1: core ב-Go (`core/`) — קריאת token, GET usage, נרמול ל-JSON; נבנה ואומת מול usage אמיתי
- [x] Phase 1: adapter ל-VS Code (`adapters/vscode/`) — status bar, tooltip מפורט, רענון בלחיצה
- [x] Adapter: מרווח רענון ניתן-להגדרה (`refreshIntervalSeconds`) + floor, תווית ניתנת-להגדרה (`label`)
- [x] Tooltip: שורות נפרדות + countdown בפורמט ימים/שעות/דקות
- [x] אימות מקצה-לקצה ב-VS Code (F5) — האינדיקטור מציג usage חי ✅
- [x] עדכון README ל-Phase 1
- [x] שכתוב README לידידותי-למשתמש + הוספת LICENSE (MIT)
- [x] פרסום ל-GitHub (public): https://github.com/orbenozio/claude-code-usage-indicator
- [x] החלטה: האינדיקטור נשאר בשורת הסטטוס — בלי הזרקה לפאנל של Claude Code
- [x] core מרובה-פלטפורמות (`scripts/build-core.ps1`) + בחירה לפי `process.platform`/`arch`
- [x] תפריט QuickPick בלחיצה על האינדיקטור (refresh, interval, weekly, label, settings)
- [x] טיפול ב-HTTP 429: backoff מעריכי שמכבד `Retry-After` + ברירות מחדל שפויות (5 דק', floor 60 שנ')
- [x] תיקון: ה-label מופיע בכל המצבים (כולל stale/429)
- [x] אריזת `.vsix` + **GitHub Release v0.1.0** עם ה-vsix מצורף

## Todo (הבא בתור)
- [ ] (אופציונלי) פרסום ל-VS Code Marketplace — דורש publisher + PAT מ-Azure DevOps
- [ ] אימות מקצה-לקצה ב-macOS/Linux (הבינאריות ארוזות אך לא נבדקו)

## Backlog (שלבים הבאים)
- [ ] Phase 3 — JetBrains status-bar widget
- [ ] Phase 4 — daemon משותף (fetch/cache אחד לכל המארחים)
- [ ] Phase 5 — אפליקציית tray לדסקטופ (Win + Mac)
- [ ] אימות אחסון ה-token ב-macOS (Keychain)
