import { createInterface } from 'node:readline';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { safePath, listFiles } from './repository.js';
import { buzz } from './buzz.js';
import type { Config } from './config.js';
import { pathToFileURL } from 'node:url';

export interface Runtime {
  matchId: string;
  rootId: string;
  channelId: string;
  directory: string;
  agent: 'claude' | 'codex';
  peer: string;
  key: string;
  auth: string[];
  config: Config;
  adapter: string;
  bindingsFile: string;
  startedAt: number;
}
const tool = (name: string, description: string, properties: object, required: string[] = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});
export const toolList = [
  tool(
    'snapshot_list',
    'List files in this review’s pinned snapshot.',
    { revision: { type: 'string', enum: ['base', 'head'] } },
    ['revision'],
  ),
  tool(
    'snapshot_read',
    'Read numbered lines of a pinned source file. Never executes code.',
    {
      revision: { type: 'string', enum: ['base', 'head'] },
      file: { type: 'string' },
      line: { type: 'integer', minimum: 1 },
      count: { type: 'integer', minimum: 1, maximum: 250 },
    },
    ['revision', 'file'],
  ),
  tool(
    'snapshot_search',
    'Literal targeted search, capped at 60 hits.',
    {
      revision: { type: 'string', enum: ['base', 'head'] },
      text: { type: 'string', minLength: 2 },
    },
    ['revision', 'text'],
  ),
  tool(
    'context_packet',
    'Read the identical neutral context packet supplied to both reviewers, in chunks.',
    {
      offset: { type: 'integer', minimum: 0 },
      length: { type: 'integer', minimum: 1, maximum: 20000 },
    },
  ),
  tool('buzz_thread', 'Read this review thread through Buzz.', {}),
  tool(
    'buzz_send',
    'Send your review contribution to this Buzz thread; notify the peer for collaboration, or false for FINAL_REVIEW.',
    { content: { type: 'string', maxLength: 50000 }, notifyPeer: { type: 'boolean' } },
    ['content'],
  ),
];
export async function capability(runtime: Runtime, name: string, args: Record<string, any>) {
  const root = await realpath(
    join(runtime.directory, 'snapshot', args.revision === 'base' ? 'base' : 'head'),
  );
  if (name === 'snapshot_list') return (await listFiles(root)).join('\n');
  if (name === 'snapshot_read') {
    const path = safePath(root, String(args.file));
    if ((await realpath(path)) !== path) throw new Error('Symlinks are not allowed');
    const lines = (await readFile(path, 'utf8')).split('\n');
    const start = Math.max(0, Math.floor(Number(args.line) || 1) - 1),
      count = Math.min(250, Math.max(1, Math.floor(Number(args.count) || 150)));
    return lines
      .slice(start, start + count)
      .map((line, i) => `${start + i + 1}: ${line}`)
      .join('\n');
  }
  if (name === 'snapshot_search') {
    const needle = String(args.text);
    if (needle.length < 2 || needle.length > 300)
      throw new Error('Search text must have 2–300 characters');
    const hits: string[] = [];
    for (const file of await listFiles(root)) {
      const lines = (await readFile(safePath(root, file), 'utf8')).split('\n');
      for (let i = 0; i < lines.length; i++)
        if (lines[i].includes(needle)) {
          hits.push(`${file}:${i + 1}: ${lines[i].slice(0, 500)}`);
          if (hits.length >= 60) return hits.join('\n');
        }
    }
    return hits.join('\n');
  }
  if (name === 'context_packet') {
    const text = await readFile(join(runtime.directory, 'packet.txt'), 'utf8');
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    return text.slice(offset, offset + Math.min(20000, Math.max(1, Number(args.length) || 16000)));
  }
  const key = Uint8Array.from(Buffer.from(runtime.key, 'hex'));
  if (name === 'buzz_thread')
    return JSON.stringify(
      await buzz(
        runtime.config,
        [
          'messages',
          'thread',
          '--channel',
          runtime.channelId,
          '--event',
          runtime.rootId,
          '--limit',
          '200',
        ],
        key,
        undefined,
        runtime.auth,
      ),
    );
  if (name === 'buzz_send') {
    const content = String(args.content);
    if (!content.trim() || Buffer.byteLength(content) > 50000)
      throw new Error('Message must contain 1–50000 bytes');
    const cmd = [
      'messages',
      'send',
      '--channel',
      runtime.channelId,
      '--reply-to',
      runtime.rootId,
      '--content',
      '-',
    ];
    if (args.notifyPeer !== false) cmd.push('--mention', runtime.peer);
    return JSON.stringify(await buzz(runtime.config, cmd, key, content, runtime.auth));
  }
  throw new Error('Tool not permitted');
}
export async function serveCapabilities(file: string) {
  const runtime: Runtime = JSON.parse(await readFile(file, 'utf8'));
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    let req: any;
    try {
      req = JSON.parse(line);
      if (req.id === undefined) continue;
      let result: unknown;
      if (req.method === 'initialize')
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mortal-kommit-scoped-review', version: '0.1.0' },
        };
      else if (req.method === 'ping') result = {};
      else if (req.method === 'tools/list') result = { tools: toolList };
      else if (req.method === 'tools/call') {
        try {
          result = {
            content: [
              {
                type: 'text',
                text: await capability(runtime, req.params.name, req.params.arguments ?? {}),
              },
            ],
          };
        } catch (e) {
          result = { isError: true, content: [{ type: 'text', text: String(e) }] };
        }
      } else throw new Error('Method not permitted');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
    } catch (e) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: req?.id ?? null,
          error: { code: -32600, message: String(e) },
        }) + '\n',
      );
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  serveCapabilities(process.argv[2]).catch(() => process.exit(1));
