#!/usr/bin/env bun
/**
 * Build the published CLI: plain ESM JavaScript for Node >= 20.
 *
 * Everything the CLI needs at runtime is bundled into `dist` (no `packages:
 * "external"`), minified, and split into content-hashed chunks. This trades a
 * bigger tarball for a much smaller process-start cost: Node no longer walks
 * and parses the whole `node_modules` graph on every `sshya` invocation, which
 * dominated agent loops (measured on one machine: ~365 ms -> ~94 ms for
 * `--version`/`list --json`, ~385 ms -> ~116 ms for a pooled `run`).
 *
 * `splitting: true` is load-bearing. Code reachable only through a dynamic
 * `import()` (currently `sshya mcp`, and any future lazy-loaded interactive
 * module) lands in its own chunk and is parsed only when that command runs.
 * Keep interactive-only dependencies behind dynamic imports in the source so
 * they stay out of the eager `index.js` graph.
 *
 * The tarball grows from ~270 KiB to ~1.1 MiB raw (~61 KiB -> ~390 KiB
 * gzipped), but the package has no runtime `dependencies`, so users install
 * one tarball instead of the previous ~100-package tree. The cost is that
 * dependency fixes only reach users through a new sshya release; there is no
 * dedupe or package-manager patching. Revisit if that becomes a problem.
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
  splitting: true,
  minify: true,
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
