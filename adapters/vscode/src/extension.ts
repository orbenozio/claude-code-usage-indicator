import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Minimum allowed refresh interval. The usage endpoint enforces its own
 * cooldown (~2-3 min observed via Retry-After), so we keep the floor generous. */
const FLOOR_SECONDS = 60;

/** Normalized shape emitted by usage-core (see docs/usage-endpoint.md). */
interface Window {
  utilization: number;
  resets_at: string;
}
interface Usage {
  five_hour: Window | null;
  seven_day: Window | null;
  extra_usage: { enabled: boolean };
  fetched_at: string;
  stale: boolean;
  error?: string;
  retry_after?: number; // seconds; set by the core on HTTP 429
}

/** Cap on exponential backoff between polls after repeated failures. */
const MAX_BACKOFF_MS = 15 * 60 * 1000;

let statusItem: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;
let uiTimer: NodeJS.Timeout | undefined; // repaints relative times without re-fetching
let lastGood: Usage | undefined;
let displayed: { usage: Usage; stale: boolean; error?: string } | undefined;
let backoff = 0;            // consecutive failures
let lastRetryAfterMs = 0;   // honored when the endpoint sends Retry-After

export function activate(context: vscode.ExtensionContext) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'claudeUsage.menu';
  statusItem.text = '$(sync~spin) usage';
  statusItem.show();
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeUsage.menu', () => showMenu(context)),
    vscode.commands.registerCommand('claudeUsage.refresh', () => forceRefresh(context)),
    vscode.commands.registerCommand('claudeUsage.setInterval', () => promptInterval()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeUsage')) {
        startLoop(context);
      }
    })
  );

  startLoop(context);
  // Repaint the visible text every 30 s so relative times ("3m ago") and reset
  // countdowns stay current between network refreshes. No fetching here.
  uiTimer = setInterval(repaint, 30000);
}

export function deactivate() {
  if (timer) {
    clearTimeout(timer);
  }
  if (uiTimer) {
    clearInterval(uiTimer);
  }
}

/** Re-render the last shown usage from memory (no network), keeping relative
 * times and countdowns fresh. */
function repaint(): void {
  if (!displayed) {
    return;
  }
  if (displayed.stale) {
    renderStale(displayed.usage, displayed.error);
  } else {
    render(displayed.usage);
  }
}

function config() {
  return vscode.workspace.getConfiguration('claudeUsage');
}

/** Base poll interval in ms, honoring the floor. 0 means manual-only. */
function baseIntervalMs(): number {
  const raw = config().get<number>('refreshIntervalSeconds', 90);
  if (raw <= 0) {
    return 0;
  }
  return Math.max(raw, FLOOR_SECONDS) * 1000;
}

/** (Re)start the poll loop: clear backoff, fetch now, then keep ticking. */
function startLoop(context: vscode.ExtensionContext) {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  backoff = 0;
  lastRetryAfterMs = 0;
  tick(context);
}

const CACHE_NAME = 'usage-cache.json';
/** How long a "fetch in progress" claim is honored before another window may try. */
const FETCH_LOCK_MS = 25000;

interface CacheFile {
  usage?: Usage;
  fetchedAt?: number;      // ms — when the cached usage was fetched
  fetchStartedAt?: number; // ms — when some window last began a network fetch (stampede lock)
}

/** Shared across all VS Code windows of this machine (per-extension global storage). */
function cachePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, CACHE_NAME);
}

function readCache(context: vscode.ExtensionContext): CacheFile {
  try {
    return JSON.parse(fs.readFileSync(cachePath(context), 'utf8')) as CacheFile;
  } catch {
    return {};
  }
}

function writeCache(context: vscode.ExtensionContext, patch: CacheFile): void {
  try {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    const merged = { ...readCache(context), ...patch };
    const tmp = cachePath(context) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(merged));
    fs.renameSync(tmp, cachePath(context)); // atomic-ish swap so readers never see a partial file
  } catch {
    /* cache is best-effort */
  }
}

/** ±15% jitter so multiple windows don't align their polls. */
function jitter(ms: number): number {
  return Math.max(1000, Math.round(ms * (0.85 + Math.random() * 0.3)));
}

function scheduleAfter(context: vscode.ExtensionContext, delay: number): void {
  timer = setTimeout(() => tick(context), delay);
}

