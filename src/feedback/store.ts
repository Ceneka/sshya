import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pkg from '../../package.json' with { type: 'json' };
import { getDbPath } from '../database';

/**
 * Opt-in problem reports written by agents through the MCP `report_issue` tool
 * (`sshya mcp --feedback`). Reports never leave the machine on their own: they
 * are appended to `reports.jsonl` next to the store, and the user reviews them
 * with `sshya reports` and decides whether to open a prefilled GitHub issue.
 */

export const REPORT_CATEGORIES = [
  'error',
  'large_output',
  'unexpected_call',
  'bad_result',
  'missing_feature',
  'other',
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/** Metadata about one MCP tool call. Arguments and output are never stored. */
export interface CallRecord {
  tool: string;
  at: string;
  ms: number;
  bytes: number;
  isError?: boolean;
  errorKind?: string;
  truncated?: boolean;
  /** Still running when the report was filed. */
  pending?: boolean;
}

export interface Report {
  id: string;
  createdAt: string;
  version: string;
  category: ReportCategory;
  summary: string;
  details?: string;
  tool?: string;
  client?: { name: string; version?: string };
  readOnly?: boolean;
  aliasAllowlist?: boolean;
  platform: string;
  node: string;
  recentCalls: CallRecord[];
}

export type NewReport = Omit<Report, 'id' | 'createdAt' | 'version' | 'platform' | 'node'>;

export const getReportsPath = (): string => path.join(path.dirname(getDbPath()), 'reports.jsonl');

export const saveReport = (input: NewReport): Report => {
  const report: Report = {
    id: crypto.randomBytes(4).toString('hex'),
    createdAt: new Date().toISOString(),
    version: pkg.version,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    ...input,
  };
  const file = getReportsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(report)}\n`, { mode: 0o600 });
  return report;
};

export const readReports = (): Report[] => {
  let text: string;
  try {
    text = fs.readFileSync(getReportsPath(), 'utf8');
  } catch {
    return [];
  }
  const reports: Report[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Report;
      if (parsed && typeof parsed.id === 'string') {
        reports.push(parsed);
      }
    } catch {
      // A torn or hand-edited line must not hide the other reports.
    }
  }
  return reports;
};

export const findReport = (id: string): Report | undefined => {
  const wanted = id.trim().toLowerCase();
  const reports = readReports();
  return reports.find(r => r.id === wanted) ?? reports.find(r => r.id.startsWith(wanted));
};

/** Remove every report, or only the given ids. Returns how many were removed. */
export const clearReports = (ids?: readonly string[]): number => {
  const reports = readReports();
  const keep = ids ? reports.filter(r => !ids.includes(r.id)) : [];
  const removed = reports.length - keep.length;
  if (removed === 0) {
    return 0;
  }
  if (keep.length === 0) {
    fs.rmSync(getReportsPath(), { force: true });
  } else {
    fs.writeFileSync(getReportsPath(), keep.map(r => `${JSON.stringify(r)}\n`).join(''), { mode: 0o600 });
  }
  return removed;
};

const ISSUES_URL = `${pkg.bugs.url.replace(/\/+$/, '')}/new`;
/** Browsers and GitHub reject very long URLs; keep the prefilled body well under that. */
const MAX_BODY_CHARS = 6000;

const formatCall = (call: CallRecord): string => {
  if (call.pending) {
    return `| ${call.tool} | – | – | still running |`;
  }
  const flags = [
    call.isError ? `error${call.errorKind ? `:${call.errorKind}` : ''}` : 'ok',
    ...(call.truncated ? ['truncated'] : []),
  ].join(', ');
  return `| ${call.tool} | ${call.ms} | ${call.bytes} | ${flags} |`;
};

/** Markdown issue body. The user sees and edits it in the browser before submitting. */
export const formatReportMarkdown = (report: Report): string => {
  const lines = [
    `**Category:** ${report.category}`,
    ...(report.tool ? [`**Tool:** ${report.tool}`] : []),
    `**sshya:** ${report.version} · ${report.platform} · Node ${report.node}`,
    ...(report.client ? [`**MCP client:** ${report.client.name}${report.client.version ? ` ${report.client.version}` : ''}`] : []),
    `**Policy:** read-only ${report.readOnly ? 'yes' : 'no'}, alias allowlist ${report.aliasAllowlist ? 'yes' : 'no'}`,
    '',
    '### Summary',
    report.summary,
  ];
  if (report.details) {
    lines.push('', '### Details', report.details);
  }
  if (report.recentCalls.length > 0) {
    lines.push(
      '',
      '### Recent tool calls (oldest first; no arguments or output)',
      '| tool | ms | bytes | result |',
      '| --- | ---: | ---: | --- |',
      ...report.recentCalls.map(formatCall),
    );
  }
  lines.push('', `_Reported by an agent via sshya \`report_issue\` (id ${report.id})._`);
  return lines.join('\n');
};

export const buildIssueUrl = (report: Report): string => {
  let body = formatReportMarkdown(report);
  if (body.length > MAX_BODY_CHARS) {
    body = `${body.slice(0, MAX_BODY_CHARS)}\n\n_…truncated; run \`sshya reports show ${report.id}\` for the full report._`;
  }
  const params = new URLSearchParams({ title: `[agent report] ${report.summary}`.slice(0, 200), body });
  return `${ISSUES_URL}?${params.toString()}`;
};

/** Home-relative path for display. */
export const displayPath = (file: string): string => {
  const home = os.homedir();
  return file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
};
