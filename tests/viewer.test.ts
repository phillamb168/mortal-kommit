import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Config, readConfig } from '../src/backend/config.js';
import { startServer } from '../src/backend/server.js';
import { startViewer } from '../src/backend/viewer.js';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';

// Node fetch replaces Host; use the HTTP client to exercise nginx-style Host forwarding.
function proxyFetch(url: string, options: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: options.method ?? 'GET',
        headers: Object.fromEntries(new Headers(options.headers).entries()),
      },
      (response) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers))
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        resolve(
          new Response(Readable.toWeb(response) as ReadableStream, {
            status: response.statusCode,
            headers,
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

async function isolated(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'mk-viewer-'));
  const names = [
    'MORTAL_KOMMIT_DATA_DIR',
    'MORTAL_KOMMIT_PUBLIC_URL',
    'MORTAL_KOMMIT_VIEWER_HOST',
    'MORTAL_KOMMIT_VIEWER_PORT',
  ];
  const before = names.map((name) => process.env[name]);
  names.forEach((name) => delete process.env[name]);
  process.env.MORTAL_KOMMIT_DATA_DIR = dir;
  try {
    await run(dir);
  } finally {
    names.forEach((name, i) => {
      if (before[i] === undefined) delete process.env[name];
      else process.env[name] = before[i];
    });
    await rm(dir, { recursive: true, force: true });
  }
}

test('viewer configuration validates exact origins and supports container environment overrides', async () => {
  assert.equal(Config.parse({}).viewer, null);
  assert.deepEqual(Config.parse({ viewer: { publicUrl: 'https://arena.example.test/' } }).viewer, {
    publicUrl: 'https://arena.example.test',
    host: '127.0.0.1',
    port: 8787,
  });
  for (const publicUrl of [
    'http://arena.example.test',
    'ftp://arena.example.test',
    'https://user:pass@arena.example.test',
    'https://arena.example.test/arena',
    'https://arena.example.test/?x=1',
    'https://arena.example.test/#session=secret',
  ])
    assert.equal(Config.safeParse({ viewer: { publicUrl } }).success, false, publicUrl);
  for (const publicUrl of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787'])
    assert.ok(Config.safeParse({ viewer: { publicUrl } }).success);
  assert.equal(
    Config.safeParse({ viewer: { publicUrl: 'https://arena.example.test', host: 'https://bad' } })
      .success,
    false,
  );
  assert.equal(
    Config.safeParse({ viewer: { publicUrl: 'https://arena.example.test', port: 65536 } }).success,
    false,
  );
  await isolated(async (dir) => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ viewer: { publicUrl: 'https://original.example.test' } }),
    );
    process.env.MORTAL_KOMMIT_PUBLIC_URL = 'https://arena.example.test';
    process.env.MORTAL_KOMMIT_VIEWER_HOST = '0.0.0.0';
    process.env.MORTAL_KOMMIT_VIEWER_PORT = '9000';
    assert.deepEqual(readConfig().viewer, {
      publicUrl: 'https://arena.example.test',
      host: '0.0.0.0',
      port: 9000,
    });
    process.env.MORTAL_KOMMIT_VIEWER_PORT = '';
    assert.throws(() => readConfig());
  });
});

