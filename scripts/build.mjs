import { build } from 'esbuild';
import { mkdir, writeFile, chmod, cp } from 'node:fs/promises';
await mkdir('dist/web', { recursive: true });
await build({
  entryPoints: ['src/cli.ts', 'src/backend/acp-proxy.ts', 'src/backend/capabilities.ts'],
  outdir: 'dist',
  outbase: 'src',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
});
await build({
  entryPoints: ['src/web/main.tsx'],
  outdir: 'dist/web',
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
  minify: true,
  sourcemap: true,
  external: ['/assets/*'],
});
await writeFile(
  'dist/web/index.html',
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#111014"><title>Mortal Kommit · ARENA</title><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
);
await chmod('dist/cli.js', 0o755);
