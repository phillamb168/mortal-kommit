import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSecretKey, getPublicKey, finalizeEvent, nip44 } from 'nostr-tools';
import { Coordinator } from '../src/backend/coordinator.js';
import { Store } from '../src/backend/store.js';
import { Config } from '../src/backend/config.js';
import { Relay } from '../src/backend/buzz.js';
import { newMatch } from '../src/core/battle.js';
import { startServer } from '../src/backend/server.js';

test('signed message duplicates, edits and interleaved review threads stay isolated; encrypted metrics require session attribution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-protocol-'));
  const before = process.env.MORTAL_KOMMIT_DATA_DIR;
  process.env.MORTAL_KOMMIT_DATA_DIR = dir;
  const store = new Store(dir),
    coordinator = new Coordinator(store, () => 'http://127.0.0.1:1/');
  try {
    const owner = generateSecretKey(),
      claude = generateSecretKey(),
      codex = generateSecretKey(),
      pub = getPublicKey(claude);
    coordinator.config = Config.parse({
      channelId: 'arena',
      ownerPubkey: getPublicKey(owner),
      fighters: { claude: pub, codex: getPublicKey(codex) },
    });
    coordinator.relay = new Relay('ws://127.0.0.1:1', owner);
    const a = newMatch('match-a', 'A'),
      b = newMatch('match-b', 'B');
    a.rootId = 'a'.repeat(64);
    b.rootId = 'b'.repeat(64);
    a.status = b.status = 'complete';
    store.save(a);
    store.save(b);
    const event = (root: string, content: string, kind = 9, tags: string[][] = []) =>
      finalizeEvent(
        {
          kind,
          created_at: 100,
          tags: [['h', 'arena'], ['e', root, '', 'root'], ...tags],
          content,
        },
        claude,
      );
    const first = event(a.rootId, 'finding A'),
      second = event(b.rootId, 'finding B');
    await coordinator.observe(first);
    await coordinator.observe(second);
    await coordinator.observe(first);
    assert.equal(store.get(a.id)!.messages.length, 1);
    assert.equal(store.get(b.id)!.messages.length, 1);
    const edited = finalizeEvent(
      {
        kind: 40003,
        created_at: 101,
        tags: [
          ['h', 'arena'],
          ['e', first.id],
        ],
        content: 'corrected A',
      },
      claude,
    );
    await coordinator.observe(edited);
    assert.ok(store.get(a.id)!.messages[0].deleted);
    assert.equal(store.get(a.id)!.messages.at(-1)!.content, 'corrected A');
    assert.equal(store.get(b.id)!.messages.length, 1);
    const forged = { ...event(a.rootId, 'forged'), sig: '0'.repeat(128) };
    await coordinator.observe(forged);
    assert.equal(store.get(a.id)!.messages.length, 2);
    const historical = finalizeEvent(
      {
        kind: 9,
        created_at: 99,
        tags: [
          ['h', 'arena'],
          ['e', a.rootId, '', 'root'],
        ],
        content: 'earlier inspection',
      },
      claude,
    );
    await coordinator.observe(historical);
    await coordinator.observe(historical);
    assert.deepEqual(
      store.get(a.id)!.messages.map((m) => m.at),
      [99000, 100000, 101000],
      'late history is sorted without duplicating messages or losing edits',
    );
    const directory = join(dir, 'matches', a.id);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'claude.bindings.json'),
      JSON.stringify([{ sessionId: 'session-A', rootId: a.rootId, matchId: a.id }]),
    );
    const metric = (sessionId: string, turnSeq: number, total: number) =>
      finalizeEvent(
        {
          kind: 44200,
          created_at: 102,
          tags: [
            ['p', getPublicKey(owner)],
            ['agent', pub],
          ],
          content: nip44.v2.encrypt(
            JSON.stringify({
              harness: 'claude',
              channelId: 'arena',
              sessionId,
              turnId: `turn-${turnSeq}`,
              turnSeq,
              timestamp: new Date().toISOString(),
              deltaReliable: true,
              turn: { inputTokens: total - 20, outputTokens: 20, totalTokens: total },
            }),
            nip44.v2.utils.getConversationKey(claude, getPublicKey(owner)),
          ),
        },
        claude,
      );
    await coordinator.observe(metric('unrelated-session', 1, 90000));
    assert.equal(store.get(a.id)!.battle.claude.usage.tokens, null);
    const usage = metric('session-A', 1, 2000);
    await coordinator.observe(usage);
    await coordinator.observe(usage);
    assert.equal(store.get(a.id)!.battle.claude.usage.tokens, 2000);
    assert.equal(store.get(b.id)!.battle.claude.usage.tokens, null);
    assert.equal(store.get(a.id)!.usage.length, 1);
  } finally {
    coordinator.close();
    store.close();
    if (before === undefined) delete process.env.MORTAL_KOMMIT_DATA_DIR;
    else process.env.MORTAL_KOMMIT_DATA_DIR = before;
    await rm(dir, { recursive: true, force: true });
  }
});

