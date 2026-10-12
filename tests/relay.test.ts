import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event,
} from 'nostr-tools';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Relay, setupArena } from '../src/backend/buzz.js';
import { Config } from '../src/backend/config.js';

async function fixture(authenticationTimeoutMs?: number) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}`;
  const key = generateSecretKey();
  const relay = new Relay(url, key, { authenticationTimeoutMs });
  const warnings: string[] = [];
  relay.on('warning', (warning) => warnings.push(String(warning)));
  const publication = finalizeEvent(
    { kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: '{}' },
    key,
  );
  const close = async () => {
    relay.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  return { server, relay, url, key, publication, warnings, close };
}

function challenge(socket: WebSocket, frames: any[][], value = 'test-challenge') {
  socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
  socket.send(JSON.stringify(['AUTH', value]));
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail('Timed out waiting for local relay frame');
}

test('relay waits for the matching successful AUTH acknowledgement before readiness, subscriptions and publication', async () => {
  const f = await fixture();
  try {
    const frames: any[][] = [];
    let connected = 0;
    f.relay.on('connected', () => connected++);
    f.relay.subscribe([{ kinds: [9], '#h': ['arena'] }]);
    const connection = once(f.server, 'connection');
    f.relay.connect();
    const [socket] = (await connection) as [WebSocket];
    challenge(socket, frames);
    await until(() => frames.some((frame) => frame[0] === 'AUTH'));
    const auth = frames.find((frame) => frame[0] === 'AUTH')![1] as Event;
    assert.equal(auth.kind, 22242);
    assert.equal(auth.pubkey, getPublicKey(f.key));
    assert.ok(verifyEvent(auth));
    assert.deepEqual(auth.tags, [
      ['relay', f.url],
      ['challenge', 'test-challenge'],
    ]);
    const published = f.relay.publish(f.publication);
    void published.catch(() => {});
    socket.send(JSON.stringify(['OK', 'unrelated-event-id', true, '']));
    await delay(30);
    assert.equal(connected, 0, 'transport open is not authenticated readiness');
    assert.deepEqual(
      frames.map((frame) => frame[0]),
      ['AUTH'],
    );
    socket.send(JSON.stringify(['OK', auth.id, true, '']));
    await until(() => frames.some((frame) => frame[0] === 'EVENT'));
    assert.equal(connected, 1);
    assert.deepEqual(
      frames.map((frame) => frame[0]),
      ['AUTH', 'REQ', 'EVENT'],
    );
    socket.send(JSON.stringify(['OK', f.publication.id, true, '']));
    await published;
    assert.deepEqual(f.warnings, []);
  } finally {
    await f.close();
  }
});

test('channel messages and owner telemetry use separate live subscriptions and restore together', async () => {
  const f = await fixture();
  try {
    const filters = [
      { kinds: [9], '#h': ['arena'] },
      { kinds: [44200], '#p': [getPublicKey(f.key)] },
      { kinds: [24200], '#p': [getPublicKey(f.key)] },
    ];
    const received: Event[] = [];
    f.relay.on('event', (e) => received.push(e));
    // Match the coordinator: install current filters in the ready callback.
    f.relay.on('connected', () => f.relay.subscribe(filters));
    for (let connectionIndex = 0; connectionIndex < 2; connectionIndex++) {
      const connected = once(f.server, 'connection');
      if (connectionIndex === 0) f.relay.connect();
      const [socket] = (await connected) as [WebSocket];
      const frames: any[][] = [];
      challenge(socket, frames, `scope-${connectionIndex}`);
      await until(() => frames.some((frame) => frame[0] === 'AUTH'));
      socket.send(JSON.stringify(['OK', frames[0][1].id, true, '']));
      await until(() => frames.filter((frame) => frame[0] === 'REQ').length === 3);
      const requests = frames.filter((frame) => frame[0] === 'REQ');
      assert.deepEqual(
        requests.map((frame) => frame.slice(2)),
        filters.map((filter) => [filter]),
      );
      assert.equal(new Set(requests.map((frame) => frame[1])).size, 3);
      for (let index = 0; index < 3; index++) {
        const event = finalizeEvent(
          {
            kind: filters[index].kinds[0],
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: `live-${connectionIndex}-${index}`,
          },
          f.key,
        );
        socket.send(JSON.stringify(['EVENT', requests[index][1], event]));
      }
      await until(() => received.length === (connectionIndex + 1) * 3);
      if (connectionIndex === 0) {
        socket.close();
        await once(f.relay, 'disconnected');
      } else {
        f.relay.subscribe(filters.slice(0, 1));
        await until(() => frames.filter((frame) => frame[0] === 'CLOSE').length === 2);
        socket.send(JSON.stringify(['EVENT', 'mortal-kommit-1', f.publication]));
        socket.send(JSON.stringify(['EVENT', 'unrelated', f.publication]));
        await delay(20);
        assert.equal(received.length, 6);
      }
    }
  } finally {
    await f.close();
  }
});

test('authentication denial fails waiting callers promptly and never publishes', async () => {
  const f = await fixture();
  try {
    const frames: any[][] = [];
    const connection = once(f.server, 'connection');
    f.relay.connect();
    const ready = assert.rejects(
      f.relay.waitUntilReady(),
      /Buzz authentication rejected: restricted: membership required/,
    );
    const published = assert.rejects(
      f.relay.publish(f.publication),
      /Buzz authentication rejected: restricted: membership required/,
    );
    const [socket] = (await connection) as [WebSocket];
    challenge(socket, frames);
    await until(() => frames.length > 0);
    socket.send(JSON.stringify(['OK', frames[0][1].id, false, 'restricted: membership required']));
    await Promise.all([ready, published]);
    assert.deepEqual(
      frames.map((frame) => frame[0]),
      ['AUTH'],
    );
    assert.match(f.warnings[0], /authentication rejected/);
    assert.equal(f.relay.listenerCount('connected'), 0);
  } finally {
    await f.close();
  }
});

test('missing AUTH acknowledgement times out without leaking application traffic', async () => {
  const f = await fixture(80);
  try {
    const frames: any[][] = [];
    const connection = once(f.server, 'connection');
    f.relay.connect();
    const published = assert.rejects(f.relay.publish(f.publication), /authentication timed out/);
    const [socket] = (await connection) as [WebSocket];
    challenge(socket, frames);
    await published;
    assert.deepEqual(
      frames.map((frame) => frame[0]),
      ['AUTH'],
    );
    assert.equal(f.relay.listenerCount('connected'), 0);
  } finally {
    await f.close();
  }
});

test('reconnect requires a fresh challenge acknowledgement and restores the subscription', async () => {
  const f = await fixture();
  try {
    const firstFrames: any[][] = [];
    const firstConnection = once(f.server, 'connection');
    f.relay.subscribe([{ kinds: [9], '#h': ['arena'] }]);
    f.relay.connect();
    const [first] = (await firstConnection) as [WebSocket];
    challenge(first, firstFrames, 'first-challenge');
    await until(() => firstFrames.length > 0);
    const firstAuth = firstFrames[0][1];
    const ready = f.relay.waitUntilReady();
    first.send(JSON.stringify(['OK', firstAuth.id, true, '']));
    await ready;
    await until(() => firstFrames.some((frame) => frame[0] === 'REQ'));
    const disconnected = once(f.relay, 'disconnected');
    const secondConnection = once(f.server, 'connection');
    first.close();
    await disconnected;
    const published = f.relay.publish(f.publication);
    void published.catch(() => {});
    const [second] = (await secondConnection) as [WebSocket];
    const secondFrames: any[][] = [];
    challenge(second, secondFrames, 'second-challenge');
    await until(() => secondFrames.length > 0);
    const secondAuth = secondFrames[0][1];
    assert.notEqual(secondAuth.id, firstAuth.id);
    second.send(JSON.stringify(['OK', firstAuth.id, true, '']));
    await delay(25);
    assert.deepEqual(
      secondFrames.map((frame) => frame[0]),
      ['AUTH'],
    );
    second.send(JSON.stringify(['OK', secondAuth.id, true, '']));
    await until(() => secondFrames.some((frame) => frame[0] === 'EVENT'));
    assert.deepEqual(
      secondFrames.map((frame) => frame[0]),
      ['AUTH', 'REQ', 'EVENT'],
    );
    second.send(JSON.stringify(['OK', f.publication.id, true, '']));
    await published;
  } finally {
    await f.close();
  }
});

test('disconnect rejects an unacknowledged publication instead of replaying it on a new connection', async () => {
  const f = await fixture();
  try {
    const frames: any[][] = [];
    const connection = once(f.server, 'connection');
    f.relay.connect();
    const [socket] = (await connection) as [WebSocket];
    challenge(socket, frames);
    await until(() => frames.length > 0);
    const ready = f.relay.waitUntilReady();
    socket.send(JSON.stringify(['OK', frames[0][1].id, true, '']));
    await ready;
    const published = assert.rejects(
      f.relay.publish(f.publication),
      /connection closed before publication was acknowledged/,
    );
    await until(() => frames.some((frame) => frame[0] === 'EVENT'));
    socket.close();
    await published;
    assert.equal(f.relay.pending.size, 0);
  } finally {
    await f.close();
  }
});

test('closing while authentication is pending rejects waiters and clears listeners', async () => {
  const f = await fixture();
  try {
    const connection = once(f.server, 'connection');
    f.relay.connect();
    await connection;
    const ready = assert.rejects(
      f.relay.waitUntilReady(),
      /connection closed before authentication completed/,
    );
    f.relay.close();
    await ready;
    assert.equal(f.relay.listenerCount('connected'), 0);
    assert.equal(f.relay.listenerCount('authentication-failed'), 0);
    await assert.rejects(f.relay.publish(f.publication), /Relay closed/);
  } finally {
    await f.close();
  }
});

test('setup authenticates each profile author with its own key and a valid owner grant; retry preserves identities', async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'mk-setup-auth-'));
  const previous = {
    directory: process.env.MORTAL_KOMMIT_DATA_DIR,
    key: process.env.MORTAL_KOMMIT_OWNER_KEY,
  };
  process.env.MORTAL_KOMMIT_DATA_DIR = directory;
  process.env.MORTAL_KOMMIT_OWNER_KEY = Buffer.from(f.key).toString('hex');
  const profiles: Event[] = [];
  const failure: string[] = [];
  try {
    const cli = join(directory, 'buzz-fixture');
    await writeFile(
      cli,
      `#!${process.execPath}\nconst args=process.argv.slice(2);\nif(args.includes('list'))console.log(JSON.stringify([{name:'ARENA',channel_id:'arena-fixture'}]));\nelse if(args.includes('add-member'))console.log(JSON.stringify({accepted:true}));\nelse process.exit(1);\n`,
      { mode: 0o700 },
    );
    f.server.on('connection', (socket) => {
      let authenticated: string | null = null;
      socket.send(JSON.stringify(['AUTH', 'setup-challenge']));
      socket.on('message', async (data) => {
        const [kind, event] = JSON.parse(data.toString()) as [string, Event];
        try {
          assert.ok(verifyEvent(event));
          const grant = event.tags.find((tag) => tag[0] === 'auth');
          assert.ok(grant);
          assert.equal(grant[1], getPublicKey(f.key));
          assert.ok(
            schnorr.verify(
              Buffer.from(grant[3], 'hex'),
              sha256(new TextEncoder().encode(`nostr:agent-auth:${event.pubkey}:${grant[2]}`)),
              Buffer.from(grant[1], 'hex'),
            ),
          );
          assert.notEqual(
            event.pubkey,
            getPublicKey(f.key),
            'owner must not publish an agent profile through their own connection',
          );
          if (kind === 'AUTH') {
            assert.equal(event.kind, 22242);
            assert.deepEqual(
              event.tags.find((tag) => tag[0] === 'challenge'),
              ['challenge', 'setup-challenge'],
            );
            await delay(15);
            authenticated = event.pubkey;
          } else {
            assert.equal(kind, 'EVENT');
            assert.equal(event.kind, 0);
            assert.equal(event.pubkey, authenticated);
            profiles.push(event);
          }
          socket.send(JSON.stringify(['OK', event.id, true, '']));
        } catch (error) {
          failure.push(String(error));
          socket.send(JSON.stringify(['OK', event.id, false, String(error)]));
        }
      });
    });
    const defaults = Config.parse({});
    const config = Config.parse({
      relay: f.url,
      executables: { ...defaults.executables, buzz: cli },
    });
    await setupArena(config);
    const identitiesBefore = await readFile(join(directory, 'identities.json'), 'utf8');
    await setupArena(config);
    assert.equal(await readFile(join(directory, 'identities.json'), 'utf8'), identitiesBefore);
    assert.deepEqual(failure, []);
    assert.equal(profiles.length, 4);
    assert.deepEqual(
      profiles.map((event) => JSON.parse(event.content).name),
      ['ArenaClaude', 'ArenaCodex', 'ArenaClaude', 'ArenaCodex'],
    );
    assert.deepEqual(
      profiles.map((event) => event.pubkey),
      [
        config.fighters!.claude,
        config.fighters!.codex,
        config.fighters!.claude,
        config.fighters!.codex,
      ],
    );
    assert.equal(config.channelId, 'arena-fixture');
  } finally {
    if (previous.directory === undefined) delete process.env.MORTAL_KOMMIT_DATA_DIR;
    else process.env.MORTAL_KOMMIT_DATA_DIR = previous.directory;
    if (previous.key === undefined) delete process.env.MORTAL_KOMMIT_OWNER_KEY;
    else process.env.MORTAL_KOMMIT_OWNER_KEY = previous.key;
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
