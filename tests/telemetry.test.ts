import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  promptUsageRecord,
  codexUsageRecords,
  claudeUsageRecords,
  readLocalUsage,
  readCodexUsage,
  type Binding,
} from '../src/backend/telemetry.js';
import { accountUsage } from '../src/core/usage.js';
import { newMatch, applyFatigue, finish } from '../src/core/battle.js';
import { CombatEvent } from '../src/core/types.js';
const binding: Binding = {
  agent: 'codex',
  sessionId: 's',
  rootId: 'r',
  matchId: 'm',
  active: false,
};
const response = (
  id: string,
  turnId: string,
  total: number,
  cumulative: number,
  session = 's',
) => ({
  type: 'token_usage_record',
  payload: {
    thread_id: session,
    session_id: session,
    turn_id: turnId,
    response_id: id,
    usage: {
      input_tokens: total - 10,
      output_tokens: 10,
      total_tokens: total,
      cached_input_tokens: 60,
    },
    thread_token_usage: { total_tokens: cumulative },
  },
});
const complete = (turnId: string) => ({
  type: 'event_msg',
  timestamp: '2026-10-11T21:20:00Z',
  payload: { type: 'task_complete', turn_id: turnId },
});
test('ACP completed-turn counters normalize cache categories once, reject occupancy and malformed records', () => {
  const result = {
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 65,
      cachedReadTokens: 30,
      cachedWriteTokens: 20,
    },
  };
  const claude = promptUsageRecord('claude', 'm', 's', 1, result, 100)!;
  assert.equal(accountUsage([claude]).tokens, 65);
  assert.equal(accountUsage([claude]).label, 'derived');
  const codex = promptUsageRecord('codex', 'm', 's', 1, result, 100)!;
  assert.equal(codex.turn?.totalTokens, 65);
  assert.equal(accountUsage([codex]).label, 'partial');
  for (const usage of [
    { used: 500, size: 1000 },
    { inputTokens: 10, outputTokens: -1, totalTokens: 9 },
    { ...result.usage, inputTokens: Number.MAX_SAFE_INTEGER },
  ])
    assert.equal(promptUsageRecord('claude', 'm', 's', 1, { usage }, 100), null);
});
test('Codex provider records cover every tool-loop response, deduplicate, and wait for turn completion', () => {
  const rows = [
    response('a', 't1', 100, 100),
    response('b', 't1', 200, 300),
    response('b', 't1', 200, 300),
    response('foreign', 'other', 8000, 8000, 'other'),
  ];
  assert.deepEqual(codexUsageRecords(rows, binding), []);
  rows.push(complete('t1') as any);
  const records = codexUsageRecords(rows, binding);
  assert.equal(accountUsage(records).tokens, 300);
  assert.equal(accountUsage(records).label, 'reported');
  assert.deepEqual(
    codexUsageRecords([response('b', 't1', 200, 300), complete('t1')], binding),
    [],
    'missing baseline/response cannot pretend to be complete',
  );
  assert.deepEqual(
    codexUsageRecords(
      [response('a', 't1', 100, 100), response('b', 't1', 20, 20), complete('t1')],
      binding,
    ),
    [],
    'counter reset is rejected',
  );
});
test('provider usage, ACP and NIP-AM copies are mutually exclusive per bound session', () => {
  const acp = promptUsageRecord(
    'codex',
    'm',
    's',
    1,
    { usage: { inputTokens: 190, outputTokens: 10, totalTokens: 200 } },
    100,
  )!;
  const buzz = { ...acp, id: 'relay-1', source: 'buzz' as const };
  const provider = codexUsageRecords(
    [response('a', 't1', 100, 100), response('b', 't1', 200, 300), complete('t1')],
    binding,
  );
  assert.equal(accountUsage([acp, buzz, buzz]).tokens, 200);
  assert.equal(accountUsage([buzz, ...provider, acp]).tokens, 300);
  assert.equal(
    accountUsage([...provider, { ...acp, id: 'other', sessionId: 'other' }]).tokens,
    500,
  );
});
test('Claude provider message recovery deduplicates content blocks and labels its limited coverage', () => {
  const row = {
    type: 'assistant',
    sessionId: 's',
    timestamp: '2026-10-11T21:20:00Z',
    message: {
      id: 'msg-1',
      usage: {
        input_tokens: 2,
        output_tokens: 10,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
      },
    },
  };
  const records = claudeUsageRecords([row, row, { ...row, sessionId: 'foreign' }], {
    ...binding,
    agent: 'claude',
  });
  assert.equal(records.length, 1);
  assert.equal(accountUsage(records).tokens, 132);
  assert.equal(accountUsage(records).label, 'partial');
});
test('late reliable metrics update completed replay, keep ending last, preserve finish identity, and remain idempotent', () => {
  const m = newMatch('m', 'late usage');
  finish(m, 1);
  const finishId = m.events[0].id;
  const r = promptUsageRecord(
    'claude',
    'm',
    's',
    1,
    {
      usage: {
        inputTokens: 10000,
        outputTokens: 100,
        totalTokens: 10100,
        cachedReadTokens: 100000,
      },
    },
    100,
  )!;
  m.usage.push(r);
  applyFatigue(m, r.id, 100);
  assert.deepEqual(
    m.events.map((e) => e.type),
    ['fatigue', 'finish'],
  );
  assert.equal(m.events[1].id, finishId);
  assert.equal(m.events[0].health.claude, 70);
  assert.equal(m.events[1].health.claude, 70);
  assert.equal(m.battle.claude.health, 70);
  assert.equal(new Set(m.events.map((e) => e.id)).size, 2);
  m.events.forEach((e) => CombatEvent.parse(e));
  const before = JSON.stringify(m);
  applyFatigue(m, r.id, 200);
  assert.equal(JSON.stringify(m), before);
  const used = new Set(m.events.flatMap((e) => e.usageIds));
  assert.equal(accountUsage(m.usage.filter((r) => used.has(r.id))).tokens, 110100);
});
test('local usage requires exact match/session binding and Codex file must stay in isolated session directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mk-usage-'));
  try {
    const r = promptUsageRecord(
      'codex',
      'm',
      's',
      1,
      { usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
      100,
    )!;
    writeFileSync(
      join(dir, 'codex.usage.jsonl'),
      [
        r,
        { ...r, id: 'foreign-match', matchId: 'other' },
        { ...r, id: 'foreign-session', sessionId: 'other' },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    assert.equal(readLocalUsage(dir, 'codex', 'm', [binding]).length, 1);
    assert.equal(readLocalUsage(dir, 'codex', 'm', []).length, 0);
    const home = join(dir, 'codex-profile');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    const db = new DatabaseSync(join(home, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT)');
    const outside = join(dir, 'outside.jsonl');
    writeFileSync(
      outside,
      [response('a', 't1', 100, 100), complete('t1')].map((r) => JSON.stringify(r)).join('\n'),
    );
    symlinkSync(outside, join(home, 'sessions', 'escaped.jsonl'));
    db.prepare('INSERT INTO threads VALUES (?,?)').run(
      's',
      join(home, 'sessions', 'escaped.jsonl'),
    );
    db.close();
    assert.deepEqual(readCodexUsage(dir, binding), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the capability proxy persists bound prompt usage before reporting the provider idle', async () => {
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const { readFileSync } = await import('node:fs');
  const { Config } = await import('../src/backend/config.js');
  const dir = mkdtempSync(join(tmpdir(), 'mk-proxy-meter-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const adapter = join(dir, 'fixture.mjs');
    writeFileSync(
      adapter,
      `import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='session/new')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessionId:'fixture-session'}})+'\\n');if(m.method==='session/prompt'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'usage_update',used:999999,size:1000000}}})+'\\n');process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn',usage:{inputTokens:10,outputTokens:5,totalTokens:65,cachedReadTokens:30,cachedWriteTokens:20}}})+'\\n');}});`,
    );
    const config = Config.parse({
        profiles: { codexHome: join(dir, 'auth'), claudeConfig: join(dir, 'claude') },
      }),
      runtime = join(dir, 'runtime.json');
    writeFileSync(
      runtime,
      JSON.stringify({
        matchId: 'm',
        rootId: 'a'.repeat(64),
        directory: dir,
        agent: 'claude',
        config,
        adapter,
        bindingsFile: join(dir, 'claude.bindings.json'),
      }),
    );
    child = spawn(process.execPath, ['--import', 'tsx', 'src/backend/acp-proxy.ts', runtime], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const waiting = new Map<number, (m: any) => void>();
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const m = JSON.parse(line);
      waiting.get(m.id)?.(m);
    });
    const request = (id: number, method: string, params: any) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Proxy response timeout')), 5000);
        waiting.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    assert.equal(
      (await request(1, 'session/new', { _meta: { sessionTitle: 'ArenaClaude · aaaaaaaa' } }))
        .result.sessionId,
      'fixture-session',
    );
    assert.equal(
      (await request(2, 'session/prompt', { sessionId: 'fixture-session', prompt: [] })).result
        .stopReason,
      'end_turn',
    );
    const bindings = JSON.parse(readFileSync(join(dir, 'claude.bindings.json'), 'utf8'));
    assert.equal(bindings[0].active, false);
    const records = readLocalUsage(dir, 'claude', 'm', bindings);
    assert.equal(records.length, 1);
    assert.equal(accountUsage(records).tokens, 65, 'context occupancy is never accumulated');
    assert.ok((await request(3, 'session/prompt', { sessionId: 'foreign', prompt: [] })).error);
    assert.equal(readLocalUsage(dir, 'claude', 'm', bindings).length, 1);
  } finally {
    child?.stdin?.end();
    child?.kill('SIGTERM');
    if (child && child.exitCode === null)
      await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
