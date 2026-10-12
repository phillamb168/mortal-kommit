import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newMatch, applyAnalysis, applyFatigue, finish } from '../src/core/battle.js';
import {
  CombatEvent,
  type Action,
  type UsageRecord,
  type ReviewExchange,
} from '../src/core/types.js';
import { accountUsage } from '../src/core/usage.js';
import { demoMatch } from '../src/core/demo.js';

function metric(id: string, overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id,
    matchId: 'm',
    agent: 'claude',
    sessionId: 's',
    turnId: id,
    turnSeq: Number(id.slice(1)) || 1,
    at: 1,
    turn: null,
    cumulative: null,
    deltaReliable: false,
    attributed: true,
    ...overrides,
  };
}
test('usage is unavailable without reliable review records; legitimate reported zero remains measured', () => {
  assert.equal(accountUsage([]).tokens, null);
  assert.equal(
    accountUsage([
      metric('t1', {
        attributed: false,
        turn: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
        deltaReliable: true,
      }),
    ]).tokens,
    null,
  );
  assert.equal(
    accountUsage([
      metric('t1', {
        turn: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        deltaReliable: true,
      }),
    ]).tokens,
    0,
  );
});
test('reported total wins; cache-inclusive input is not counted twice; duplicated turns are ignored', () => {
  const r = metric('t1', {
    turn: { inputTokens: 100, outputTokens: 20, totalTokens: 130 },
    deltaReliable: true,
  });
  const d = metric('other', { ...r, id: 'other' });
  assert.equal(accountUsage([r, r, d]).tokens, 130);
  const derived = accountUsage([
    metric('t1', {
      turn: { inputTokens: 100, outputTokens: 20, totalTokens: null },
      deltaReliable: true,
    }),
  ]);
  assert.equal(derived.tokens, 120);
  assert.equal(derived.label, 'derived');
});
test('cumulative baselines, gaps, resets and separate sessions do not invent deltas', () => {
  const cumulative = (n: number) => ({ inputTokens: null, outputTokens: null, totalTokens: n });
  const rows = [
    metric('t1', { cumulative: cumulative(100) }),
    metric('t2', { cumulative: cumulative(160) }),
    metric('t4', { cumulative: cumulative(300) }),
    metric('t5', { cumulative: cumulative(10) }),
    metric('t6', { cumulative: cumulative(25) }),
    metric('x1', { sessionId: 'new', turnSeq: 1, cumulative: cumulative(500) }),
  ];
  const result = accountUsage(rows.reverse());
  assert.equal(result.tokens, 75);
  assert.equal(result.label, 'partial');
  assert.ok(result.notes.some((n) => n.includes('reset')));
});
function setup() {
  const m = newMatch('m', 'test');
  m.messages = [
    {
      id: 'a',
      matchId: 'm',
      pubkey: 'a',
      agent: 'claude',
      at: 1,
      content: 'real finding',
      rootId: 'r',
      revision: 0,
    },
    {
      id: 'b',
      matchId: 'm',
      pubkey: 'b',
      agent: 'codex',
      at: 2,
      content: 'real rebuttal',
      rootId: 'r',
      revision: 0,
    },
  ];
  const a: Action = {
    type: 'propose',
    agent: 'claude',
    findingId: 'F-001',
    title: 'Missing ownership check',
    severity: 'high',
    category: 'security',
    scenario: 'Customer selects a foreign order ID',
    impact: 'Foreign order is charged',
    rationale: 'A concrete code path omits authorization.',
    evidence: [{ file: 'order.ts', line: 1, endLine: 1, quote: 'charge(order)', revision: 'head' }],
    sourceIds: ['a'],
    move: 'AUTH BYPASS BREAKER',
  };
  return { m, a };
}
const analysis = (actions: Action[]) => ({
  actions,
  independentComplete: [] as ('claude' | 'codex')[],
  finalAgents: [] as ('claude' | 'codex')[],
  summary: '',
});
test('proposal animates without points; supported unique discovery gets one reversible bonus', () => {
  const { m, a } = setup();
  applyAnalysis(m, analysis([a]), 1);
  assert.equal(m.battle.codex.health, 100);
  assert.equal(m.battle.claude.quality, 0);
  assert.ok(m.events.some((e) => e.type === 'special-discovered'));
  applyAnalysis(
    m,
    { ...analysis([{ ...a, type: 'support' }]), independentComplete: ['claude', 'codex'] },
    2,
  );
  assert.equal(m.battle.codex.damage, 20);
  assert.equal(m.battle.claude.quality, 8);
  assert.equal(m.battle.claude.special, 25);
  const length = m.events.length;
  applyAnalysis(m, analysis([{ ...a, type: 'support', rationale: 'Same finding reworded' }]), 3);
  assert.equal(m.events.length, length);
  applyAnalysis(m, analysis([{ ...a, type: 'rebut', agent: 'codex', sourceIds: ['b'] }]), 4);
  assert.equal(m.battle.codex.damage, 0);
  assert.equal(m.battle.claude.damage, 6);
  assert.equal(m.battle.codex.quality, 3);
  assert.equal(m.battle.claude.special, 0);
  assert.ok(m.events.some((e) => e.type === 'correction'));
});
test('duplicate underlying finding blocks; repeated evidence cannot farm quality', () => {
  const { m, a } = setup();
  applyAnalysis(
    m,
    {
      ...analysis([
        a,
        { ...a, type: 'duplicate', agent: 'codex', sourceIds: ['b'] },
        { ...a, type: 'support' },
      ]),
      independentComplete: ['claude', 'codex'],
    },
    1,
  );
  assert.equal(m.findings.length, 1);
  assert.equal(m.battle.claude.special, 0);
  assert.equal(m.battle.claude.quality, 5);
  applyAnalysis(m, analysis([{ ...a, type: 'evidence' }]), 2);
  assert.equal(m.battle.claude.quality, 5);
  assert.equal(m.events.at(-1)!.type, 'block');
});
test('invalid analysis is atomic and source authorship is enforced', () => {
  const { m, a } = setup();
  const before = JSON.stringify(m);
  assert.throws(() =>
    applyAnalysis(m, analysis([a, { ...a, type: 'support', sourceIds: ['fabricated'] }]), 1),
  );
  assert.equal(JSON.stringify(m), before);
  assert.throws(() => applyAnalysis(m, analysis([{ ...a, agent: 'codex' }]), 1));
});
function discussion() {
  const { m } = setup();
  m.messages[0].content = 'The missing manifest could break the recovery mirror.';
  m.messages[1].content = 'The base script already omitted this retired manifest.';
  m.messages.push({
    ...m.messages[0],
    id: 'c',
    at: 3,
    content: 'I withdraw that claim; this omission predates the change.',
  });
  const claim: ReviewExchange = {
    type: 'claim',
    agent: 'claude',
    topicKey: 'manifest-copy',
    caption: 'COPY SCOPE QUESTIONED',
    rationale: 'The reviewer raises a concrete concern for discussion; it is not confirmed.',
    sourceIds: ['a'],
    quote: m.messages[0].content,
  };
  const rebuttal: ReviewExchange = {
    type: 'rebuttal',
    agent: 'codex',
    topicKey: 'manifest-copy',
    caption: 'BASE COMPARISON PARRY',
    rationale: 'The base comparison refutes the claimed regression, which the peer acknowledges.',
    sourceIds: ['a', 'b', 'c'],
    quote: m.messages[1].content,
  };
  const concession: ReviewExchange = {
    type: 'concession',
    agent: 'claude',
    topicKey: 'manifest-copy',
    caption: 'CLAIM WITHDRAWN',
    rationale: 'The reviewer explicitly withdraws the concern.',
    sourceIds: ['a', 'b', 'c'],
    quote: m.messages[2].content,
  };
  return { m, claim, rebuttal, concession };
}
test('a clean final review retains substantive debate in chronological replay without changing scores or health', () => {
  const { m, claim, rebuttal, concession } = discussion();
  applyAnalysis(
    m,
    { ...analysis([]), exchanges: [concession, rebuttal, claim], finalAgents: ['claude', 'codex'] },
    10,
  );
  finish(m, 11);
  assert.deepEqual(
    m.events.map((e) => e.type),
    ['attack', 'parry', 'recoil', 'finish'],
  );
  assert.equal(m.findings.length, 0);
  assert.equal(m.actions.length, 0);
  assert.equal(m.battle.claude.health, 100);
  assert.equal(m.battle.codex.health, 100);
  assert.equal(m.battle.claude.quality, 0);
  assert.equal(m.battle.codex.quality, 0);
  assert.equal(m.battle.claude.usage.tokens, null);
  for (const e of m.events.slice(0, -1)) {
    CombatEvent.parse(e);
    assert.ok(e.exchange);
    assert.match(e.reason, /no points or damage/);
    assert.deepEqual(e.delta, { claude: 0, codex: 0 });
    assert.equal(e.findingId, null);
  }
  assert.match(m.events.at(-1)!.reason, /No substantiated defects/);
  finish(m, 12);
  assert.equal(m.events.length, 4);
});
test('review exchanges deduplicate reworded arguments and do not duplicate finding actions', () => {
  const { m, claim } = discussion();
  applyAnalysis(m, { ...analysis([]), exchanges: [claim] }, 1);
  applyAnalysis(
    m,
    {
      ...analysis([]),
      exchanges: [
        {
          ...claim,
          caption: 'SAME CONCERN AGAIN',
          rationale: 'Different words for the same concern.',
        },
      ],
    },
    2,
  );
  assert.equal(m.events.length, 1);
  const { m: scored, a } = setup();
  const exchange = { ...claim, quote: 'real finding' };
  applyAnalysis(scored, { ...analysis([a]), exchanges: [exchange] }, 1);
  assert.equal(scored.events.filter((e) => e.exchange).length, 0);
  assert.equal(scored.findings.length, 1);
});
test('exchange evidence is validated atomically, including authorship, exact quotes and peer references', () => {
  const { m, claim, rebuttal, concession } = discussion(),
    before = JSON.stringify(m);
  for (const invalid of [
    { ...claim, sourceIds: ['missing'] },
    { ...claim, quote: m.messages[1].content },
    { ...rebuttal, sourceIds: ['b'] },
    { ...concession, sourceIds: ['c'] },
  ]) {
    assert.throws(() => applyAnalysis(m, { ...analysis([]), exchanges: [claim, invalid] }, 1));
    assert.equal(JSON.stringify(m), before);
  }
  m.messages[0].deleted = true;
  assert.throws(() => applyAnalysis(m, { ...analysis([]), exchanges: [claim] }, 1));
});
test('health uses damage and bounded measured fatigue; usage unavailable is not fabricated zero', () => {
  const { m, a } = setup();
  applyAnalysis(m, analysis([a, { ...a, type: 'support' }]), 1);
  m.usage.push(
    metric('t1', {
      agent: 'codex',
      turn: { inputTokens: 160000, outputTokens: 40000, totalTokens: 200000 },
      deltaReliable: true,
    }),
  );
  applyFatigue(m, 't1', 2);
  assert.equal(m.battle.codex.health, 56);
  assert.equal(m.battle.codex.fatigue, 30);
  assert.equal(m.battle.claude.usage.tokens, null);
  applyFatigue(m, 't1', 3);
  assert.equal(m.events.filter((e) => e.type === 'fatigue').length, 1);
});
test('demo is deterministic, evidence-backed, and covers the requested combat vocabulary', () => {
  const a = demoMatch(),
    b = demoMatch();
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.battle, b.battle);
  for (const type of [
    'attack',
    'counter',
    'block',
    'parry',
    'recoil',
    'combo',
    'special-discovered',
    'special',
    'correction',
    'fatigue',
    'finish',
  ])
    assert.ok(
      a.events.some((e) => e.type === type),
      type,
    );
  for (const e of a.events) {
    CombatEvent.parse(e);
    assert.ok(e.sourceIds.length || e.usageIds.length);
    for (const id of e.sourceIds) assert.ok(a.messages.some((m) => m.id === id));
  }
  assert.equal(a.status, 'complete');
  assert.ok(a.findings.some((f) => f.status === 'retracted'));
});
