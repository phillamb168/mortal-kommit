import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { z } from 'zod';
import { isIP } from 'node:net';

export const ViewerConfig = z
  .object({
    publicUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        return (
          (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) &&
          !url.username &&
          !url.password &&
          url.pathname === '/' &&
          !url.search &&
          !url.hash
        );
      }, 'Viewer URL must be an HTTPS origin without credentials, path, query, or fragment (HTTP is allowed for localhost only).')
      .transform((value) => new URL(value).origin),
    host: z
      .string()
      .refine(
        (value) => value === 'localhost' || isIP(value) !== 0,
        'Viewer host must be a bind IP address or localhost.',
      )
      .default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(8787),
  })
  .strict();

export const dataDir = () =>
  resolve(process.env.MORTAL_KOMMIT_DATA_DIR || `${homedir()}/.local/share/mortal-kommit`);
function discoveredRelay() {
  if (process.env.BUZZ_RELAY_URL) {
    const u = new URL(process.env.BUZZ_RELAY_URL);
    u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol;
    return u.toString().replace(/\/$/, '');
  }
  try {
    const agents = JSON.parse(
      readFileSync(
        `${homedir()}/Library/Application Support/xyz.block.buzz.app/agents/managed-agents.json`,
        'utf8',
      ),
    );
    const urls = [
      ...new Set(
        agents
          .map((a: any) => a.relay_url)
          .filter((s: any) => typeof s === 'string' && /^wss?:\/\//.test(s)),
      ),
    ];
    if (urls.length === 1) return urls[0] as string;
  } catch {}
  return 'ws://localhost:3000';
}
export const Config = z
  .object({
    version: z.literal(1).default(1),
    relay: z.string().url().default(discoveredRelay()),
    channelId: z.string().nullable().default(null),
    ownerPubkey: z.string().nullable().default(null),
    fighters: z.object({ claude: z.string(), codex: z.string() }).nullable().default(null),
    profiles: z.object({ codexHome: z.string(), claudeConfig: z.string() }).default({
      codexHome: existsSync(`${homedir()}/.codex-work`)
        ? `${homedir()}/.codex-work`
        : `${homedir()}/.codex`,
      claudeConfig: existsSync(`${homedir()}/.claude-work`)
        ? `${homedir()}/.claude-work`
        : `${homedir()}/.claude`,
    }),
    executables: z
      .object({
        buzz: z.string(),
        harness: z.string(),
        codex: z.string(),
        claudeAdapter: z.string(),
        codexAdapter: z.string(),
      })
      .default({
        buzz: 'buzz',
        harness: '/Applications/Buzz.app/Contents/MacOS/buzz-acp',
        codex: 'codex',
        claudeAdapter: `${homedir()}/Library/Application Support/Buzz/node-tools/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`,
        codexAdapter: `${homedir()}/Library/Application Support/Buzz/node-tools/lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js`,
      }),
    models: z
      .object({
        claude: z.string().optional(),
        codex: z.string().optional(),
        analysis: z.string().optional(),
      })
      .default({}),
    allowance: z
      .object({ claude: z.number().int().positive(), codex: z.number().int().positive() })
      .default({ claude: 100000, codex: 100000 }),
    weight: z.number().min(0).max(100).default(30),
    repos: z.record(z.string(), z.string()).default({}),
    assetsDir: z.string().nullable().default(null),
    viewer: ViewerConfig.nullable().default(null),
  })
  .strict();
export type Config = z.infer<typeof Config>;
export function privateWrite(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}
export function readConfig(): Config {
  const path = resolve(dataDir(), 'config.json');
  const input = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const publicUrl = process.env.MORTAL_KOMMIT_PUBLIC_URL;
  const host = process.env.MORTAL_KOMMIT_VIEWER_HOST;
  const port = process.env.MORTAL_KOMMIT_VIEWER_PORT;
  if (publicUrl !== undefined || host !== undefined || port !== undefined) {
    input.viewer = {
      ...input.viewer,
      ...(publicUrl !== undefined ? { publicUrl } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(port !== undefined ? { port: /^\d+$/.test(port) ? Number(port) : NaN } : {}),
    };
  }
  return Config.parse(input);
}
export function saveConfig(config: Config) {
  privateWrite(resolve(dataDir(), 'config.json'), Config.parse(config));
}
export function safeError(e: unknown): string {
  return (e instanceof Error ? e.message : String(e))
    .replace(/(?:nsec1)[a-z0-9]+/gi, '[REDACTED]')
    .replace(/\b[0-9a-f]{64}\b/gi, '[revision/key omitted]')
    .slice(0, 1500);
}
