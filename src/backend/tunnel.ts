import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { dataDir, privateWrite } from './config.js';
import { startViewer } from './viewer.js';

export function sharedArenaUrl(localViewerUrl: string): string {
  try {
    const tunnel = JSON.parse(readFileSync(join(dataDir(), 'tunnel.json'), 'utf8'));
    if (!Number.isSafeInteger(tunnel.pid) || tunnel.pid <= 0) return localViewerUrl;
    process.kill(tunnel.pid, 0);
    const url = new URL(tunnel.url);
    if (
      url.protocol === 'https:' &&
      url.origin === tunnel.publicOrigin &&
      /^[0-9a-f]{64}$/.test(new URLSearchParams(url.hash.slice(1)).get('session') ?? '')
    )
      return url.toString();
  } catch {}
  return localViewerUrl;
}

// A separate viewer gateway. The public capability never authorizes local CLI controls.
export async function startTunnel() {
  const viewer = randomBytes(32).toString('hex'),
    control = randomBytes(32).toString('hex');
  let publicOrigin = '',
    closing = false;
  const gateway = await startViewer({
    host: '127.0.0.1',
    port: 0,
    publicOrigin: () => publicOrigin,
    token: () => viewer,
    upstream: async () => {
      const service = JSON.parse(await readFile(join(dataDir(), 'service.json'), 'utf8'));
      if (!service.viewerToken) throw new Error('Restart ARENA to enable the viewer gateway.');
      return { base: service.base, token: service.viewerToken };
    },
    localControl: { token: control, stop: close },
  });
  const local = gateway.local;
  const child = spawn(
    'ngrok',
    ['http', local, '--inspect=false', '--log=stdout', '--log-format=json', '--name=mortal-kommit'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let failure = '';
  child.stderr.on('data', (c) => (failure = (failure + c.toString()).slice(-2000)));
  function close() {
    if (closing) return;
    closing = true;
    child.kill('SIGTERM');
    void gateway.close();
  }
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  child.once('error', close);
  child.once('exit', () => {
    if (!closing) {
      console.error(failure || 'ngrok stopped');
      close();
    }
  });
  const ready = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('ngrok did not report an endpoint within 25 seconds')),
      25000,
    );
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(failure || 'ngrok exited before starting the tunnel'));
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.url && /^https:\/\//.test(message.url)) {
          clearTimeout(timer);
          resolve(message.url);
        }
        if (message.err) failure = String(message.err);
      } catch {}
    });
  }).catch((e) => {
    close();
    throw e;
  });
  publicOrigin = new URL(ready).origin;
  const url = `${publicOrigin}/?match=demo-mortal-kommit#session=${viewer}`;
  privateWrite(join(dataDir(), 'tunnel.json'), {
    pid: process.pid,
    local,
    control,
    url,
    publicOrigin,
    startedAt: Date.now(),
  });
  console.log(url);
  return { url, close };
}
