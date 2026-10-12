import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/backend/store.js';
import { demoMatch } from '../src/core/demo.js';
import { parseReviewCommand } from '../src/backend/coordinator.js';
import { restrictedSession, validSessionTitle } from '../src/backend/acp-proxy.js';
import { capability, type Runtime } from '../src/backend/capabilities.js';
import { Config } from '../src/backend/config.js';
import { validateAssets } from '../src/backend/assets.js';
import { rootOf } from '../src/backend/buzz.js';
import { markdown } from '../src/backend/export.js';

test('persistent replay reproduces battle and evidence with no new calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-store-'));
  try {
    let s = new Store(dir);
    const demo = demoMatch();
    s.save(demo);
    s.record('message-1', 'message', { text: 'one' });
    assert.equal(s.record('message-1', 'message', { text: 'duplicate' }), false);
    s.close();
    s = new Store(dir);
    const loaded = s.get(demo.id)!;
    assert.deepEqual(loaded.events, demo.events);
    assert.deepEqual(loaded.battle, demo.battle);
    assert.equal(loaded.analysisUsage.calls, 0);
    assert.ok(markdown(loaded).includes('SCRIPTED DEMO'));
    s.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('ARENA commands are explicit and thread roots isolate simultaneous reviews', () => {
  assert.equal(parseReviewCommand('please review this sometime'), null);
  assert.deepEqual(parseReviewCommand('!review --repo api --base main'), {
    '--repo': 'api',
    '--base': 'main',
  });
  assert.throws(() => parseReviewCommand('!review --repo api --shell rm'));
  assert.throws(() => parseReviewCommand('!review --repo api --token-budget 0'));
  assert.equal(
    rootOf({
      id: 'child',
      tags: [
        ['h', 'arena'],
        ['e', 'parent', '', 'reply'],
        ['e', 'match-A', '', 'root'],
      ],
    }),
    'match-A',
  );
  assert.notEqual(rootOf({ id: 'match-B', tags: [['h', 'arena']] }), 'match-A');
});
test('ARENA commands accept Buzz Markdown autolinks while keeping option parsing strict', () => {
  const url = 'https://gitlab.example.test/team/api/-/merge_requests/17';
  assert.deepEqual(parseReviewCommand(`!review --mr <${url}>`), { '--mr': url });
  assert.deepEqual(parseReviewCommand(`!review --mr ${url}`), { '--mr': url });
  assert.deepEqual(parseReviewCommand(`!review --repo api --mr <${url}> --token-budget 80000`), {
    '--repo': 'api',
    '--mr': url,
    '--token-budget': '80000',
  });
  assert.throws(() => parseReviewCommand(`!review --mr <${url}> --shell execute`));
  assert.throws(() => parseReviewCommand(`!review --mr <${url}> --mr ${url}`));
  assert.throws(() => parseReviewCommand(`!review --mr <${url} extra>`));
  assert.equal(
    parseReviewCommand('!review --mr <javascript:alert(1)>')!['--mr'],
    '<javascript:alert(1)>',
  );
});
test('ACP restrictions bind the exact registered thread and remove builtin execution', () => {
  const root = 'a1234567890';
  const runtime = { rootId: root, directory: '/tmp/match' } as Runtime;
  assert.ok(validSessionTitle('ArenaClaude · #ARENA · a1234567', root));
  assert.throws(() =>
    restrictedSession(
      { _meta: { sessionTitle: 'ArenaClaude · #ARENA · b1234567' } },
      runtime,
      'runtime',
    ),
  );
  const p = restrictedSession(
    {
      _meta: {
        sessionTitle: 'ArenaClaude · #ARENA · a1234567',
        claudeCode: { options: { tools: ['Bash'], settingSources: ['project'] } },
      },
      mcpServers: [{ command: 'evil' }],
    },
    runtime,
    'runtime',
  );
  assert.deepEqual(p._meta.claudeCode.options.tools, []);
  assert.deepEqual(p._meta.claudeCode.options.settingSources, []);
  assert.equal(p.mcpServers.length, 1);
  assert.equal(p.mcpServers[0].name, 'mortal');
});
test('review capabilities reject traversal and have no arbitrary execution tool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mk-cap-'));
  try {
    await mkdir(join(directory, 'snapshot/head'), { recursive: true });
    await writeFile(join(directory, 'snapshot/head/file.ts'), 'one\ntwo\nthree');
    const runtime = { directory, config: Config.parse({}) } as Runtime;
    assert.equal(
      await capability(runtime, 'snapshot_read', {
        revision: 'head',
        file: 'file.ts',
        line: 2,
        count: 1,
      }),
      '2: two',
    );
    await assert.rejects(
      capability(runtime, 'snapshot_read', { revision: 'head', file: '../../outside' }),
    );
    await assert.rejects(capability(runtime, 'shell', { command: 'echo unsafe' }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('bundled replaceable atlases have valid alpha, bounds, pivots and animations', async () => {
  assert.equal((await validateAssets(join(process.cwd(), 'assets'))).length, 2);
});
