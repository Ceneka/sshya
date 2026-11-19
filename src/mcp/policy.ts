/**
 * Policy resolution for the MCP server.
 *
 * Two independent guardrails are supported:
 * - an alias allowlist (`--aliases`, `SSHYA_MCP_ALLOW`) with simple `*`/`?` globs
 * - a read-only mode (`--read-only`, `SSHYA_MCP_READ_ONLY`) that removes tools
 *   which mutate the store or write files
 *
 * The policy is intentionally small and synchronous: tools ask it about one
 * alias at a time, and resources use it to filter the store.
 */
export interface McpPolicyOptions {
  /**
   * Alias allowlist. Accepts a comma-separated string or an array of patterns.
   * Unset or empty means every stored alias is allowed.
   */
  aliases?: string | readonly string[];
  /** Remove mutating tools and refuse file uploads. */
  readOnly?: boolean;
}

export interface McpPolicy {
  /** Patterns as configured, e.g. `['web', 'stg-*']`. */
  readonly aliasPatterns: readonly string[];
  readonly readOnly: boolean;
  /** True when at least one alias pattern was configured. */
  readonly hasAliasAllowlist: boolean;
  isAliasAllowed(alias: string): boolean;
  /** Human/model readable label such as `web, staging` or `all stored aliases`. */
  allowedAliasesLabel(): string;
  /** One-line summary used in server instructions. */
  inlineSummary(): string;
}

export const parseAliasList = (value?: string | null): string[] => {
  if (!value) {
    return [];
  }
  return [...new Set(value.split(',').map(part => part.trim()).filter(Boolean))];
};

const normalizeAliasInput = (aliases?: string | readonly string[]): string[] => {
  if (aliases === undefined) {
    return [];
  }
  return parseAliasList(typeof aliases === 'string' ? aliases : aliases.join(','));
};

/**
 * Convert a simple glob to an anchored regex. Only `*` (any run of characters)
 * and `?` (one character) are special; everything else is literal.
 */
export const aliasPatternToRegExp = (pattern: string): RegExp => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const source = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`);
};

export const aliasMatchesPattern = (alias: string, pattern: string): boolean =>
  aliasPatternToRegExp(pattern).test(alias.trim());

export const createMcpPolicy = (options: McpPolicyOptions = {}): McpPolicy => {
  const aliasPatterns = normalizeAliasInput(options.aliases);
  // A configured allowlist with zero usable patterns (for example `--aliases ,`
  // or a trailing comma and an empty variable) means "allow nothing". Treating
  // it as unset would silently expose every stored alias, which is the opposite
  // of what the operator asked for.
  const hasAliasAllowlist = options.aliases !== undefined;
  const matchers = aliasPatterns.map(aliasPatternToRegExp);
  const readOnly = options.readOnly === true;

  const allowedAliasesLabel = (): string => {
    if (!hasAliasAllowlist) {
      return 'all stored aliases';
    }
    return aliasPatterns.length > 0 ? aliasPatterns.join(', ') : 'none (empty allowlist)';
  };

  return {
    aliasPatterns,
    readOnly,
    hasAliasAllowlist,
    isAliasAllowed(alias: string): boolean {
      if (!hasAliasAllowlist) {
        return true;
      }
      const normalized = alias.trim();
      return matchers.some(matcher => matcher.test(normalized));
    },
    allowedAliasesLabel,
    inlineSummary(): string {
      return `Allowed aliases: ${allowedAliasesLabel()}. Read-only: ${readOnly ? 'yes' : 'no'}.`;
    },
  };
};

export const envFlagEnabled = (value?: string): boolean =>
  value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());

/**
 * Resolve the active policy. Explicit options win over environment variables;
 * omitted options fall back to `SSHYA_MCP_ALLOW` and `SSHYA_MCP_READ_ONLY`.
 */
export const resolveMcpPolicy = (options: McpPolicyOptions = {}): McpPolicy => {
  const envAllowlist = process.env.SSHYA_MCP_ALLOW?.trim();
  const aliases = options.aliases !== undefined
    ? options.aliases
    : envAllowlist
      ? process.env.SSHYA_MCP_ALLOW
      : undefined;
  const readOnly = options.readOnly ?? envFlagEnabled(process.env.SSHYA_MCP_READ_ONLY);

  return createMcpPolicy({ aliases, readOnly });
};
