import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { displayPath, getReportsPath, REPORT_CATEGORIES, saveReport, type CallRecord } from '../feedback/store';
import type { McpPolicy } from './policy';

/**
 * Opt-in feedback for `sshya mcp --feedback` / `SSHYA_MCP_FEEDBACK=1`.
 *
 * - Every tool call is timed and sized in memory (last RECENT_CALLS only; no
 *   arguments or output), so a report carries the context that led to it.
 * - Unusually large responses get a short extra content item telling the model
 *   how big the reply was and that it can narrow the call or report it.
 * - `report_issue` saves a report locally; nothing is sent anywhere.
 *
 * None of this is registered when feedback is off, so the default server is
 * unchanged.
 */

const RECENT_CALLS = 20;
const DEFAULT_LARGE_RESPONSE_BYTES = 16 * 1024;

export const largeResponseThreshold = (): number => {
  const value = Number(process.env.SSHYA_MCP_LARGE_RESPONSE?.trim());
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_LARGE_RESPONSE_BYTES;
};

type ToolContent = { type: string; text?: string };
type ToolReply = { content?: ToolContent[]; isError?: boolean };
type AnyHandler = (...args: unknown[]) => unknown;

export class CallLog {
  private readonly calls: CallRecord[] = [];

  push(call: CallRecord): void {
    this.calls.push(call);
    if (this.calls.length > RECENT_CALLS) {
      this.calls.shift();
    }
  }

  recent(): CallRecord[] {
    return this.calls.map(call => ({ ...call }));
  }
}

const replyBytes = (reply: ToolReply): number =>
  (reply.content ?? []).reduce((sum, item) => sum + (typeof item.text === 'string' ? Buffer.byteLength(item.text) : 0), 0);

const firstText = (reply: ToolReply): string =>
  reply.content?.find(item => typeof item.text === 'string')?.text ?? '';

/** ~4 bytes per token is the usual rough estimate for English/JSON text. */
const approxTokens = (bytes: number): number => Math.round(bytes / 4);

const largeResponseNote = (bytes: number): ToolContent => ({
  type: 'text',
  text:
    `sshya note: this reply is ${(bytes / 1024).toFixed(1)} KiB (~${approxTokens(bytes)} tokens). ` +
    'If that was unexpected, narrow the call (see sshya://guide) or call report_issue.',
});

/**
 * Wrap `server.registerTool` so every handler registered afterwards is
 * measured. Must run before the tools are registered.
 */
export const instrumentToolCalls = (server: McpServer, log: CallLog): void => {
  const register = server.registerTool.bind(server) as (name: string, config: unknown, handler: AnyHandler) => unknown;
  const threshold = largeResponseThreshold();

  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, handler) =>
    register(name, config, async (...args: unknown[]) => {
      const started = performance.now();
      // Logged when the call starts so a report filed while it is still
      // running (clients may pipeline requests) shows it as pending.
      const call: CallRecord = { tool: name, at: new Date().toISOString(), ms: 0, bytes: 0, pending: true };
      log.push(call);
      try {
        const reply = (await handler(...args)) as ToolReply;
        const bytes = replyBytes(reply);
        const text = firstText(reply);
        const errorKind = reply.isError ? /"errorKind":"([^"]+)"/.exec(text)?.[1] : undefined;
        delete call.pending;
        Object.assign(call, {
          ms: Math.round(performance.now() - started),
          bytes,
          ...(reply.isError ? { isError: true } : {}),
          ...(errorKind ? { errorKind } : {}),
          ...(/"(?:stdout|stderr)Truncated":true/.test(text) ? { truncated: true } : {}),
        });
        if (bytes >= threshold && name !== 'report_issue' && Array.isArray(reply.content)) {
          return { ...reply, content: [...reply.content, largeResponseNote(bytes)] };
        }
        return reply;
      } catch (err) {
        delete call.pending;
        Object.assign(call, { ms: Math.round(performance.now() - started), isError: true, errorKind: 'exception' });
        throw err;
      }
    });
};

export const FEEDBACK_NOTE =
  'If sshya itself misbehaves (a tool error that looks like a bug, a reply far larger than needed, or a call that did something unexpected), call report_issue; it is saved locally for the user to review.';

export const registerReportTool = async (server: McpServer, policy: McpPolicy, log: CallLog): Promise<void> => {
  const { z } = await import('zod');
  server.registerTool(
    'report_issue',
    {
      description: 'Report a problem with sshya itself; saved locally for the user.',
      inputSchema: {
        category: z.enum(REPORT_CATEGORIES),
        summary: z.string().min(1).max(200),
        details: z.string().max(4000).optional(),
        tool: z.string().max(64).optional(),
      },
    },
    async ({ category, summary, details, tool }) => {
      const client = server.server.getClientVersion();
      const report = saveReport({
        category,
        summary: summary.trim(),
        ...(details?.trim() ? { details: details.trim() } : {}),
        ...(tool?.trim() ? { tool: tool.trim() } : {}),
        ...(client ? { client: { name: client.name, version: client.version } } : {}),
        readOnly: policy.readOnly,
        aliasAllowlist: policy.hasAliasAllowlist,
        // Leave out this report_issue call itself (it is still running).
        recentCalls: log.recent().filter(call => !(call.tool === 'report_issue' && call.pending)),
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, id: report.id, savedTo: displayPath(getReportsPath()) }),
        }],
      };
    },
  );
};
