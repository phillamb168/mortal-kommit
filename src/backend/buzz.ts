import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import {
  finalizeEvent,
  verifyEvent,
  getPublicKey,
  generateSecretKey,
  nip19,
  nip44,
  type Event,
} from 'nostr-tools';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { run } from './process.js';
import { dataDir, privateWrite, saveConfig, type Config } from './config.js';

export function ownerKey(): Uint8Array {
  const key = process.env.MORTAL_KOMMIT_OWNER_KEY;
  if (!key)
    throw new Error(
      'Set MORTAL_KOMMIT_OWNER_KEY locally to the Buzz owner’s authorized hex or nsec key, then restart the arena service. It is required for setup and owner-only NIP-AM telemetry. Do not paste it into chat.',
    );
  if (key.startsWith('nsec1')) {
    const decoded = nip19.decode(key);
    if (decoded.type === 'nsec') return decoded.data;
  }
  if (/^[0-9a-f]{64}$/i.test(key)) return Uint8Array.from(Buffer.from(key, 'hex'));
  throw new Error('MORTAL_KOMMIT_OWNER_KEY must be a hex secret key or nsec.');
}
export function hex(key: Uint8Array) {
  return Buffer.from(key).toString('hex');
}
export function validSignedEvent(e: Event) {
  try {
    const { id, pubkey, created_at, kind, tags, content, sig } = e;
    return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig });
  } catch {
    return false;
  }
}
export function httpRelay(url: string) {
  const u = new URL(url);
  u.protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
  return u.toString().replace(/\/$/, '');
}
export async function buzz(
  config: Config,
  args: string[],
  key: Uint8Array,
  input?: string,
  auth?: string[],
) {
  const env = {
    ...process.env,
    BUZZ_PRIVATE_KEY: hex(key),
    BUZZ_RELAY_URL: httpRelay(config.relay),
  };
  if (auth) (env as NodeJS.ProcessEnv).BUZZ_AUTH_TAG = JSON.stringify(auth);
  return JSON.parse(
    await run(config.executables.buzz, ['--format', 'json', ...args], {
      env,
      input,
      max: 8 * 1024 * 1024,
    }),
  );
}
// The same documented /query HTTP bridge and NIP-98 envelope used by buzz-cli.
// Raw events retain NIP-OA identity tags, which `users get` omits in its projection.
export async function buzzQuery(
  config: Config,
  filter: Record<string, unknown>,
  key: Uint8Array,
): Promise<Event[]> {
  const url = `${httpRelay(config.relay)}/query`,
    body = JSON.stringify([filter]);
  const auth = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      content: '',
      tags: [
        ['u', url],
        ['method', 'POST'],
        ['nonce', randomUUID()],
        ['payload', hex(sha256(new TextEncoder().encode(body)))],
      ],
    },
    key,
  );
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: `Nostr ${Buffer.from(JSON.stringify(auth)).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  if (!response.ok) throw new Error(`Buzz identity lookup failed (HTTP ${response.status})`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Buzz identity lookup returned no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512 * 1024) throw new Error('Buzz identity lookup exceeds its size limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const events: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(events) || events.some((e) => !validSignedEvent(e)))
    throw new Error('Buzz identity lookup returned invalid signed events');
  return events;
}
export interface Identities {
  claude: { key: string; pubkey: string; auth: string[] };
  codex: { key: string; pubkey: string; auth: string[] };
}
export function identities(): Identities {
  return JSON.parse(readFileSync(join(dataDir(), 'identities.json'), 'utf8'));
}

export class Relay extends EventEmitter {
  socket: WebSocket | null = null;
  closed = false;
  backoff = 500;
  timer: NodeJS.Timeout | null = null;
  pending = new Map<
    string,
    { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  filters: unknown[] = [];
  private authenticated = false;
  private authId: string | null = null;
  private authTimer: NodeJS.Timeout | null = null;
  private subscriptionIds = new Set<string>();
  private subscriptionVersion = 0;
  constructor(
    public url: string,
    private key: Uint8Array,
    private options: { authTag?: string[]; authenticationTimeoutMs?: number } = {},
  ) {
    super();
  }
  private get authenticationTimeoutMs() {
    return this.options.authenticationTimeoutMs ?? 12000;
  }
  connect() {
    if (
      this.closed ||
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    )
      return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.resetAuthentication();
    const socket = (this.socket = new WebSocket(this.url, { maxPayload: 256 * 1024 }));
    socket.on('open', () => {
      // Opening the transport is not NIP-42 authentication. Wait for the relay's
      // challenge and its positive OK for our signed AUTH event before any work.
      this.authTimer = setTimeout(
        () =>
          this.failAuthentication(
            new Error('Buzz authentication timed out waiting for the NIP-42 handshake'),
          ),
        this.authenticationTimeoutMs,
      );
    });
    socket.on('message', (data) => {
      if (this.socket === socket && !this.closed)
        void this.receive(data.toString()).catch((e) => this.emit('warning', String(e)));
    });
    socket.on('error', (error) => {
      if (!this.closed) this.emit('warning', `Buzz connection failed: ${error.message}`);
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.resetAuthentication();
      this.rejectPending(new Error('Buzz connection closed before publication was acknowledged'));
      this.emit('disconnected');
      if (!this.closed) {
        this.timer = setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(30000, this.backoff * 2);
      }
    });
  }
  private resetAuthentication() {
    this.authenticated = false;
    this.authId = null;
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
  }
  private rejectPending(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  private failAuthentication(error: Error) {
    this.resetAuthentication();
    this.rejectPending(error);
    this.emit('authentication-failed', error);
    this.emit('warning', error.message);
    this.socket?.close();
  }
  waitUntilReady(timeoutMs = this.authenticationTimeoutMs): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Relay closed'));
    if (this.authenticated && this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off('connected', ready);
        this.off('authentication-failed', failed);
        this.off('disconnected', disconnected);
      };
      const ready = () => {
        cleanup();
        resolve();
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const disconnected = () =>
        failed(new Error('Buzz connection closed before authentication completed'));
      const timer = setTimeout(
        () => failed(new Error('Buzz authentication timed out waiting for the NIP-42 handshake')),
        timeoutMs,
      );
      this.once('connected', ready);
      this.once('authentication-failed', failed);
      this.once('disconnected', disconnected);
    });
  }
  send(data: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(data));
  }
  subscribe(filters?: unknown[]) {
    if (filters) {
      this.filters = filters;
      this.subscriptionVersion++;
    }
    if (!this.authenticated) return;
    // Buzz routes an entire REQ as community-global if any filter lacks #h.
    // Keep each channel/telemetry filter on its own subscription so live
    // channel events and owner-only global metrics both reach the observer.
    const next = new Set(
      this.filters.map((_, index) => (index === 0 ? 'mortal-kommit' : `mortal-kommit-${index}`)),
    );
    for (const id of this.subscriptionIds) if (!next.has(id)) this.send(['CLOSE', id]);
    this.subscriptionIds = next;
    this.filters.forEach((filter, index) =>
      this.send(['REQ', index === 0 ? 'mortal-kommit' : `mortal-kommit-${index}`, filter]),
    );
  }
  async receive(data: string) {
    const frame = JSON.parse(data);
    if (!Array.isArray(frame)) return;
    if (frame[0] === 'AUTH' && typeof frame[1] === 'string') {
      this.authenticated = false;
      if (!this.authTimer)
        this.authTimer = setTimeout(
          () =>
            this.failAuthentication(
              new Error('Buzz authentication timed out waiting for the NIP-42 handshake'),
            ),
          this.authenticationTimeoutMs,
        );
      const e = finalizeEvent(
        {
          kind: 22242,
          content: '',
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['relay', this.url],
            ['challenge', frame[1]],
            ...(this.options.authTag ? [this.options.authTag] : []),
          ],
        },
        this.key,
      );
      this.authId = e.id;
      this.send(['AUTH', e]);
    }
    if (frame[0] === 'OK' && this.authId && frame[1] === this.authId) {
      this.authId = null;
      if (frame[2] !== true) {
        this.failAuthentication(new Error(`Buzz authentication rejected: ${frame[3]}`));
        return;
      }
      if (this.authTimer) clearTimeout(this.authTimer);
      this.authTimer = null;
      this.authenticated = true;
      this.backoff = 500;
      const version = this.subscriptionVersion;
      this.emit('connected');
      if (this.subscriptionVersion === version) this.subscribe();
      return;
    }
    if (frame[0] === 'OK') {
      const p = this.pending.get(frame[1]);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(frame[1]);
        frame[2] ? p.resolve() : p.reject(new Error(`Buzz relay rejected event: ${frame[3]}`));
      }
    }
    if (
      this.authenticated &&
      frame[0] === 'EVENT' &&
      this.subscriptionIds.has(frame[1]) &&
      frame[2] &&
      validSignedEvent(frame[2])
    )
      this.emit('event', frame[2] as Event);
    if (this.authenticated && frame[0] === 'EOSE' && this.subscriptionIds.has(frame[1]))
      this.emit('history-complete', frame[1]);
    if (frame[0] === 'CLOSED') this.emit('warning', String(frame[2]));
  }
  async publish(event: Event) {
    await this.waitUntilReady();
    if (!this.authenticated || this.socket?.readyState !== WebSocket.OPEN)
      throw new Error('Buzz connection closed before publication');
    return new Promise<void>((resolve, reject) => {
      if (this.pending.has(event.id)) {
        reject(new Error('Buzz event publication is already pending'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(event.id);
        reject(new Error('Buzz publication acknowledgement timed out'));
      }, 15000);
      this.pending.set(event.id, { resolve, reject, timer });
      this.send(['EVENT', event]);
    });
  }
  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.resetAuthentication();
    this.rejectPending(new Error('Relay closed'));
    this.emit('disconnected');
    this.socket?.close();
  }
  decode(event: Event) {
    const tags = (name: string) => event.tags.filter((t) => t[0] === name);
    if (
      tags('p').length !== 1 ||
      tags('p')[0][1] !== getPublicKey(this.key) ||
      tags('agent').length !== 1 ||
      tags('agent')[0][1] !== event.pubkey
    )
      throw new Error('Telemetry audience or author mismatch');
    if (event.kind === 24200 && (tags('frame').length !== 1 || tags('frame')[0][1] !== 'telemetry'))
      throw new Error('Not an observer telemetry frame');
    const content = nip44.v2.decrypt(
      event.content,
      nip44.v2.utils.getConversationKey(this.key, event.pubkey),
    );
    if (Buffer.byteLength(content) > 65535) throw new Error('Telemetry payload too large');
    return JSON.parse(content);
  }
}
export async function setupArena(config: Config) {
  const key = ownerKey(),
    owner = getPublicKey(key);
  const channels = await buzz(config, ['channels', 'list', '--member'], key);
  if (!config.channelId) {
    const existing = channels.filter((c: any) => c.name === 'ARENA');
    if (existing.length > 1)
      throw new Error('Multiple ARENA channels exist. Set channelId in config.json explicitly.');
    if (existing.length === 1) config.channelId = existing[0].channel_id;
    else {
      const made = await buzz(
        config,
        [
          'channels',
          'create',
          '--name',
          'ARENA',
          '--type',
          'stream',
          '--visibility',
          'private',
          '--description',
          'Mortal Kommit code reviews. One thread per match. Human channel members: !review --repo <alias> or !review --mr <url> / --pr <url>.',
        ],
        key,
      );
      config.channelId = made.channel_id;
    }
  }
  if (!config.channelId) throw new Error('Buzz did not return a channel ID');
  config.ownerPubkey = owner;
  const file = join(dataDir(), 'identities.json');
  let pair: Identities;
  if (existsSync(file)) {
    pair = identities();
    if (pair.claude.auth[1] !== owner)
      throw new Error(
        'Stored ARENA identities belong to a different owner. Use a separate data directory.',
      );
  } else {
    const make = () => {
      const secret = generateSecretKey(),
        pubkey = getPublicKey(secret);
      const sig = hex(
        schnorr.sign(sha256(new TextEncoder().encode(`nostr:agent-auth:${pubkey}:`)), key),
      );
      return { key: hex(secret), pubkey, auth: ['auth', owner, '', sig] };
    };
    pair = { claude: make(), codex: make() };
    privateWrite(file, pair);
  }
  for (const agent of ['claude', 'codex'] as const) {
    const identity = pair[agent],
      secret = Uint8Array.from(Buffer.from(identity.key, 'hex'));
    // Buzz requires the EVENT author to match the authenticated connection.
    // Each agent authenticates with its own key plus the owner's NIP-OA grant.
    const relay = new Relay(config.relay, secret, { authTag: identity.auth });
    relay.connect();
    try {
      await relay.waitUntilReady();
      await relay.publish(
        finalizeEvent(
          {
            kind: 0,
            created_at: Math.floor(Date.now() / 1000),
            tags: [identity.auth],
            content: JSON.stringify({
              name: agent === 'claude' ? 'ArenaClaude' : 'ArenaCodex',
              about: 'Mortal Kommit dedicated read-only reviewer',
              bot: true,
            }),
          },
          secret,
        ),
      );
    } finally {
      relay.close();
    }
    await buzz(
      config,
      [
        'channels',
        'add-member',
        '--channel',
        config.channelId,
        '--pubkey',
        identity.pubkey,
        '--role',
        'bot',
      ],
      key,
    );
  }
  config.fighters = { claude: pair.claude.pubkey, codex: pair.codex.pubkey };
  saveConfig(config);
  return config;
}
export function rootOf(event: Pick<Event, 'id' | 'tags'>) {
  return (
    event.tags.find((t) => t[0] === 'e' && t[3] === 'root')?.[1] ??
    event.tags.find((t) => t[0] === 'e' && t[3] === 'reply')?.[1] ??
    event.id
  );
}
