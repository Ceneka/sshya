import { spawn } from 'child_process';
import chalk from '../lib/color';
import {
  buildIssueUrl,
  clearReports,
  displayPath,
  findReport,
  formatReportMarkdown,
  getReportsPath,
  readReports,
} from '../feedback/store';
import { fail, jsonEnabled, printJson } from '../output';

/**
 * `sshya reports`: review problem reports that agents filed through the
 * opt-in MCP `report_issue` tool (`sshya mcp --feedback`).
 */
export const reportsCommand = async (
  action: string | undefined,
  id: string | undefined,
  options: { json?: boolean; open?: boolean },
): Promise<void> => {
  const json = jsonEnabled(options.json);
  const verb = (action ?? 'list').toLowerCase();

  if (verb === 'list' || verb === 'ls') {
    const reports = readReports();
    if (json) {
      printJson(reports.map(({ id: reportId, createdAt, category, summary, tool }) => ({ id: reportId, createdAt, category, summary, ...(tool ? { tool } : {}) })));
      return;
    }
    if (reports.length === 0) {
      console.log(chalk.grey(`No reports. Agents can file them when the MCP server runs with --feedback (${displayPath(getReportsPath())}).`));
      return;
    }
    for (const report of reports) {
      const when = report.createdAt.replace('T', ' ').slice(0, 16);
      console.log(`${chalk.bold(report.id)}  ${chalk.grey(when)}  ${chalk.yellow(report.category.padEnd(15))} ${report.summary}`);
    }
    console.log(chalk.grey(`\n${reports.length} report(s). Show one with "sshya reports show <id>", file it with "sshya reports open <id>".`));
    return;
  }

  if (verb === 'export') {
    printJson(readReports());
    return;
  }

  if (verb === 'clear') {
    const removed = clearReports(id ? [findReport(id)?.id ?? id] : undefined);
    if (json) {
      printJson({ ok: true, removed });
    } else {
      console.log(chalk.green(`Removed ${removed} report(s).`));
    }
    return;
  }

  if (verb === 'show' || verb === 'open') {
    if (!id) {
      fail(`Usage: sshya reports ${verb} <id>`);
    }
    const report = findReport(id!);
    if (!report) {
      fail(`No report with id "${id}". List them with "sshya reports".`);
    }
    if (verb === 'show') {
      if (json) {
        printJson(report);
      } else {
        console.log(formatReportMarkdown(report!));
      }
      return;
    }

    const url = buildIssueUrl(report!);
    if (json) {
      printJson({ ok: true, id: report!.id, url });
      return;
    }
    console.log(chalk.grey('Review the prefilled issue before submitting; nothing is sent until you do.'));
    console.log(url);
    if (options.open) {
      openInBrowser(url);
    }
    return;
  }

  fail(`Unknown action "${action}". Use list, show <id>, open <id> [--open], export, or clear [id].`);
};

const openInBrowser = (url: string): void => {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => console.error(chalk.grey(`Could not run ${command}; open the URL above manually.`)));
    child.unref();
  } catch {
    console.error(chalk.grey(`Could not run ${command}; open the URL above manually.`));
  }
};
