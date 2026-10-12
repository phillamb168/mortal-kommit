// Explicit manual integration check; never runs as part of npm test or replay.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/backend/process.js';
import { resolveScope, snapshots } from '../src/backend/repository.js';
import { prepare, analyze } from '../src/backend/models.js';
import { readConfig } from '../src/backend/config.js';
import { newMatch, applyAnalysis } from '../src/core/battle.js';
const root = await mkdtemp(join(tmpdir(), 'mk-model-smoke-')),
  repo = join(root, 'repo'),
  directory = join(root, 'match');
await mkdir(repo);
await git(repo, 'init', '-b', 'main');
await git(repo, 'config', 'user.name', 'Mortal Kommit Test');
await git(repo, 'config', 'user.email', 'test@example.invalid');
await writeFile(
  join(repo, 'checkout.ts'),
  'export function checkout(user: { id: string }, order: { owner: string }) {\n  if (order.owner !== user.id) throw new Error("Forbidden");\n  return "charged";\n}\n',
);
await git(repo, 'add', '.');
await git(repo, 'commit', '-m', 'Enforce ownership');
await writeFile(
  join(repo, 'checkout.ts'),
  'export function checkout(user: { id: string }, order: { owner: string }) {\n  return "charged";\n}\n',
);
await git(repo, 'add', '.');
await git(repo, 'commit', '-m', 'Simplify checkout');
const m = newMatch('model-smoke', 'Isolated committed smoke fixture');
const { scope, gitDir } = await resolveScope(repo, directory, { base: 'HEAD~1' });
m.scope = scope;
m.omissions = await snapshots(gitDir, scope, join(directory, 'snapshot'));
const config = readConfig();
await prepare(config, m, directory, gitDir);
console.log(
  JSON.stringify({
    phase: 'preparation',
    packetBytes: m.packet.length,
    usage: m.prepUsage,
    omissions: m.omissions.length,
  }),
);
m.messages = [
  {
    id: 'smoke-claude',
    matchId: m.id,
    pubkey: 'fixture-claude',
    agent: 'claude',
    at: 1,
    rootId: 'fixture',
    revision: 0,
    content:
      'INDEPENDENT_INSPECTION_COMPLETE\nThe change removes the owner comparison. In head checkout.ts:2, `return "charged";` executes unconditionally. A customer can charge a foreign order. Base checkout.ts:2 had `if (order.owner !== user.id) throw new Error("Forbidden");`. This is an actionable authorization regression.',
  },
  {
    id: 'smoke-codex',
    matchId: m.id,
    pubkey: 'fixture-codex',
    agent: 'codex',
    at: 2,
    rootId: 'fixture',
    revision: 0,
    content:
      'INDEPENDENT_INSPECTION_COMPLETE\nI independently found the same missing ownership check. A user with id A and order.owner B now receives charged, whereas the base threw Forbidden. The exact removed guard at base checkout.ts:2 confirms the regression. This is the same underlying finding.',
  },
];
const classification = await analyze(config, m, directory);
applyAnalysis(m, classification, 3);
if (!m.findings.length) throw new Error('Analyzer did not classify the explicit fixture finding');
console.log(
  JSON.stringify({
    phase: 'analysis',
    findings: m.findings.map((f) => ({ id: f.id, status: f.status, title: f.title })),
    events: m.events.length,
    usage: m.analysisUsage,
    directory,
  }),
);
