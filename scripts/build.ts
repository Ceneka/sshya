#!/usr/bin/env bun
/**
 * Build the published CLI: plain ESM JavaScript for Node >= 20.
 *
 * Local modules are bundled into two entry files so the tarball only ships
 * `dist`. Runtime dependencies stay external (`packages: "external"`): npm
 * installs them from `dependencies`, keeping the tarball small and letting
 * users benefit from normal dependency deduplication/security updates.
 *
 * Bun keeps the source shebang, so rewrite it to `node` afterwards. The source
 * files keep `#!/usr/bin/env bun` for direct `bun run index.ts` development.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist');
const NODE_SHEBANG = '#!/usr/bin/env node';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(root, 'index.ts'), path.join(root, 's.ts')],
  outdir,
  target: 'node',
  format: 'esm',
  packages: 'external',
});

if (!result.success) {
  console.error('Build failed:');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

for (const output of result.outputs) {
  const lines = readFileSync(output.path, 'utf8').split('\n');
  if (lines[0]?.startsWith('#!')) {
    lines[0] = NODE_SHEBANG;
  } else {
    lines.unshift(NODE_SHEBANG);
  }
  writeFileSync(output.path, lines.join('\n'));
  chmodSync(output.path, 0o755);
  console.log(`built ${path.relative(root, output.path)}`);
}
