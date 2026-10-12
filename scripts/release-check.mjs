import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const pack = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }),
)[0];
const paths = pack.files.map((f) => f.path);
for (const required of [
  'dist/cli.js',
  'dist/web/index.html',
  'assets/claude.png',
  'assets/codex.png',
  'assets/stage.png',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
])
  assert.ok(paths.includes(required), `Package missing ${required}`);
for (const path of paths) {
  assert.match(
    path,
    /^(dist\/|assets\/|docs\/|package\.json$|README\.md$|CONTRIBUTING\.md$|LICENSE$|CHANGELOG\.md$|SECURITY\.md$|THIRD_PARTY_NOTICES\.md$)/,
    `Unexpected package file: ${path}`,
  );
  assert.doesNotMatch(
    path,
    /(^|\/)(\.env|\.firecrawl|node_modules|identities\.json|service\.json|tunnel\.json|viewer-key\.json)|\.(sqlite|db|runtime\.json|bindings\.json)/i,
    `Private state in package: ${path}`,
  );
}
const forbidden = [
  /\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{58}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=]{30,}/,
  /https?:\/\/[^\s/]+:[^\s/@]+@/,
];
async function files(path) {
  const list = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) list.push(...(await files(file)));
    else if (entry.isFile()) list.push(file);
  }
  return list;
}
const source = [
  ...(await files('src')),
  ...(await files('scripts')),
  ...(await files('docs')),
  ...(await files('.github')),
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'package.json',
  'package-lock.json',
];
for (const path of new Set([...paths, ...source])) {
  if (/\.(png|jpg|jpeg|woff2?)$/.test(path)) continue;
  const content = await readFile(path, 'utf8');
  for (const pattern of forbidden)
    assert.ok(
      !pattern.test(content),
      `Possible credential in ${path}; inspect locally (value withheld)`,
    );
  assert.ok(
    !/\/(?:Users|home)\/[A-Za-z0-9._-]+\/(?:Work|Desktop|Documents)\//.test(content),
    `Developer machine path in ${path}`,
  );
}
console.log(
  `Release inventory checked: ${paths.length} packaged files, ${(pack.size / 1024 / 1024).toFixed(2)} MiB. No flagged credentials or runtime state. Nothing published.`,
);
