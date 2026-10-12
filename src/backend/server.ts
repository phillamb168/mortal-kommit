import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Coordinator } from './coordinator.js';
import { dataDir, readConfig, privateWrite, safeError } from './config.js';
import { markdown } from './export.js';
import { syncFinisher } from '../core/ending.js';
import { demoMatch } from '../core/demo.js';
import { safePath } from './repository.js';
import { stopOwned } from './process.js';
import { startViewer, viewerIdentity } from './viewer.js';

export const packageRoot = () => {
  const d = dirname(fileURLToPath(import.meta.url));
  return d.endsWith('/backend') ? join(d, '../..') : join(d, '..');
};
// Linux containers frequently reuse the same PID after a restart. PID alone
// cannot distinguish an abandoned lock from the new process in that case.
async function processStamp(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    return `${boot}:${start}`;
  } catch {
    return null;
  }
}
export async function startServer(port = 0) {
  const config = readConfig();
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Control port must be an integer between 0 and 65535');
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const lockPath = join(dataDir(), 'service.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch {
    let alive = false;
    try {
      const saved = JSON.parse(await readFile(lockPath, 'utf8'));
      const pid = typeof saved === 'number' ? saved : saved.pid;
      if (Number.isSafeInteger(pid) && pid > 0) {
        process.kill(pid, 0);
        const current = await processStamp(pid);
        alive = !saved.stamp || !current || saved.stamp === current;
      }
    } catch {}
    if (alive) throw new Error('An ARENA service already owns this data directory.');
    await unlink(lockPath).catch(() => {});
    lock = await open(lockPath, 'wx', 0o600);
  }
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, stamp: await processStamp(process.pid) }),
  );
  await lock.close();
  const store = new Store(dataDir());
  for (const match of store.list())
    if (match.status === 'complete' && syncFinisher(match)) store.save(match);
  const token = randomBytes(32).toString('hex');
  let base = '';
  let coordinator: Coordinator;
  const clients = new Set<ServerResponse>();
  const viewerToken = randomBytes(32).toString('hex');
  let gateway: Awaited<ReturnType<typeof startViewer>> | undefined;
  let publicIdentity: ReturnType<typeof viewerIdentity> | undefined;
  const publicViewerUrl = () =>
    config.viewer && publicIdentity
      ? `${config.viewer.publicUrl}/#session=${publicIdentity.token()}`
      : null;
  const writeService = () =>
    privateWrite(join(dataDir(), 'service.json'), {
      pid: process.pid,
      base,
      token,
      viewerToken,
      publicViewerUrl: publicViewerUrl(),
      startedAt,
    });
  const startedAt = Date.now();
  const eq = (a: string, b: string) =>
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const json = (res: ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const body = async (req: IncomingMessage) => {
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (Buffer.byteLength(text) > 32768) throw new Error('Request too large');
    }
    return JSON.parse(text || '{}');
  };
  const server = createServer(async (req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      if (req.headers.host !== new URL(base).host) return json(res, { error: 'Invalid host' }, 403);
      if (req.headers.origin && req.headers.origin !== base)
        return json(res, { error: 'Invalid origin' }, 403);
      const url = new URL(req.url ?? '/', base);
      const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const cookie =
        req.headers.cookie
          ?.split(';')
          .map((s) => s.trim())
          .find((s) => s.startsWith('mk_session='))
          ?.slice(11) ?? '';
      if (url.pathname === '/api/session' && req.method === 'POST') {
        const data = await body(req);
        if (
          typeof data.token !== 'string' ||
          (!eq(data.token, token) && !eq(data.token, viewerToken))
        )
          return json(res, { error: 'Invalid session capability' }, 403);
        res.setHeader(
          'Set-Cookie',
          `mk_session=${data.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
        );
        return json(res, { ok: true });
      }
      const ownerAuthorized = eq(bearer, token) || eq(cookie, token),
        viewerAuthorized = eq(bearer, viewerToken) || eq(cookie, viewerToken);
      if (url.pathname.startsWith('/api/') && !ownerAuthorized && !viewerAuthorized)
        return json(res, { error: 'Open the arena URL printed by the CLI to authenticate.' }, 401);
      if (url.pathname.startsWith('/api/') && !ownerAuthorized) {
        if (url.pathname === '/api/demo' && req.method === 'POST') {
          const demo = store.get('demo-mortal-kommit');
          return demo
            ? json(res, demo)
            : json(res, { error: 'Ask the host to create a demo.' }, 403);
        }
        const readable =
          url.pathname === '/api/matches' ||
          url.pathname === '/api/events' ||
          /^\/api\/matches\/[a-zA-Z0-9-]+(?:\/export\.(json|md))?$/.test(url.pathname);
        if (req.method !== 'GET' || !readable)
          return json(
            res,
            {
              error:
                'This arena link is view-only. Request reviews in ARENA; service controls remain local.',
            },
            403,
          );
      }
      if (url.pathname === '/api/status')
        return json(res, {
          pid: process.pid,
          warning: coordinator.warning,
          channelId: coordinator.config.channelId,
          liveConfigured: !!coordinator.config.fighters,
          viewer: config.viewer
            ? { publicUrl: config.viewer.publicUrl, listen: gateway?.local }
            : null,
        });
      if (url.pathname === '/api/viewer' && req.method === 'GET')
        return json(res, { url: publicViewerUrl() });
      if (url.pathname === '/api/viewer/rotate' && req.method === 'POST') {
        if (!publicIdentity || !gateway)
          return json(res, { error: 'No configured viewer is running.' }, 400);
        publicIdentity.rotate();
        gateway.disconnect();
        writeService();
        return json(res, { url: publicViewerUrl() });
      }
      if (url.pathname === '/api/matches' && req.method === 'GET')
        return json(
          res,
          store.list().map((m) => ({
            id: m.id,
            title: m.title,
            status: m.status,
            demo: m.demo,
            createdAt: m.createdAt,
          })),
        );
      if (url.pathname === '/api/reviews' && req.method === 'POST')
        return json(res, await coordinator.enqueue(await body(req)), 202);
      if (url.pathname === '/api/demo' && req.method === 'POST') {
        let demo = store.get('demo-mortal-kommit');
        if (!demo) {
          demo = demoMatch();
          store.save(demo);
        }
        return json(res, demo);
      }
      if (url.pathname === '/api/stop' && req.method === 'POST') {
        json(res, { ok: true });
        setTimeout(() => void close(), 100);
        return;
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write('retry: 1000\n\n');
        clients.add(res);
        const id = url.searchParams.get('match');
        if (id) {
          const m = store.get(id);
          if (m) res.write(`id: ${m.events.length}\nevent: match\ndata: ${JSON.stringify(m)}\n\n`);
        }
        const listener = (m: any) => {
          if (!id || m.id === id)
            res.write(`id: ${m.events.length}\nevent: match\ndata: ${JSON.stringify(m)}\n\n`);
        };
        store.on('change', listener);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        req.on('close', () => {
          clearInterval(heartbeat);
          clients.delete(res);
          store.off('change', listener);
        });
        return;
      }
      const matchPath = url.pathname.match(
        /^\/api\/matches\/([a-zA-Z0-9-]+)(?:\/(export\.(json|md)))?$/,
      );
      if (matchPath) {
        const m = store.get(matchPath[1]);
        if (!m) return json(res, { error: 'Match not found' }, 404);
        if (matchPath[2]) {
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="mortal-kommit-${m.id}.${matchPath[3]}"`,
          );
          res.setHeader(
            'Content-Type',
            matchPath[3] === 'md' ? 'text/markdown; charset=utf-8' : 'application/json',
          );
          res.end(matchPath[3] === 'md' ? markdown(m) : JSON.stringify(m, null, 2));
          return;
        }
        return json(res, m);
      }
      if (req.method !== 'GET') return json(res, { error: 'Unknown endpoint' }, 404);
      const assets = url.pathname.startsWith('/assets/');
      const directory = assets
        ? (readConfig().assetsDir ?? join(packageRoot(), 'assets'))
        : join(packageRoot(), 'dist/web');
      const file = assets
        ? url.pathname.slice(8)
        : url.pathname === '/'
          ? 'index.html'
          : url.pathname.slice(1);
      const path = safePath(directory, decodeURIComponent(file));
      const mime: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
        '.json': 'application/json',
        '.webp': 'image/webp',
      };
      if (!mime[extname(path)]) return json(res, { error: 'Not found' }, 404);
      if ((await stat(path)).size > 20 * 1024 * 1024) throw new Error('Asset too large');
      res.setHeader('Content-Type', mime[extname(path)]);
      res.end(await readFile(path));
    } catch (e) {
      json(res, { error: safeError(e) }, 400);
    }
  });
  let url = '';
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server address unavailable');
    base = `http://127.0.0.1:${address.port}`;
    url = `${base}/#session=${token}`;
    if (config.viewer) {
      publicIdentity = viewerIdentity();
      gateway = await startViewer({
        host: config.viewer.host,
        port: config.viewer.port,
        publicOrigin: () => config.viewer!.publicUrl,
        token: publicIdentity.token,
        upstream: async () => ({ base, token: viewerToken }),
      });
    }
    coordinator = new Coordinator(
      store,
      () => publicViewerUrl() ?? `${base}/#session=${viewerToken}`,
    );
    await coordinator.start();
    writeService();
  } catch (error) {
    await gateway?.close();
    coordinator!?.close();
    server.close();
    server.closeAllConnections();
    store.close();
    await unlink(lockPath).catch(() => {});
    throw error;
  }
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    coordinator.close();
    await gateway?.close();
    for (const res of clients) res.end();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    stopOwned();
    store.close();
    await unlink(lockPath).catch(() => {});
  }
  const onSignal = () => void close();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return { server, store, coordinator, url, base, token, gateway, publicViewerUrl, close };
}
