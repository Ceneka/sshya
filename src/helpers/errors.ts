/**
 * Turn OpenSSH/remote stderr into a stable error class plus an actionable hint.
 * LLM callers can branch on `errorKind` and retry with a concrete fix instead
 * of guessing what a wall of text means.
 */

export type SshErrorKind =
  | 'ssh-missing'
  | 'host-key'
  | 'host-key-changed'
  | 'dns'
  | 'refused'
  | 'timeout'
  | 'auth'
  | 'key'
  | 'network'
  | 'remote-permission'
  | 'remote-command'
  | 'shell'
  | 'remote'
  | 'unknown';

export interface SshFailure {
  kind: SshErrorKind;
  hint: string;
  retryable: boolean;
}

interface ClassifyOptions {
  timedOut?: boolean;
  exitCode?: number | null;
  timeoutMs?: number;
  connectTimeoutSeconds?: number;
}

interface Rule {
  kind: SshErrorKind;
  pattern: RegExp;
  hint: string;
  retryable?: boolean;
}

const rules: Rule[] = [
  {
    kind: 'host-key-changed',
    pattern: /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .+ has changed|host key .* changed/i,
    hint: 'The server key differs from known_hosts. Verify the change out of band; if legitimate, remove the old entry with `ssh-keygen -R <host>` (or `ssh-keygen -R [host]:port`). Do not disable host key checking blindly.',
  },
  {
    kind: 'host-key',
    pattern: /Host key verification failed|No .+ host key is known|not a valid known_hosts/i,
    hint: 'First contact with this host. Retry with `--accept-new-host-key` on the CLI or `acceptNewHostKey: true` in MCP to trust the key once (TOFU), or preload it with `ssh-keyscan -p <port> <host> >> ~/.ssh/known_hosts`.',
    retryable: true,
  },
  {
    kind: 'dns',
    pattern: /Could not resolve hostname|Name or service not known|Temporary failure in name resolution|nodename nor servname provided/i,
    hint: 'DNS/name resolution failed. Check the stored host, /etc/hosts, or the VPN/DNS resolver.',
    retryable: true,
  },
  {
    kind: 'refused',
    pattern: /Connection refused|connect to host .+ port .+: Connection refused/i,
    hint: 'The host is reachable but nothing is listening on that port. Verify the stored port and that sshd is running.',
    retryable: true,
  },
  {
    kind: 'timeout',
    pattern: /Connection timed out|Operation timed out|connect to host .+ timed out|No route to host|Network is unreachable/i,
    hint: 'The host did not answer. Check the VPN/firewall and the stored host/port. `--connect-timeout` controls only the TCP handshake.',
    retryable: true,
  },
  {
    kind: 'auth',
    pattern: /Too many authentication failures/i,
    hint: 'The server rejected too many keys. Make sure the connection stores the right `key_path`; sshya already passes `-i` and `IdentitiesOnly` is not set, so an agent with many keys can trigger this.',
    retryable: false,
  },
  {
    kind: 'auth',
    pattern: /Permission denied \((?:publickey|password|keyboard-interactive|gssapi)/i,
    hint: 'Authentication failed. Verify the username, the key path, and that the public key is in the remote `~/.ssh/authorized_keys`. Try `sshya show <alias>` to inspect the stored target.',
    retryable: false,
  },
  {
    kind: 'key',
    pattern: /no such identity|Identity file .+ not accessible|Load key .+ No such file or directory|Could not open a connection to your authentication agent/i,
    hint: 'The private key is missing or unreadable. Check `key_path`, expand `~`, and make sure the file exists locally.',
    retryable: false,
  },
  {
    kind: 'key',
    pattern: /Bad permissions|UNPROTECTED PRIVATE KEY|Permissions .+ for '.+' are too open/i,
    hint: 'The private key permissions are too open. Run `chmod 600 <key_path>`.',
    retryable: false,
  },
  {
    kind: 'network',
    pattern: /kex_exchange_identification|Connection closed by remote host|Connection reset by peer|Broken pipe|Software caused connection abort|client_loop: send disconnect/i,
    hint: 'The TCP session dropped or the SSH banner was unreadable. Retry; if it repeats, check the network, fail2ban, or sshd MaxStartups.',
    retryable: true,
  },
  {
    kind: 'shell',
    pattern: /This account is currently not available|You must have a tty to run sudo/i,
    hint: 'The remote account has no usable login shell (for example `/usr/sbin/nologin`), or the command needs a TTY. Use an account with a shell, or pass `tty: true` for sudo-style commands.',
    retryable: false,
  },
  {
    kind: 'remote-command',
    pattern: /command not found|not found: .+|: not found$/im,
    hint: 'The remote shell could not find the command. Check the remote PATH or install it; `sshya run` does not load your local PATH.',
    retryable: false,
  },
  {
    kind: 'remote-permission',
    pattern: /Permission denied|Operation not permitted|must be root|are you root\?/i,
    hint: 'The remote command was denied. It may need sudo, a different user, or broader file permissions.',
    retryable: false,
  },
  {
    kind: 'remote',
    pattern: /No space left on device/i,
    hint: 'The remote filesystem is full. Free space before retrying.',
    retryable: false,
  },
  {
    kind: 'remote',
    pattern: /Read-only file system/i,
    hint: 'The remote filesystem is mounted read-only. Check mounts or use a writable path.',
    retryable: false,
  },
];

export const classifySshError = (
  stderr: string,
  options: ClassifyOptions = {},
): SshFailure | undefined => {
  if (options.timedOut) {
    const seconds = options.timeoutMs ? Math.round(options.timeoutMs / 1000) : undefined;
    return {
      kind: 'timeout',
      hint: `The command was aborted by sshya${seconds ? ` after ${seconds}s` : ''}. Raise --timeout or run a narrower command (for example, add \`| tail -n 50\`).`,
      retryable: true,
    };
  }

  if (options.exitCode === 0) {
    return undefined;
  }

  const text = stderr.trim();
  if (!text) {
    if (options.exitCode === undefined || options.exitCode === null) {
      return undefined;
    }
    return {
      kind: 'remote',
      hint: `The remote command exited with code ${options.exitCode} without writing to stderr. Re-run it with more logging.`,
      retryable: false,
    };
  }

  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      return {
        kind: rule.kind,
        hint: rule.hint,
        retryable: rule.retryable ?? false,
      };
    }
  }

  return {
    kind: 'unknown',
    hint: 'The SSH client or remote command failed. Inspect stderr; add `--timeout`/`--no-cwd` or run `sshya doctor --probe` to isolate the cause.',
    retryable: false,
  };
};

export const spawnFailure = (message: string): SshFailure => {
  if (/ENOENT/i.test(message)) {
    return {
      kind: 'ssh-missing',
      hint: 'The local `ssh` binary was not found. Install OpenSSH client or set SSHYA_SSH_BIN to its path.',
      retryable: false,
    };
  }

  return {
    kind: 'unknown',
    hint: `Could not start the SSH client: ${message}`,
    retryable: false,
  };
};
