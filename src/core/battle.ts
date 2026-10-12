import { syncFinisher } from './ending.js';
import {
  Action,
  CombatEvent,
  ReviewExchange,
  clamp,
  initialBattle,
  other,
  type Analysis,
  type Battle,
  type Fighter,
  type Finding,
  type Match,
} from './types.js';
import { accountUsage } from './usage.js';

const points = { low: 1, medium: 3, high: 5, critical: 8 },
  damage = { low: 4, medium: 8, high: 14, critical: 20 };
export function standings(
  match: Pick<Match, 'findings' | 'usage' | 'config' | 'independentComplete'>,
): Battle {
  const b = initialBattle();
  for (const f of match.findings) {
    if (f.status === 'supported') {
      const a = b[f.discoverer],
        o = b[other(f.discoverer)];
      a.quality += points[f.severity] + Math.min(2, f.evidenceCombos);
      o.damage += damage[f.severity];
      if (
        f.special &&
        f.discoveredBy.length === 1 &&
        match.independentComplete.includes(other(f.discoverer))
      ) {
        a.quality += 3;
        a.special += 25;
        o.damage += 6;
      }
    }
    if (f.status === 'retracted' && f.rebuttedBy) {
      b[f.rebuttedBy].quality += 3;
      b[f.discoverer].damage += 6;
    }
  }
  for (const a of ['claude', 'codex'] as Fighter[]) {
    const f = b[a];
    f.usage = accountUsage(match.usage.filter((r) => r.agent === a));
    f.fatigue =
      f.usage.tokens === null
        ? 0
        : match.config.weight * clamp(f.usage.tokens / match.config.allowance[a], 0, 1);
    f.health = clamp(100 - f.damage - f.fatigue);
    f.special = clamp(f.special);
  }
  return b;
}
export function emit(
  m: Match,
  type: CombatEvent['type'],
  agent: Fighter | null,
  findingId: string | null,
  sourceIds: string[],
  caption: string,
  reason: string,
  at: number,
  usageIds: string[] = [],
  exchange?: ReviewExchange,
) {
  const previous = m.battle,
    next = exchange ? structuredClone(previous) : standings(m),
    seq = m.events.length + 1;
  next.knockout = previous.knockout;
  if (!next.knockout && (next.claude.health <= 0 || next.codex.health <= 0))
    next.knockout = {
      seq,
      winner:
        next.claude.health === next.codex.health
          ? 'draw'
          : next.claude.health > next.codex.health
            ? 'claude'
            : 'codex',
    };
  m.battle = next;
  const e = CombatEvent.parse({
    version: 1,
    id: `${m.id}:${seq}`,
    matchId: m.id,
    seq,
    at,
    type,
    agent,
    findingId,
    sourceIds,
    usageIds,
    caption,
    reason,
    ...(exchange ? { exchange } : {}),
    delta: {
      claude: next.claude.health - previous.claude.health,
      codex: next.codex.health - previous.codex.health,
    },
    scores: { claude: next.claude.quality, codex: next.codex.quality },
    health: { claude: next.claude.health, codex: next.codex.health },
    special: { claude: next.claude.special, codex: next.codex.special },
  });
  m.events.push(e);
  return e;
}
export function applyAnalysis(m: Match, analysis: Analysis, at: number) {
  const copy = structuredClone(m);
  applyAnalysisUnchecked(copy, analysis, at);
  Object.assign(m, copy);
}
function applyExchange(m: Match, raw: ReviewExchange, actions: Action[]) {
  const x = ReviewExchange.parse(raw),
    sources = x.sourceIds.map((id) => m.messages.find((msg) => msg.id === id && !msg.deleted));
  if (sources.some((msg) => !msg))
    throw new Error('Review exchange references missing source messages');
  const author = sources.find((msg) => msg?.agent === x.agent && msg.content.includes(x.quote));
  if (!author)
    throw new Error('Review exchange quote is not present in the acting reviewer’s message');
  if (
    ['challenge', 'rebuttal'].includes(x.type) &&
    !sources.some((msg) => msg?.agent === other(x.agent))
  )
    throw new Error('A review challenge must reference the peer’s contribution');
  if (x.type === 'concession' && sources.length < 2)
    throw new Error('A concession must reference its prior claim or discussion');
  // One semantic beat per topic, reviewer and kind. Rewording or repeating a
  // message cannot farm animation slots. Finding actions already cover their sources.
  if (
    m.exchanges?.some((e) => e.type === x.type && e.agent === x.agent && e.topicKey === x.topicKey)
  )
    return;
  if (
    [...m.actions, ...actions].some(
      (a) => a.agent === x.agent && a.sourceIds.some((id) => x.sourceIds.includes(id)),
    )
  )
    return;
  (m.exchanges ??= []).push(x);
  const types: Record<ReviewExchange['type'], CombatEvent['type']> = {
    inspection: 'round',
    claim: 'attack',
    challenge: 'counter',
    rebuttal: 'parry',
    concession: 'recoil',
    resolution: 'round',
  };
  emit(
    m,
    types[x.type],
    x.agent,
    null,
    x.sourceIds,
    x.caption,
    `Review exchange — no points or damage. ${x.rationale}`,
    author.at,
    [],
    x,
  );
}
function applyAnalysisUnchecked(m: Match, analysis: Analysis, at: number) {
  const previouslyComplete = new Set(m.independentComplete);
  m.independentComplete = [...new Set([...m.independentComplete, ...analysis.independentComplete])];
  m.finalAgents = [...new Set([...m.finalAgents, ...analysis.finalAgents])];
  const time = (item: { agent: Fighter; sourceIds: string[] }) =>
    Math.max(
      0,
      ...m.messages
        .filter((msg) => msg.agent === item.agent && item.sourceIds.includes(msg.id))
        .map((msg) => msg.at),
    );
  const timeline = [
    ...analysis.actions.map((action) => ({ action, exchange: null, time: time(action) })),
    ...(analysis.exchanges ?? []).map((exchange) => ({
      action: null,
      exchange,
      time: time(exchange),
    })),
  ].sort((a, b) => a.time - b.time);
  for (const entry of timeline) {
    if (entry.exchange) {
      applyExchange(m, entry.exchange, analysis.actions);
      continue;
    }
    const raw = entry.action!;
    const a = Action.parse(raw);
    if (
      m.actions.some(
        (p) =>
          p.type === a.type &&
          p.findingId === a.findingId &&
          p.agent === a.agent &&
          JSON.stringify([...p.sourceIds].sort()) === JSON.stringify([...a.sourceIds].sort()) &&
          JSON.stringify(p.evidence) === JSON.stringify(a.evidence),
      )
    )
      continue;
    if (!a.sourceIds.every((id) => m.messages.some((msg) => msg.id === id && !msg.deleted)))
      throw new Error('Analysis references missing source messages');
    if (!a.sourceIds.some((id) => m.messages.some((msg) => msg.id === id && msg.agent === a.agent)))
      throw new Error('Action authorship has no source');
    let f = m.findings.find((f) => f.id === a.findingId);
    if (!f) {
      if (a.type !== 'propose') throw new Error(`Unknown finding ${a.findingId}`);
      if (!a.scenario.trim() || !a.impact.trim() || !a.evidence.length)
        throw new Error('Finding requires scenario, impact and evidence');
      f = {
        id: a.findingId,
        discoverer: a.agent,
        title: a.title,
        severity: a.severity,
        category: a.category,
        scenario: a.scenario,
        impact: a.impact,
        evidence: [],
        sources: [],
        history: [],
        status: 'proposed',
        discoveredBy: [a.agent],
        special: a.move,
        rebuttedBy: null,
        evidenceCombos: 0,
      };
      m.findings.push(f);
    }
    const was = f.status,
      previousSpecial = m.battle[f.discoverer].special;
    f.sources = [...new Set([...f.sources, ...a.sourceIds])];
    f.history.push(a);
    m.actions.push(a);
    let newEvidence = 0;
    for (const e of a.evidence)
      if (!f.evidence.some((p) => JSON.stringify(p) === JSON.stringify(e))) {
        f.evidence.push(e);
        newEvidence++;
      }
    let type: CombatEvent['type'] = 'counter',
      caption = 'CHALLENGE';
    if (a.type === 'propose' || a.type === 'duplicate') {
      if (f.history.length > 1) {
        f.discoveredBy = [...new Set([...f.discoveredBy, a.agent])];
        type = 'block';
        caption = 'SAME DEFECT · BLOCK';
      } else {
        type = 'attack';
        caption = 'FINDING PROPOSED';
      }
    }
    if (a.type === 'support') {
      if (!a.evidence.length) throw new Error('Support requires code evidence');
      f.status = 'supported';
      type = 'attack';
      caption = 'FINDING SUPPORTED';
    }
    if (a.type === 'challenge') {
      f.status = 'challenged';
      caption = 'FINDING CHALLENGED';
    }
    if (a.type === 'rebut') {
      if (!a.evidence.length || a.agent === f.discoverer)
        throw new Error('Successful rebuttal requires opponent evidence');
      f.status = 'retracted';
      f.rebuttedBy = a.agent;
      type = 'parry';
      caption = 'REBUTTAL LANDED';
    }
    if (a.type === 'retract' || a.type === 'concede') {
      if (a.agent === f.discoverer) f.status = 'retracted';
      type = 'recoil';
      caption = a.type === 'retract' ? 'CLAIM RETRACTED' : 'CONCESSION';
    }
    if (a.type === 'evidence') {
      if (!a.evidence.length) throw new Error('Combo requires evidence');
      if (newEvidence) {
        f.evidenceCombos = Math.min(2, f.evidenceCombos + 1);
        type = 'combo';
        caption = 'EVIDENCE COMBO';
      } else {
        type = 'block';
        caption = 'REPEATED EVIDENCE · BLOCK';
      }
    }
    if (a.type === 'unresolved') {
      f.status = 'unresolved';
      type = 'counter';
      caption = 'DISAGREEMENT RETAINED';
    }
    emit(m, type, a.agent, f.id, a.sourceIds, caption, a.rationale, at);
    if (f.history.length === 1 && f.special)
      emit(
        m,
        'special-discovered',
        f.discoverer,
        f.id,
        a.sourceIds,
        'SPECIAL DISCOVERED',
        `${f.special} · candidate only; no bonus yet.`,
        at,
      );
    if (m.battle[f.discoverer].special > previousSpecial)
      emit(
        m,
        'special',
        f.discoverer,
        f.id,
        f.sources,
        f.special ?? 'SPECIAL',
        `Unique supported finding ${f.id}; bonus awarded once.`,
        at,
      );
    if ((was === 'supported' && f.status !== 'supported') || a.type === 'rebut')
      emit(
        m,
        'correction',
        a.agent,
        f.id,
        f.sources,
        'SCORE CORRECTED',
        'Prior rewards removed; standings recomputed from current evidence.',
        at,
      );
  }
  // Independent inspection can confirm novelty after the support message.
  for (const a of m.independentComplete)
    if (!previouslyComplete.has(a)) {
      const candidates = m.findings.filter(
        (f) =>
          f.discoverer !== a &&
          f.status === 'supported' &&
          f.special &&
          f.discoveredBy.length === 1,
      );
      for (const f of candidates)
        if (!m.events.some((e) => e.type === 'special' && e.findingId === f.id))
          emit(
            m,
            'special',
            f.discoverer,
            f.id,
            f.sources,
            f.special!,
            `Independent inspection complete; unique finding ${f.id}.`,
            at,
          );
    }
  m.summary = analysis.summary || m.summary;
  m.updatedAt = at;
}
export function applyFatigue(m: Match, id: string, at: number) {
  const r = m.usage.find((r) => r.id === id);
  if (!r || m.events.some((e) => e.usageIds.includes(id))) return;
  const next = standings(m);
  if (
    next[r.agent].usage.tokens === null ||
    JSON.stringify(next[r.agent].usage) === JSON.stringify(m.battle[r.agent].usage)
  ) {
    next.knockout = m.battle.knockout;
    m.battle = next;
    return;
  }
  // Late records must remain visible in replay before its ending. Preserve the
  // finish event's identity; its displayed standings now include actual usage.
  const ending = m.events.at(-1)?.type === 'finish' ? m.events.pop() : undefined;
  if (ending && m.events.at(-1)?.type === 'finisher') m.events.pop();
  const usageIds = m.usage
    .filter((u) => u.agent === r.agent && !m.events.some((e) => e.usageIds.includes(u.id)))
    .map((u) => u.id);
  const event = emit(
    m,
    'fatigue',
    r.agent,
    null,
    [],
    'TOKEN FATIGUE',
    `${ending ? 'Late usage recovered. ' : ''}Health updated from attributable usage records. ${r.note ?? ''}`.trim(),
    at,
    usageIds,
  );
  event.id = `${m.id}:usage:${id}`;
  if (ending) {
    m.events.push({
      ...ending,
      seq: m.events.length + 1,
      at: Math.max(ending.at, at),
      delta: { claude: 0, codex: 0 },
      health: { ...event.health },
      scores: { ...event.scores },
      special: { ...event.special },
    });
    syncFinisher(m);
  }
}
export function finish(m: Match, at: number) {
  if (m.events.some((e) => e.type === 'finish')) return;
  m.status = 'complete';
  const unresolved = m.findings.filter((f) =>
    ['proposed', 'challenged', 'unresolved'].includes(f.status),
  ).length;
  const reason = unresolved
    ? 'Unresolved findings remain in the ledger; see the final reviews.'
    : m.findings.some((f) => f.status === 'supported')
      ? 'Supported findings are recorded in the ledger; see the final reviews.'
      : 'No substantiated defects were retained. See the review discussion and validation limits.';
  emit(
    m,
    'finish',
    null,
    null,
    m.messages.filter((x) => x.agent).map((x) => x.id),
    'REVIEW COMPLETE',
    reason,
    at,
  );
  syncFinisher(m);
}
export function newMatch(
  id: string,
  title: string,
  demo = false,
  allowance = 100000,
  weight = 30,
): Match {
  return {
    id,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'queued',
    demo,
    scope: null,
    packet: '',
    omissions: [],
    rootId: null,
    messages: [],
    findings: [],
    actions: [],
    exchanges: [],
    usage: [],
    events: [],
    independentComplete: [],
    finalAgents: [],
    battle: initialBattle(),
    error: null,
    analysisUsage: { input: 0, output: 0, calls: 0 },
    prepUsage: { input: 0, output: 0 },
    config: { allowance: { claude: allowance, codex: allowance }, weight },
    summary: '',
  };
}
