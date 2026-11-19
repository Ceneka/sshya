import { spawn, type StdioOptions } from 'child_process';
import chalk from 'chalk';
import { recordConnectionUsage, type Connection } from '../database';
import { ByteCapture, defaultMaxOutputBytes, type CaptureMode } from '../helpers/capture';
import { controlSocketStat, reuseEnabled } from '../helpers/control';
import { classifySshError, spawnFailure, type SshErrorKind } from '../helpers/errors';
import { resolveAliasForCommand, selectAlias } from '../helpers/selectAlias';
import { buildRemoteCommandLine, buildSshArgs, type HostKeyChecking } from '../helpers/ssh';
import { clampTimeoutMs } from '../helpers/timer';
import { jsonEnabled, printJson } from '../output';

export type OutputMode = 'inherit' | 'capture';

export interface RunOptions {
  /** Allocate a remote TTY. Off by default so commands are script-friendly. */
  tty?: boolean;
  /** Fail instead of prompting for a password. Defaults to true. */
  batchMode?: boolean;
  /** SSH ConnectTimeout in seconds. */
  connectTimeout?: number;
  /** `cd` into the connection's remote_path before running. Defaults to true. */
  cwd?: boolean;
  /** Abort the command after this many milliseconds. */
  timeoutMs?: number;
  /** Reuse a pooled ControlMaster connection. Defaults to true. */
  reuse?: boolean;
  /** First-contact host key policy. */
  hostKeyChecking?: HostKeyChecking;
  /** Cap captured bytes per stream. Defaults to 64 KiB (SSHYA_MAX_OUTPUT). */
  maxOutputBytes?: number;
  /** Keep the start (default) or the end of a truncated stream. */
  outputMode?: CaptureMode;
  /** Bytes to send to the remote command's stdin. */
  stdin?: string | Buffer;
  /** Stream this readable into the remote command's stdin (CLI pipe mode). */
  stdinStream?: NodeJS.ReadableStream;
  /** Force stdin to be ignored, even when a stream is available. */
  noStdin?: boolean;
  json?: boolean;
}

export interface RunResult {
  ok: boolean;
  alias: string;
  command: string;
  remoteCommand: string;
  target: string;
  cwd?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutLines: number;
  stderrLines: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
  /** Effective timeout in milliseconds; null when no timeout was set. */
  timeoutMs: number | null;
  /** True when the call attached to an already-running ControlMaster. */
  reused: boolean;
  errorKind?: SshErrorKind;
  hint?: string;
}

/** Non-interactive CLI calls get this safety net unless `--timeout` overrides it. */
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;

/**
 * Resolve the CLI `run` timeout.
 *
 * An explicit `--timeout <seconds>` always wins (`--timeout 0` disables the
 * timeout). Otherwise JSON mode and non-TTY stdout get a 120 s safety net so an
 * agent cannot hang forever on a stuck remote command.
 */
export const resolveRunTimeoutMs = (
  timeoutSeconds: string | undefined,
  options: { json?: boolean; stdoutIsTTY?: boolean } = {},
): number | undefined => {
  if (timeoutSeconds !== undefined) {
    const seconds = Number(timeoutSeconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return undefined;
    }
    return Math.round(seconds * 1000);
  }

  const json = jsonEnabled(options.json);
  const stdoutIsTTY = options.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  return json || !stdoutIsTTY ? DEFAULT_RUN_TIMEOUT_MS : undefined;
};

const STDERR_CAPTURE_LIMIT = 16 * 1024;

const resolveSshBinary = (): string => process.env.SSHYA_SSH_BIN?.trim() || 'ssh';

/**
 * Run a command over SSH. Capture mode pipes stdout/stderr for JSON/MCP callers;
 * inherit mode streams straight to the terminal.
 */
