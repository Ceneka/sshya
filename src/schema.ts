import type { ZodType } from 'zod';

/**
 * Input shape accepted by `sshya add`, `sshya update`, `sshya import`, and the
 * MCP store-mutation tools.
 */
export interface ConnectionInput {
  alias: string;
  user: string;
  host: string;
  key_path?: string;
  port?: string | number;
  remote_path?: string;
  readonly?: boolean;
}

/**
 * Load the connection schema on demand.
 *
 * Zod is one of the most expensive modules to evaluate, and most CLI commands
 * never validate a new connection. Keeping the import inside this function
 * means `sshya run`, `list`, `show`, and even `--version` never pay for it; the
 * promise is cached so repeated validations reuse the same schema instance.
 */
let connectionSchemaPromise: Promise<ZodType<ConnectionInput>> | undefined;

export const loadConnectionSchema = (): Promise<ZodType<ConnectionInput>> => {
  connectionSchemaPromise ??= import('zod').then(({ z }) => z.object({
    alias: z.string().min(1),
    user: z.string().min(1),
    host: z.string().min(1),
    key_path: z.string().optional(),
    port: z.union([z.string(), z.number()]).optional(),
    remote_path: z.string().optional(),
    readonly: z.boolean().optional(),
  }));

  return connectionSchemaPromise;
};
