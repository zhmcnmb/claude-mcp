import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(here, 'service.ts'), path.join(here, 'server.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  outdir: path.join(here, 'dist'), outExtension: { '.js': '.cjs' },
});