/** One cycle. To avoid N windows hammering the endpoint (HTTP 429), windows
 * share a cache: a fresh cache is rendered without any network call, and only
 * one window fetches per interval (guarded by a cross-window lock). */
function tick(context: vscode.ExtensionContext): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  const base = baseIntervalMs();
  const now = Date.now();
  const cache = readCache(context);

  // 1) Fresh shared cache → render it, no network call.
  if (cache.usage && cache.fetchedAt && base > 0 && now - cache.fetchedAt < base) {
    render(cache.usage);
    backoff = 0;
    scheduleAfter(context, jitter(base - (now - cache.fetchedAt) + 1000));
    return;
  }

  // 2) Another window is fetching right now → show cache, re-check shortly.
  if (cache.fetchStartedAt && now - cache.fetchStartedAt < FETCH_LOCK_MS) {
    if (cache.usage) {
      render(cache.usage);
    }
    scheduleAfter(context, jitter(FETCH_LOCK_MS));
    return;
  }

  // 3) No fresh cache and nobody else fetching -> we fetch.
  fetchAndCache(context);
}

/** Manual "Refresh now": always do a real fetch, bypassing the shared cache, so
 * the displayed value and its timestamp actually update. Then resume the loop. */
function forceRefresh(context: vscode.ExtensionContext): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  backoff = 0;
  lastRetryAfterMs = 0;
  fetchAndCache(context);
}

/** Claim the cross-window lock, run the core, cache a good result, reschedule. */
function fetchAndCache(context: vscode.ExtensionContext): void {
  writeCache(context, { fetchStartedAt: Date.now() });
  fetchOnce(context, (ok, usage) => {
    if (ok && usage) {
      writeCache(context, { usage, fetchedAt: Date.now(), fetchStartedAt: 0 });
    } else {
      writeCache(context, { fetchStartedAt: 0 }); // release lock, keep last good cache
    }
    const base = baseIntervalMs();
    if (base <= 0) {
      return; // manual-only: don't auto-reschedule
    }
    let delay: number;
    if (ok) {
      backoff = 0;
      delay = base;
    } else {
      backoff = Math.min(backoff + 1, 6);
      delay = Math.min(base * Math.pow(2, backoff), MAX_BACKOFF_MS);
      if (lastRetryAfterMs > delay) {
        delay = Math.min(lastRetryAfterMs, MAX_BACKOFF_MS);
      }
    }
    scheduleAfter(context, jitter(delay));
  });
}

/** Resolve the core binary: explicit config first, then the bundled per-platform
 * binary (usage-core-<platform>-<arch>[.exe]), then a generic dev fallback. */
function resolveCorePath(context: vscode.ExtensionContext): string {
  const configured = config().get<string>('corePath', '').trim();
  if (configured) {
    return configured;
  }
  const ext = process.platform === 'win32' ? '.exe' : '';
  const specific = context.asAbsolutePath(
    path.join('bin', `usage-core-${process.platform}-${process.arch}${ext}`)
  );
  if (fs.existsSync(specific)) {
    return specific;
  }
  // Dev fallback: a single locally-built binary named generically.
  return context.asAbsolutePath(path.join('bin', `usage-core${ext}`));
}

/** On macOS/Linux the binary unpacked from the .vsix loses its execute bit
 * (Windows has no such concept when packaging), so spawn fails with EACCES.
 * Restore it before running. Best-effort; a real failure surfaces on spawn. */
function ensureExecutable(corePath: string): void {
  if (process.platform === 'win32') {
    return;
  }
  try {
    fs.chmodSync(corePath, 0o755);
  } catch {
    /* ignore — execFile will report a clear error if it still can't run */
  }
}

/** Run the core once, render the result, and report success + the parsed usage. */
function fetchOnce(
  context: vscode.ExtensionContext,
  done: (ok: boolean, usage?: Usage) => void
): void {
  const corePath = resolveCorePath(context);
  if (!fs.existsSync(corePath)) {
    statusItem.text = '$(error) usage';
    statusItem.tooltip = `Claude usage core not found at:\n${corePath}\n\nSet "claudeUsage.corePath" or bundle the binary in bin/.`;
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    lastRetryAfterMs = 0;
    done(false);
    return;
  }

  ensureExecutable(corePath);
  execFile(corePath, { timeout: 12000 }, (err, stdout) => {
    if (err && !stdout) {
      renderError(`failed to run core: ${err.message}`);
      lastRetryAfterMs = 0;
      done(false);
      return;
    }
    let usage: Usage;
    try {
      usage = JSON.parse(stdout) as Usage;
    } catch (e) {
      renderError(`bad core output: ${String(e)}`);
      lastRetryAfterMs = 0;
      done(false);
      return;
    }
    lastRetryAfterMs = (usage.retry_after ?? 0) * 1000;
    const ok = !usage.error && !!usage.five_hour;
    render(usage);
    done(ok, usage);
  });
}