test('permanent viewer serves authenticated replay, exports and streaming; rejects host/origin spoofing and controls', async () => {
  await isolated(async (dir) => {
    const origin = 'https://arena.example.test';
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ viewer: { publicUrl: origin, port: 0 } }),
    );
    // A stale or still-running tunnel must not override the configured domain.
    await writeFile(
      join(dir, 'tunnel.json'),
      JSON.stringify({
        pid: process.pid,
        publicOrigin: 'https://tunnel.example.test',
        url: `https://tunnel.example.test/#session=${'f'.repeat(64)}`,
      }),
    );
    let s = await startServer();
    const control = () => ({
      Authorization: `Bearer ${s.token}`,
      'Content-Type': 'application/json',
    });
    const browse = (path: string, options: RequestInit = {}) =>
      proxyFetch(`${s.gateway!.local}${path}`, {
        ...options,
        headers: { Host: new URL(origin).host, ...options.headers },
      });
    const session = (token: string) =>
      browse('/api/session', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    try {
      const url = new URL(s.coordinator.matchUrl('demo-mortal-kommit'));
      assert.equal(url.origin, origin);
      const token = new URLSearchParams(url.hash.slice(1)).get('session')!;
      assert.notEqual(token, s.token);
      assert.equal((await stat(join(dir, 'viewer-key.json'))).mode & 0o777, 0o600);
      const home = await browse('/');
      const homeBody = await home.text();
      assert.equal(home.status, 200, `Viewer did not serve the browser app: ${homeBody}`);
      assert.match(homeBody, /<title>Mortal Kommit/);
      assert.match(await browse('/main.js').then((r) => r.text()), /Mortal Kommit/);
      assert.equal((await browse('/assets/claude.png')).status, 200);
      assert.equal((await browse('/healthz')).status, 200);
      assert.equal((await fetch(`${s.gateway!.local}/healthz`)).status, 200);
      assert.equal((await browse('/api/matches')).status, 401);
      assert.equal((await session('é'.repeat(64))).status, 403);
      assert.equal(
        (await session(s.token)).status,
        403,
        'owner token cannot authenticate to viewer',
      );
      assert.equal(
        (await browse('/api/session', { method: 'POST', body: 'invalid json' })).status,
        400,
      );
      assert.equal(
        (
          await browse('/api/session', {
            method: 'POST',
            body: JSON.stringify({ token: 'x'.repeat(4100) }),
          })
        ).status,
        413,
      );
      assert.equal(
        (await browse('/', { headers: { Origin: 'https://evil.example.test' } })).status,
        403,
      );
      assert.equal(
        (
          await browse('/', {
            headers: {
              Host: 'evil.example.test',
              'X-Forwarded-Host': new URL(origin).host,
              'X-Forwarded-Proto': 'https',
            },
          })
        ).status,
        403,
      );
      const login = await session(token);
      assert.equal(login.status, 200);
      const setCookie = login.headers.get('set-cookie')!;
      for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict'])
        assert.ok(setCookie.includes(attr));
      const cookie = { Cookie: setCookie.split(';')[0] };
      // Viewer demo is read-only, even before a demo exists.
      assert.equal((await browse('/api/demo', { method: 'POST', headers: cookie })).status, 404);
      const demo = (await fetch(`${s.base}/api/demo`, {
        method: 'POST',
        headers: control(),
        body: '{}',
      }).then((r) => r.json())) as any;
      assert.equal((await browse('/api/demo', { method: 'POST', headers: cookie })).status, 200);
      for (const path of [
        '/api/status',
        '/api/viewer',
        '/api/stop',
        '/api/reviews',
        '/api/viewer/rotate',
        '/_local/stop',
        '/service.json',
        '/viewer-key.json',
      ]) {
        for (const method of ['GET', 'POST'])
          assert.equal(
            (
              await browse(path, {
                method,
                headers: { ...cookie, Authorization: `Bearer ${s.token}` },
              })
            ).status,
            403,
            path,
          );
      }
      for (const extension of ['json', 'md']) {
        const response = await browse(`/api/matches/${demo.id}/export.${extension}`, {
          headers: cookie,
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-disposition')!, /attachment/);
        assert.ok((await response.text()).includes(extension === 'md' ? 'SCRIPTED DEMO' : demo.id));
      }
      for (let i = 0; i < 2; i++) {
        const response = await browse(`/api/events?match=${demo.id}`, {
          headers: { ...cookie, 'Last-Event-ID': '7' },
        });
        assert.equal(response.headers.get('x-accel-buffering'), 'no');
        assert.match(response.headers.get('content-type')!, /text\/event-stream/);
        const reader = response.body!.getReader();
        let text = '';
        while (!text.includes('event: match'))
          text += new TextDecoder().decode((await reader.read()).value);
        assert.ok(text.includes(demo.id));
        // A new store change crosses the gateway immediately, not only at disconnect.
        const changed = s.store.get(demo.id)!;
        changed.title = `Streaming update ${i}`;
        s.store.save(changed);
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            const timeout = setTimeout(() => reject(new Error('SSE was buffered')), 2000);
            timeout.unref();
          }),
        ]);
        assert.ok(new TextDecoder().decode(next.value).includes(changed.title));
        await reader.cancel();
      }
      const oldControl = s.token;
      await s.close();
      s = await startServer();
      assert.notEqual(s.token, oldControl);
      assert.equal(
        new URL(s.publicViewerUrl()!).hash,
        `#session=${token}`,
        'public link survives restart',
      );
      const replay = (await browse(`/api/matches/${demo.id}`, { headers: cookie }).then((r) =>
        r.json(),
      )) as any;
      assert.deepEqual(replay.events, demo.events);
      assert.equal(replay.analysisUsage.calls, 0);
      const active = await browse(`/api/events?match=${demo.id}`, { headers: cookie });
      const activeReader = active.body!.getReader();
      await activeReader.read();
      const rotated = (await fetch(`${s.base}/api/viewer/rotate`, {
        method: 'POST',
        headers: control(),
        body: '{}',
      }).then((r) => r.json())) as any;
      assert.notEqual(rotated.url, `${origin}/#session=${token}`);
      // Active viewers are disconnected at rotation, not allowed to retain an SSE stream.
      await Promise.race([
        (async () => {
          try {
            while (!(await activeReader.read()).done) {}
          } catch {}
        })(),
        new Promise<never>((_, reject) => {
          const timeout = setTimeout(() => reject(new Error('Old stream stayed open')), 2000);
          timeout.unref();
        }),
      ]);
      assert.equal((await browse('/api/matches', { headers: cookie })).status, 401);
      assert.equal((await session(token)).status, 403);
      const nextToken = new URLSearchParams(new URL(rotated.url).hash.slice(1)).get('session')!;
      assert.equal((await session(nextToken)).status, 200);
      assert.equal(
        JSON.parse(await readFile(join(dir, 'service.json'), 'utf8')).publicViewerUrl,
        rotated.url,
      );
      assert.equal(new URL(s.coordinator.matchUrl('next-review')).hash, `#session=${nextToken}`);
    } finally {
      await s.close();
    }
  });
});

