import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Minimum allowed refresh interval, to avoid hammering the endpoint. */
const FLOOR_SECONDS = 30;

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
}

let statusItem: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;
let lastGood: Usage | undefined;

export function activate(context: vscode.ExtensionContext) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'claudeUsage.refresh';
  statusItem.text = '$(sync~spin) usage';
  statusItem.show();
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeUsage.refresh', () => refresh(context)),
    vscode.commands.registerCommand('claudeUsage.setInterval', () => promptInterval()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeUsage')) {
        scheduleTimer(context);
        refresh(context);
      }
    })
  );

  refresh(context);
  scheduleTimer(context);
}

export function deactivate() {
  if (timer) {
    clearInterval(timer);
  }
}

function config() {
  return vscode.workspace.getConfiguration('claudeUsage');
}

function scheduleTimer(context: vscode.ExtensionContext) {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  const raw = config().get<number>('refreshIntervalSeconds', 90);
  if (raw <= 0) {
    return; // manual refresh only
  }
  const seconds = Math.max(raw, FLOOR_SECONDS);
  timer = setInterval(() => refresh(context), seconds * 1000);
}

/** Resolve the core binary: explicit config first, else the bundled bin/. */
function resolveCorePath(context: vscode.ExtensionContext): string {
  const configured = config().get<string>('corePath', '').trim();
  if (configured) {
    return configured;
  }
  const binName = process.platform === 'win32' ? 'usage-core.exe' : 'usage-core';
  return context.asAbsolutePath(path.join('bin', binName));
}

function refresh(context: vscode.ExtensionContext): void {
  const corePath = resolveCorePath(context);
  if (!fs.existsSync(corePath)) {
    statusItem.text = '$(error) usage';
    statusItem.tooltip = `Claude usage core not found at:\n${corePath}\n\nSet "claudeUsage.corePath" or bundle the binary in bin/.`;
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    return;
  }

  execFile(corePath, { timeout: 12000 }, (err, stdout) => {
    if (err && !stdout) {
      renderError(`failed to run core: ${err.message}`);
      return;
    }
    let usage: Usage;
    try {
      usage = JSON.parse(stdout) as Usage;
    } catch (e) {
      renderError(`bad core output: ${String(e)}`);
      return;
    }
    render(usage);
  });
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
  const label = config().get<string>('label', 'Claude').trim();
  const prefix = label ? `$(pulse) ${label}` : '$(pulse)';
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
  statusItem.text = `$(history) ${five.utilization}%`;
  statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  statusItem.tooltip = buildTooltip(usage, true, error);
}

function renderError(message: string): void {
  statusItem.text = '$(warning) usage';
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
  lines.push('Click to refresh now.');
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
    { label: '30 seconds', description: 'floor' },
    { label: '60 seconds' },
    { label: '90 seconds', description: 'default' },
    { label: '5 minutes' },
    { label: 'Manual only (0)' }
  ];
  const map: Record<string, number> = {
    '30 seconds': 30,
    '60 seconds': 60,
    '90 seconds': 90,
    '5 minutes': 300,
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