test('loopback server authenticates, rejects cross-origin requests, exports and reconnects SSE without model calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mk-server-'));
  const before = process.env.MORTAL_KOMMIT_DATA_DIR;
  process.env.MORTAL_KOMMIT_DATA_DIR = dir;
  const s = await startServer();
  try {
    await assert.rejects(startServer(), /already owns this data directory/);
    assert.equal((await fetch(`${s.base}/api/matches`)).status, 401);
    const headers = { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' };
    assert.equal(
      (
        await fetch(`${s.base}/api/demo`, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://evil.invalid' },
          body: '{}',
        })
      ).status,
      403,
    );
    const demo = (await fetch(`${s.base}/api/demo`, { method: 'POST', headers, body: '{}' }).then(
      (r) => r.json(),
    )) as any;
    assert.equal(demo.demo, true);
    const saved = (await fetch(`${s.base}/api/matches/${demo.id}`, { headers }).then((r) =>
      r.json(),
    )) as any;
    assert.deepEqual(saved.events, demo.events);
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${s.base}/api/events?match=${demo.id}`, {
        headers: { ...headers, 'Last-Event-ID': '7' },
      });
      const reader = response.body!.getReader();
      const chunk = new TextDecoder().decode((await reader.read()).value);
      assert.ok(chunk.includes('event: match'));
      assert.ok(chunk.includes('demo-mortal-kommit'));
      await reader.cancel();
    }
    const exported = await fetch(`${s.base}/api/matches/${demo.id}/export.md`, { headers }).then(
      (r) => r.text(),
    );
    assert.ok(exported.includes('SCRIPTED DEMO'));
    assert.equal(s.store.get(demo.id)!.analysisUsage.calls, 0);
    const shared = new URL(s.coordinator.matchUrl(demo.id)),
      viewer = new URLSearchParams(shared.hash.slice(1)).get('session');
    assert.notEqual(viewer, s.token);
    const session = await fetch(`${s.base}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: viewer }),
    });
    assert.equal(session.status, 200);
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    assert.equal(
      (await fetch(`${s.base}/api/matches/${demo.id}`, { headers: { Cookie: cookie } })).status,
      200,
    );
    for (const path of ['/api/stop', '/api/reviews'])
      assert.equal(
        (
          await fetch(`${s.base}${path}`, {
            method: 'POST',
            headers: { Cookie: cookie, 'Content-Type': 'application/json' },
            body: '{}',
          })
        ).status,
        403,
      );
    assert.equal(
      (await fetch(`${s.base}/api/status`, { headers: { Cookie: cookie } })).status,
      403,
    );
    assert.equal(
      (await fetch(`${s.base}/api/demo`, { method: 'POST', headers: { Cookie: cookie } })).status,
      200,
    );
    const viewerExport = (await fetch(`${s.base}/api/matches/${demo.id}/export.json`, {
      headers: { Cookie: cookie },
    }).then((r) => r.json())) as any;
    assert.equal(viewerExport.id, demo.id);
    const preview = `https://arena.example.test/?match=demo-mortal-kommit#session=${'f'.repeat(64)}`;
    await writeFile(
      join(dir, 'tunnel.json'),
      JSON.stringify({
        pid: process.pid,
        url: preview,
        publicOrigin: 'https://arena.example.test',
      }),
    );
    const previewMatch = new URL(s.coordinator.matchUrl('review-other'));
    assert.equal(previewMatch.origin, 'https://arena.example.test');
    assert.equal(previewMatch.searchParams.get('match'), 'review-other');
    assert.equal(previewMatch.hash, `#session=${'f'.repeat(64)}`);
  } finally {
    await s.close();
    if (before === undefined) delete process.env.MORTAL_KOMMIT_DATA_DIR;
    else process.env.MORTAL_KOMMIT_DATA_DIR = before;
    await rm(dir, { recursive: true, force: true });
  }
});