test('viewer bind failures clean up the control service and release its lock for a retry', async () => {
  await isolated(async (dir) => {
    const blocker = await startViewer({
      host: '127.0.0.1',
      port: 0,
      publicOrigin: () => 'https://arena.example.test',
      token: () => 'f'.repeat(64),
      upstream: async () => {
        throw new Error('unavailable');
      },
    });
    const port = Number(new URL(blocker.local).port);
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ viewer: { publicUrl: 'https://arena.example.test', port } }),
    );
    try {
      await assert.rejects(startServer(), /EADDRINUSE/);
      await assert.rejects(stat(join(dir, 'service.lock')), /ENOENT/);
    } finally {
      await blocker.close();
    }
    const server = await startServer();
    await server.close();
  });
});

test('shared ngrok gateway handles dynamic origin, backend outages and loopback-only shutdown', async () => {
  let origin = '',
    stopped = false;
  const control = 'a'.repeat(64);
  const gateway = await startViewer({
    host: '127.0.0.1',
    port: 0,
    publicOrigin: () => origin,
    token: () => 'b'.repeat(64),
    upstream: async () => {
      throw new Error('unavailable');
    },
    localControl: {
      token: control,
      stop: () => {
        stopped = true;
      },
    },
  });
  try {
    assert.equal((await fetch(gateway.local)).status, 503);
    origin = 'https://tunnel.example.test';
    assert.equal(
      (await proxyFetch(`${gateway.local}/healthz`, { headers: { Host: 'tunnel.example.test' } }))
        .status,
      503,
    );
    assert.equal(
      (
        await proxyFetch(`${gateway.local}/_local/stop`, {
          method: 'POST',
          headers: { Host: 'tunnel.example.test', Authorization: `Bearer ${control}` },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${gateway.local}/_local/stop`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${control}` },
        })
      ).status,
      200,
    );
    await new Promise((resolve) => setTimeout(resolve, 130));
    assert.equal(stopped, true);
  } finally {
    await gateway.close();
  }
});
