import { createServer, request as httpRequest, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, privateWrite } from './config.js';

export function sameCapability(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Persist independently from the local control token so shared links survive restarts.
export function viewerIdentity() {
  const path = join(dataDir(), 'viewer-key.json');
  let token: string;
  if (existsSync(path)) {
    token = JSON.parse(readFileSync(path, 'utf8')).token;
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token))
      throw new Error('Invalid viewer-key.json; restore the private viewer credential.');
  } else {
    token = randomBytes(32).toString('hex');
    privateWrite(path, { token });
  }
  return {
    token: () => token,
    rotate: () => {
      const next = randomBytes(32).toString('hex');
      privateWrite(path, { token: next });
      token = next;
    },
  };
}

export type ViewerOptions = {
  host: string;
  port: number;
  publicOrigin: () => string;
  token: () => string;
  upstream: () => Promise<{ base: string; token: string }>;
  // Only the ngrok process has this loopback-only shutdown capability.
  localControl?: { token: string; stop: () => void };
};

// Both permanent hosting and ngrok use this exact view-only boundary.
export async function startViewer(options: ViewerOptions) {
  let local = '';
  const answer = (res: ServerResponse, status: number, value: unknown) => {
    if (res.destroyed) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//'))
        return answer(res, 400, { error: 'Invalid request target' });
      const path = new URL(req.url, 'http://127.0.0.1');
      if (path.pathname === '/_local/stop' && options.localControl) {
        if (
          req.method !== 'POST' ||
          req.headers.host !== new URL(local).host ||
          req.headers.origin ||
          !sameCapability(req.headers.authorization ?? '', `Bearer ${options.localControl.token}`)
        )
          return answer(res, 403, { error: 'Local control only' });
        answer(res, 200, { ok: true });
        setTimeout(options.localControl.stop, 100);
        return;
      }
      const origin = options.publicOrigin();
      if (!origin) return answer(res, 503, { error: 'Viewer endpoint is starting.' });
      const health = path.pathname === '/healthz' && req.method === 'GET';
      const healthHosts = [
        new URL(local).host,
        ...['127.0.0.1', 'localhost', '[::1]'].map((host) => `${host}:${new URL(local).port}`),
      ];
      if (
        req.headers.host !== new URL(origin).host &&
        !(health && healthHosts.includes(req.headers.host ?? ''))
      )
        return answer(res, 403, { error: 'Invalid host' });
      // Never trust client-supplied Forwarded/X-Forwarded-* headers.
      if (req.headers.origin && req.headers.origin !== origin)
        return answer(res, 403, { error: 'Invalid origin' });
      if (path.pathname === '/api/session' && req.method === 'POST') {
        let text = '';
        for await (const chunk of req) {
          text += chunk;
          if (Buffer.byteLength(text) > 4096)
            return answer(res, 413, { error: 'Request too large' });
        }
        let input;
        try {
          input = JSON.parse(text);
        } catch {
          return answer(res, 400, { error: 'Invalid JSON' });
        }
        if (typeof input?.token !== 'string' || !sameCapability(input.token, options.token()))
          return answer(res, 403, { error: 'Use the authenticated viewer link.' });
        const secure = new URL(origin).protocol === 'https:' ? '; Secure' : '';
        res.setHeader(
          'Set-Cookie',
          `mk_preview=${options.token()}; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=86400`,
        );
        return answer(res, 200, { ok: true });
      }
      const cookie =
        req.headers.cookie
          ?.split(';')
          .map((s) => s.trim())
          .find((s) => s.startsWith('mk_preview='))
          ?.slice(11) ?? '';
      if (path.pathname.startsWith('/api/') && !sameCapability(cookie, options.token()))
        return answer(res, 401, { error: 'Open the authenticated viewer link.' });
      const permitted =
        path.pathname === '/' ||
        /^\/(main\.(js|css)|assets\/[a-zA-Z0-9_.-]+)$/.test(path.pathname) ||
        path.pathname === '/api/matches' ||
        path.pathname === '/api/events' ||
        /^\/api\/matches\/[a-zA-Z0-9-]+(?:\/export\.(json|md))?$/.test(path.pathname);
      let upstreamPath = path.pathname + path.search;
      if (health) upstreamPath = '/api/matches';
      else if (path.pathname === '/api/demo' && req.method === 'POST')
        upstreamPath = '/api/matches/demo-mortal-kommit';
      else if (!permitted || req.method !== 'GET')
        return answer(res, 403, {
          error:
            'This viewer is read-only. Request reviews in ARENA; service controls remain local.',
        });
      const service = await options.upstream();
      const base = new URL(service.base);
      if (
        base.protocol !== 'http:' ||
        base.hostname !== '127.0.0.1' ||
        base.username ||
        base.password
      )
        throw new Error('Viewer upstream must be the local arena service');
      const upstream = httpRequest(
        new URL(upstreamPath, base),
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${service.token}`,
            ...(req.headers['last-event-id']
              ? { 'Last-Event-ID': String(req.headers['last-event-id']) }
              : {}),
          },
        },
        (response) => {
          response.on('error', () => res.destroy());
          if (health) {
            response.resume();
            return answer(res, response.statusCode === 200 ? 200 : 503, {
              ok: response.statusCode === 200,
            });
          }
          const headers = { ...response.headers };
          delete headers['set-cookie'];
          delete headers['connection'];
          headers['cache-control'] = 'no-store, no-transform';
          headers['x-accel-buffering'] = 'no';
          res.writeHead(response.statusCode ?? 502, headers);
          response.pipe(res);
        },
      );
      upstream.setTimeout(30000, () => upstream.destroy(new Error('Local service timed out')));
      upstream.on('error', () =>
        answer(res, 503, { error: 'The local arena service is unavailable.' }),
      );
      res.on('close', () => upstream.destroy());
      upstream.end();
    } catch {
      answer(res, 503, { error: 'The local arena service is unavailable.' });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Viewer address unavailable');
  const host = address.address.includes(':') ? `[${address.address}]` : address.address;
  local = `http://${host}:${address.port}`;
  return {
    server,
    local,
    disconnect: () => server.closeAllConnections(),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
