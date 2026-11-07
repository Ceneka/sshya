import chalk from 'chalk';

/**
 * True when a command should emit machine-readable output.
 *
 * JSON is opt-in via `--json`, or can be forced for every command with the
 * `SSHYA_JSON=1` environment variable. Agents that shell out can set it once
 * and then parse every response.
 */
export const jsonEnabled = (explicit?: boolean): boolean => {
  if (explicit === true) {
    return true;
  }
  const env = process.env.SSHYA_JSON?.trim().toLowerCase();
  return env === '1' || env === 'true' || env === 'yes';
};

export const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export const fail = (message: string, code: number = 1): never => {
  console.error(chalk.red(message));
  process.exit(code);
};

/** Print either a JSON payload or a human success message. */
export const printResult = (json: boolean, payload: unknown, message: string): void => {
  if (json) {
    printJson(payload);
    return;
  }
  console.log(chalk.green(message));
};
