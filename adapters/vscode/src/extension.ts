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
let lastGood: Usage | undefined;
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
    vscode.commands.registerCommand('claudeUsage.refresh', () => startLoop(context)),
    vscode.commands.registerCommand('claudeUsage.setInterval', () => promptInterval()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeUsage')) {
        startLoop(context);
      }
    })
  );

  startLoop(context);
}

export function deactivate() {
  if (timer) {
    clearTimeout(timer);
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

/** One fetch + schedule the next, applying exponential backoff on failure. */
function tick(context: vscode.ExtensionContext) {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  fetchOnce(context, (ok) => {
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
    timer = setTimeout(() => tick(context), delay);
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

/** Run the core once, render the result, and report success/failure. */
function fetchOnce(context: vscode.ExtensionContext, done: (ok: boolean) => void): void {
  const corePath = resolveCorePath(context);
  if (!fs.existsSync(corePath)) {
    statusItem.text = '$(error) usage';
    statusItem.tooltip = `Claude usage core not found at:\n${corePath}\n\nSet "claudeUsage.corePath" or bundle the binary in bin/.`;
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    lastRetryAfterMs = 0;
    done(false);
    return;
  }

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
    done(ok);
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
  statusItem.backgroundColor = undefined;

  const five = usage.five_hour;
  const prefix = statusPrefix('pulse');
  let text = `${prefix} ${five.utilization}%`;
  if (config().get<boolean>('showWeekly', false) && usage.seven_day) {
    text = `${prefix} 5h ${five.utilization}% · 7d ${usage.seven_day.utilization}%`;
  }
  if (five.utilization >= 90) {
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  statusItem.text = text;
  statusItem.tooltip = buildTooltip(usage, false);
}

function renderStale(usage: Usage, error?: string): void {
  const five = usage.five_hour!;
  statusItem.text = `${statusPrefix('history')} ${five.utilization}%`;
  statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  statusItem.tooltip = buildTooltip(usage, true, error);
}

function renderError(message: string): void {
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
    lines.push(`5-hour window: **${usage.five_hour.utilization}%** — resets ${untilReset(usage.five_hour.resets_at)}`);
  }
  if (usage.seven_day) {
    lines.push(`Weekly window: **${usage.seven_day.utilization}%** — resets ${untilReset(usage.seven_day.resets_at)}`);
  }
  if (stale) {
    lines.push(`_Showing last known value${error ? ` (${error})` : ''}._`);
  } else {
    lines.push(`_Updated ${untilReset(usage.fetched_at)}._`);
  }
  lines.push('Click for options (refresh, interval, …).');
  const md = new vscode.MarkdownString(lines.join('\n\n'));
  md.isTrusted = false;
  return md;
}

/** Human-friendly relative time, e.g. "in 2h 12m" or "12m ago". */
function untilReset(iso: string): string {
  const target = new Date(iso).getTime();
  if (isNaN(target)) {
    return iso;
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
  const span = parts.join(' ');
  return ago ? `${span} ago` : `in ${span}`;
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
  const interval = cfg.get<number>('refreshIntervalSeconds', 90);
  const label = cfg.get<string>('label', 'Claude');

  const items: MenuItem[] = [
    {
      label: '$(sync) Refresh now',
      run: () => startLoop(context)
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
