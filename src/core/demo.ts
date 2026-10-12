import { applyAnalysis, applyFatigue, finish, newMatch } from './battle.js';
import type { Action, Fighter, Match } from './types.js';

export function demoMatch(): Match {
  const m = newMatch('demo-mortal-kommit', 'The midnight merge', true);
  const start = Date.UTC(2026, 9, 8, 0, 0);
  m.createdAt = start;
  m.status = 'reviewing';
  m.rootId = 'demo-thread';
  m.scope = {
    repo: 'DEMO / midnight-api',
    branch: 'feature/instant-checkout',
    mode: 'demo',
    base: '48f012a-demo-base',
    head: 'ad97b4e-demo-head',
    comparison: '48f012a..ad97b4e',
    commits: [
      { sha: '92ce510', subject: 'Add instant checkout endpoint' },
      { sha: 'ad97b4e', subject: 'Cache inventory and improve session lookup' },
    ],
    dirty: false,
    warnings: [
      'Scripted demonstration. All messages, evidence, and usage below are authored fixtures. No models or Buzz agents are running.',
    ],
    changedFiles: ['src/checkout.ts', 'src/inventory.ts', 'src/session.ts'],
  };
  m.packet =
    'DEMO fixture: an instant-checkout change with an authorization gap, an inventory race, and a null-session claim later refuted.';
  let n = 0;
  const message = (agent: Fighter, content: string) => {
    const id = `demo-message-${++n}`;
    m.messages.push({
      id,
      matchId: m.id,
      pubkey: `demo-${agent}`,
      agent,
      at: start + n * 2600,
      content,
      rootId: m.rootId!,
      revision: 0,
    });
    return id;
  };
  const act = (
    agent: Fighter,
    type: Action['type'],
    findingId: string,
    source: string,
    options: Partial<Action> = {},
  ) => {
    const existing = m.findings.find((f) => f.id === findingId);
    const action: Action = {
      agent,
      type,
      findingId,
      title: existing?.title ?? 'Checkout skips resource ownership',
      severity: existing?.severity ?? 'critical',
      category: existing?.category ?? 'security',
      scenario: existing?.scenario ?? 'A signed-in customer submits another customer’s order ID.',
      impact: existing?.impact ?? 'The attacker can charge and finalize an order they do not own.',
      rationale: 'Evidence from the review conversation supports this classification.',
      evidence: [
        {
          file: 'src/checkout.ts',
          line: 42,
          endLine: 42,
          quote: 'return charge(await orders.get(req.params.id));',
          revision: 'head',
        },
      ],
      sourceIds: [source],
      move: (existing?.special as Action['move']) ?? 'AUTH BYPASS BREAKER',
      ...options,
    };
    applyAnalysis(
      m,
      { actions: [action], independentComplete: [], finalAgents: [], summary: '' },
      m.messages.at(-1)!.at,
    );
  };
  let id = message(
    'claude',
    'INDEPENDENT_INSPECTION_COMPLETE\nF-001: checkout.ts:42 charges the order selected by the request ID without checking order.customerId against the authenticated customer. Another customer can finalize the order. `return charge(await orders.get(req.params.id));`',
  );
  act('claude', 'propose', 'F-001', id);
  id = message(
    'codex',
    'INDEPENDENT_INSPECTION_COMPLETE\nF-002: inventory.ts:18 reads remaining stock before awaiting the update. Two simultaneous purchases can both see the last unit and both succeed. `await inventory.set(sku, remaining - 1);`',
  );
  applyAnalysis(
    m,
    { actions: [], independentComplete: ['claude', 'codex'], finalAgents: [], summary: '' },
    m.messages.at(-1)!.at,
  );
  act('codex', 'propose', 'F-002', id, {
    title: 'Concurrent purchases oversell the last unit',
    severity: 'high',
    category: 'concurrency',
    scenario: 'Two checkouts read remaining=1 before either writes.',
    impact: 'Both purchases succeed and inventory oversells.',
    evidence: [
      {
        file: 'src/inventory.ts',
        line: 18,
        endLine: 18,
        quote: 'await inventory.set(sku, remaining - 1);',
        revision: 'head',
      },
    ],
    move: 'RACE CONDITION ROUNDHOUSE',
  });
  id = message(
    'codex',
    'I challenge F-001: does the route middleware already enforce ownership? Authentication alone would not be enough.',
  );
  act('codex', 'challenge', 'F-001', id, { evidence: [] });
  id = message(
    'claude',
    'The route installs requireUser but no owner check. At checkout.ts:42 the lookup accepts the supplied ID directly. That establishes the cross-customer trigger and impact.',
  );
  act('claude', 'support', 'F-001', id);
  id = message(
    'claude',
    'I independently noticed the same inventory read/write race at inventory.ts:18. This is F-002, not another defect.',
  );
  act('claude', 'duplicate', 'F-002', id, {
    evidence: [
      {
        file: 'src/inventory.ts',
        line: 18,
        endLine: 18,
        quote: 'await inventory.set(sku, remaining - 1);',
        revision: 'head',
      },
    ],
  });
  id = message(
    'codex',
    'F-002 is supported by the actual await boundary: both requests read before the write. A conditional atomic decrement is needed.',
  );
  act('codex', 'support', 'F-002', id, {
    evidence: [
      {
        file: 'src/inventory.ts',
        line: 18,
        endLine: 18,
        quote: 'await inventory.set(sku, remaining - 1);',
        revision: 'head',
      },
    ],
  });
  id = message(
    'claude',
    'F-003: session.ts:9 dereferences session.user. I suspect an expired session can be null.',
  );
  act('claude', 'propose', 'F-003', id, {
    title: 'Possible null session dereference',
    severity: 'medium',
    category: 'correctness',
    scenario: 'An expired session reaches the checkout handler.',
    impact: 'The request may fail with an exception.',
    evidence: [
      {
        file: 'src/session.ts',
        line: 9,
        endLine: 9,
        quote: 'return session.user;',
        revision: 'head',
      },
    ],
    move: 'NULL POINTER PILEDRIVER',
  });
  id = message(
    'codex',
    'F-003 is refuted: session.ts:7 throws before the dereference when the lookup is null: `if (!session) throw new Unauthorized();`. The handler maps this to a 401.',
  );
  act('codex', 'rebut', 'F-003', id, {
    evidence: [
      {
        file: 'src/session.ts',
        line: 7,
        endLine: 7,
        quote: 'if (!session) throw new Unauthorized();',
        revision: 'head',
      },
    ],
  });
  id = message(
    'claude',
    'I retract F-003. I missed the early null guard; the expired-session path correctly returns 401.',
  );
  act('claude', 'retract', 'F-003', id, { evidence: [] });
  id = message(
    'claude',
    'Additional evidence for F-001: the existing test submits a foreign order and only asserts status 200, so it currently endorses the unauthorized behavior. `expect(response.status).toBe(200);`',
  );
  act('claude', 'evidence', 'F-001', id, {
    evidence: [
      {
        file: 'test/checkout.test.ts',
        line: 61,
        endLine: 61,
        quote: 'expect(response.status).toBe(200);',
        revision: 'head',
      },
    ],
  });
  for (const [agent, tokens] of [
    ['claude', 68000],
    ['codex', 82000],
  ] as [Fighter, number][]) {
    const usageId = `demo-usage-${agent}`;
    m.usage.push({
      id: usageId,
      matchId: m.id,
      agent,
      sessionId: `demo-session-${agent}`,
      turnId: 'turn-1',
      turnSeq: 1,
      at: start + ++n * 2600,
      turn: { inputTokens: tokens - 4000, outputTokens: 4000, totalTokens: tokens },
      cumulative: null,
      deltaReliable: true,
      attributed: true,
    });
    applyFatigue(m, usageId, start + n * 2600);
  }
  message(
    'claude',
    'FINAL_REVIEW\nRetain F-001 (critical authorization) and F-002 (high inventory race). F-003 is retracted. Neither agreement nor scoring replaces human verification.',
  );
  message(
    'codex',
    'FINAL_REVIEW\nF-001 and F-002 have concrete triggers and source evidence. The null-session allegation was refuted. No further substantiated issues remain.',
  );
  m.finalAgents = ['claude', 'codex'];
  m.summary =
    'Two supported defects, one successful rebuttal, one retracted claim. Scripted demonstration, with no live model calls.';
  finish(m, start + ++n * 2600);
  return m;
}