/** "$(icon) Label" prefix for the status bar, honoring the configured label. */
function statusPrefix(icon: string): string {
  const label = config().get<string>('label', 'Claude').trim();
  return label ? `$(${icon}) ${label}` : `$(${icon})`;
}

function render(usage: Usage): void {
  if (usage.error || !usage.five_hour) {
    // Degrade gracefully: show last known value muted if we have one.
    if (lastGood && lastGood.five_hour) {
      renderStale(lastGood, usage.error);
    } else {
      renderError(usage.error ?? 'no usage data');
    }
    return;
  }

  lastGood = usage;
  displayed = { usage, stale: false };

  const five = usage.five_hour;
  const weekly = config().get<boolean>('showWeekly', false) ? usage.seven_day : null;
  const reset = config().get<boolean>('showReset', false) ? durationParts(five.resets_at) : null;

  // Keep the 5-hour window and its reset time together; a clock icon ties them
  // so the time is clearly the 5h reset and not part of the weekly readout.
  let fiveText = `${weekly ? '5h ' : ''}${five.utilization}%`;
  if (reset && !reset.ago) {
    fiveText += ` $(watch) ${reset.span}`;
  }
  let text = `${statusPrefix('pulse')} ${fiveText}`;
  if (weekly) {
    text += ` · 7d ${weekly.utilization}%`;
  }
  statusItem.text = text;

  // Warn as you approach the cap (orange ≥ 90%, red when maxed).
  const peak = Math.max(five.utilization, weekly ? weekly.utilization : 0);
  if (peak >= 100) {
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (peak >= 90) {
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    statusItem.backgroundColor = undefined;
  }
  statusItem.tooltip = buildTooltip(usage, false);
}

function renderStale(usage: Usage, error?: string): void {
  displayed = { usage, stale: true, error };
  const five = usage.five_hour!;
  statusItem.text = `${statusPrefix('history')} ${five.utilization}%`;
  statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  statusItem.tooltip = buildTooltip(usage, true, error);
}

function renderError(message: string): void {
  displayed = undefined; // static message, nothing time-relative to repaint
  const label = config().get<string>('label', 'Claude').trim();
  statusItem.text = label ? `$(warning) ${label}` : '$(warning) usage';
  statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  statusItem.tooltip = `Claude usage unavailable:\n${message}\n\nOpen Claude Code to refresh the token if it expired.`;
}

function buildTooltip(usage: Usage, stale: boolean, error?: string): vscode.MarkdownString {
  // Each entry becomes its own line. VS Code renders the tooltip as Markdown,
  // where a single "\n" is a soft wrap (same line) — so join with "\n\n" to
  // force each item onto a separate line.
  const lines: string[] = ['**Claude usage**'];
  if (usage.five_hour) {
    lines.push(`5-hour window: **${usage.five_hour.utilization}%**${resetClause(usage.five_hour.resets_at)}`);
  }
  if (usage.seven_day) {
    lines.push(`Weekly window: **${usage.seven_day.utilization}%**${resetClause(usage.seven_day.resets_at)}`);
  }
  if (stale) {
    lines.push(`_Showing last known value (updated ${agoText(usage.fetched_at)})${error ? ` - ${error}` : ''}._`);
  } else {
    lines.push(`_Updated ${agoText(usage.fetched_at)}._`);
  }
  lines.push('Click for options (refresh, interval, ...).');
  const md = new vscode.MarkdownString(lines.join('\n\n'));
  md.isTrusted = false;
  return md;
}

/** Parse a reset timestamp into a compact span ("2h 12m") + direction, or null
 * if it's missing/invalid (e.g. enterprise accounts may omit the reset time). */
function durationParts(iso: string): { span: string; ago: boolean } | null {
  if (!iso) {
    return null;
  }
  const target = new Date(iso).getTime();
  if (isNaN(target)) {
    return null;
  }
  const diffMs = target - Date.now();
  const ago = diffMs < 0;
  const totalMins = Math.round(Math.abs(diffMs) / 60000);
  const days = Math.floor(totalMins / 1440);
  const hrs = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hrs > 0) {
    parts.push(`${hrs}h`);
  }
  parts.push(`${mins}m`);
  return { span: parts.join(' '), ago };
}