export const executeSshCommand = (
  connection: Connection,
  command: string,
  options: RunOptions = {},
  mode: OutputMode = 'capture',
): Promise<RunResult> => {
  const startedAt = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes();
  const outputMode = options.outputMode ?? 'head';
  const batchMode = options.batchMode ?? true;
  const reuse = reuseEnabled(options.reuse);
  const socketBefore = reuse ? controlSocketStat(connection) : undefined;
  const timeoutMs = clampTimeoutMs(options.timeoutMs);

  const args = buildSshArgs(connection, {
    tty: options.tty,
    batchMode,
    connectTimeout: options.connectTimeout ?? 10,
    reuse,
    hostKeyChecking: options.hostKeyChecking,
  });

  const remoteCommand = buildRemoteCommandLine(connection, command, { cwd: options.cwd });
  if (remoteCommand) {
    args.push(remoteCommand);
  }

  const stdoutCapture = mode === 'capture'
    ? new ByteCapture({ maxBytes: maxOutputBytes, mode: outputMode })
    : undefined;
  const stderrCapture = new ByteCapture({
    maxBytes: Math.min(maxOutputBytes, STDERR_CAPTURE_LIMIT),
    mode: outputMode,
  });

  // `--no-stdin` wins over everything else. Otherwise inline bytes and a
  // readable stream both need a pipe; interactive mode inherits the terminal.
  const noStdin = options.noStdin === true;
  const hasInlineStdin = !noStdin && options.stdin !== undefined;
  const hasStdinStream = !noStdin && options.stdinStream !== undefined;
  const stdinMode = hasInlineStdin || hasStdinStream
    ? 'pipe'
    : mode === 'inherit' ? 'inherit' : 'ignore';
  const stdio: StdioOptions = mode === 'inherit'
    ? [stdinMode, 'inherit', 'pipe']
    : [stdinMode, 'pipe', 'pipe'];

  return new Promise<RunResult>((resolve) => {
    const child = spawn(resolveSshBinary(), args, {
      stdio,
      // Put ssh in its own process group so a timeout also kills helpers it
      // spawned (ssh ProxyCommand, a remote shell wrapper, etc.).
      detached: process.platform !== 'win32',
    });

    const killChild = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) {
        return;
      }
      try {
        if (process.platform !== 'win32') {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The process already exited.
        }
      }
    };

    let timedOut = false;
    let settled = false;
    let spawnError: string | undefined;

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutCapture?.write(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrCapture.write(chunk);
      if (mode === 'inherit') {
        process.stderr.write(chunk);
      }
    });

    let activeStdinStream: NodeJS.ReadableStream | undefined;

    if (hasInlineStdin) {
      const childStdin = child.stdin;
      // The remote command can exit before it reads the payload (permission
      // denied, early failure). Writing the rest then raises EPIPE; swallow it
      // instead of crashing the CLI/MCP process with an unhandled 'error'.
      childStdin?.on('error', () => {});
      childStdin?.end(options.stdin);
    } else if (hasStdinStream && options.stdinStream) {
      activeStdinStream = options.stdinStream;
      const childStdin = child.stdin;
      if (childStdin) {
        // The remote command may exit before the producer finishes writing.
        // Ignore EPIPE and stop piping instead of surfacing an unhandled error.
        childStdin.on('error', () => {
          activeStdinStream?.unpipe();
        });
        activeStdinStream.pipe(childStdin);
      } else {
        activeStdinStream = undefined;
      }
    }

    let killTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    if (timeoutMs) {
      killTimer = setTimeout(() => {
        timedOut = true;
        killChild('SIGTERM');
        forceKillTimer = setTimeout(() => {
          killChild('SIGKILL');
          // Guarantee progress even if a helper escaped the process group and
          // keeps the stdio pipes open.
          const settleTimer = setTimeout(() => finish(null, 'SIGKILL'), 500);
          settleTimer.unref?.();
        }, 2000);
        forceKillTimer.unref?.();
      }, timeoutMs);
    }

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);

      if (activeStdinStream) {
        activeStdinStream.unpipe();
        if (activeStdinStream === process.stdin) {
          // Stop reading fd 0 so the CLI can exit even if the caller (often an
          // agent harness) keeps the other end of the pipe open forever.
          process.stdin.pause();
        }
        activeStdinStream = undefined;
      }

      if (timedOut) {
        stderrCapture.write(`[sshya] timed out after ${timeoutMs} ms\n`);
      }

      const stdout = stdoutCapture?.text() ?? '';
      const stderr = stderrCapture.text();
      const ok = exitCode === 0 && !timedOut;
      const socketAfter = reuse ? controlSocketStat(connection) : undefined;
      const reused = socketBefore !== undefined
        && socketAfter !== undefined
        && socketBefore.inode === socketAfter.inode
        && socketBefore.mtimeMs === socketAfter.mtimeMs
        && socketBefore.ctimeMs === socketAfter.ctimeMs;
      const failure = spawnError
        ? spawnFailure(spawnError)
        : classifySshError(stderr, {
          timedOut,
          exitCode,
          timeoutMs,
          connectTimeoutSeconds: options.connectTimeout,
        });

      resolve({
        ok,
        alias: connection.alias,
        command,
        remoteCommand,
        target: `${connection.user}@${connection.host}:${connection.port ?? '22'}`,
        cwd: options.cwd !== false ? connection.remote_path : undefined,
        exitCode,
        signal,
        stdout,
        stderr,
        stdoutBytes: stdoutCapture?.totalBytes ?? 0,
        stderrBytes: stderrCapture.totalBytes,
        stdoutLines: stdoutCapture?.lineCount ?? 0,
        stderrLines: stderrCapture.lineCount,
        stdoutTruncated: stdoutCapture?.truncated ?? false,
        stderrTruncated: stderrCapture.truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
        timeoutMs: timeoutMs ?? null,
        reused,
        ...(failure ? { errorKind: failure.kind, hint: failure.hint } : {}),
      });
    };

    child.on('error', (error: Error) => {
      spawnError = error.message;
      finish(-1, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
};

export async function runConnectionPrompt(
  alias?: string,
  commandParts: string[] = [],
  options: RunOptions = {},
): Promise<void> {
  const json = jsonEnabled(options.json);

  if (!alias) {
    if (!process.stdin.isTTY) {
      if (json) {
        printJson({ ok: false, error: 'Alias is required when stdin is not a TTY.' });
      } else {
        console.error(chalk.red('Alias is required when stdin is not a TTY.'));
        console.error(chalk.grey('Usage: sshya run <alias> -- <command...>'));
      }
      process.exitCode = 1;
      return;
    }
    alias = await selectAlias('Select a connection to run a command on');
  }

  const lookup = resolveAliasForCommand(alias, { json });

  if (!lookup.ok) {
    if (json) {
      printJson({
        ok: false,
        error: `Alias not found: ${alias}`,
        suggestions: lookup.suggestions,
      });
    } else {
      console.error(chalk.red(`Alias not found: ${alias}`));
      if (lookup.suggestions.length > 0) {
        console.error(chalk.grey(`Did you mean: ${lookup.suggestions.join(', ')}?`));
      }
    }
    process.exitCode = 1;
    return;
  }

  const connection = lookup.connection;

  const command = commandParts.join(' ').trim();
  if (!command) {
    if (json) {
      printJson({ ok: false, error: 'No command provided.' });
    } else {
      console.error(chalk.red('No command provided.'));
      console.error(chalk.grey('Usage: sshya run <alias> -- <command...>'));
    }
    process.exitCode = 1;
    return;
  }

  recordConnectionUsage(connection.alias);

  const mode = json ? 'capture' : 'inherit';
  // In capture mode a non-TTY stdin is usually piped data from a shell
  // pipeline or an agent. Forward it unless --no-stdin was passed. A TTY in
  // JSON mode stays 'ignore' so the command never waits on a human.
  const forwardStdin = mode === 'capture' && options.noStdin !== true && !process.stdin.isTTY;

  const result = await executeSshCommand(
    connection,
    command,
    {
      ...options,
      ...(forwardStdin ? { stdinStream: process.stdin } : {}),
    },
    mode,
  );

  if (json) {
    printJson(result);
  } else if (result.timedOut) {
    console.error(chalk.red(`Command timed out after ${result.timeoutMs}ms`));
    if (result.hint) {
      console.error(chalk.grey(result.hint));
    }
  } else if (!result.ok) {
    if (result.exitCode === -1) {
      console.error(chalk.red(result.stderr.trim() || 'SSH failed.'));
    } else {
      console.error(chalk.red(`Remote command exited with code ${result.exitCode}`));
    }
    if (result.hint) {
      console.error(chalk.grey(`Hint: ${result.hint}`));
    }
  }

  process.exitCode = result.timedOut ? 124 : (result.exitCode ?? 1);
}