/** Human-friendly relative time, e.g. "in 2h 12m" or "12m ago". */
function untilReset(iso: string): string {
  const d = durationParts(iso);
  if (!d) {
    return iso;
  }
  return d.ago ? `${d.span} ago` : `in ${d.span}`;
}

/** " — resets in 2h 12m" when a valid reset time exists, otherwise "". */
function resetClause(iso: string): string {
  return durationParts(iso) ? ` — resets ${untilReset(iso)}` : '';
}

/** Relative age of a timestamp for the tooltip, e.g. "just now" or "3m ago".
 * The UI is repainted every ~30 s so this stays current between refreshes. */
function agoText(iso: string): string {
  const d = durationParts(iso);
  if (!d) {
    return iso;
  }
  return d.span === '0m' ? 'just now' : `${d.span} ago`;
}

async function promptInterval(): Promise<void> {
  const current = config().get<number>('refreshIntervalSeconds', 90);
  const picks: vscode.QuickPickItem[] = [
    { label: '1 minute', description: 'floor' },
    { label: '2 minutes' },
    { label: '5 minutes', description: 'default' },
    { label: '10 minutes' },
    { label: 'Manual only (0)' }
  ];
  const map: Record<string, number> = {
    '1 minute': 60,
    '2 minutes': 120,
    '5 minutes': 300,
    '10 minutes': 600,
    'Manual only (0)': 0
  };
  const chosen = await vscode.window.showQuickPick(picks, {
    placeHolder: `Refresh interval (current: ${current}s)`
  });
  if (!chosen) {
    return;
  }
  await config().update('refreshIntervalSeconds', map[chosen.label], vscode.ConfigurationTarget.Global);
}

/** Options menu opened by clicking the status-bar indicator. */
type MenuItem = vscode.QuickPickItem & { run: () => void | Thenable<void> };

async function showMenu(context: vscode.ExtensionContext): Promise<void> {
  const cfg = config();
  const weekly = cfg.get<boolean>('showWeekly', false);
  const showReset = cfg.get<boolean>('showReset', false);
  const interval = cfg.get<number>('refreshIntervalSeconds', 90);
  const label = cfg.get<string>('label', 'Claude');

  const items: MenuItem[] = [
    {
      label: '$(sync) Refresh now',
      run: () => forceRefresh(context)
    },
    {
      label: '$(clock) Set refresh interval…',
      description: interval > 0 ? `${interval}s` : 'manual',
      run: () => promptInterval()
    },
    {
      label: `$(eye) ${weekly ? 'Hide' : 'Show'} weekly window`,
      description: weekly ? 'on' : 'off',
      run: () => cfg.update('showWeekly', !weekly, vscode.ConfigurationTarget.Global)
    },
    {
      label: `$(history) ${showReset ? 'Hide' : 'Show'} reset time`,
      description: showReset ? 'on' : 'off',
      run: () => cfg.update('showReset', !showReset, vscode.ConfigurationTarget.Global)
    },
    {
      label: '$(tag) Set label…',
      description: label || '(none)',
      run: () => promptLabel()
    },
    {
      label: '$(gear) Open settings',
      run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'claudeUsage')
    }
  ];

  const chosen = await vscode.window.showQuickPick(items, {
    placeHolder: 'Claude Usage — choose an action'
  });
  if (chosen) {
    await chosen.run();
  }
}

async function promptLabel(): Promise<void> {
  const current = config().get<string>('label', 'Claude');
  const value = await vscode.window.showInputBox({
    title: 'Claude Usage status-bar label',
    prompt: 'Text shown before the percentage (leave empty for just the number).',
    value: current
  });
  if (value === undefined) {
    return; // cancelled
  }
  await config().update('label', value, vscode.ConfigurationTarget.Global);
}
