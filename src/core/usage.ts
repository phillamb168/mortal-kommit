import type { UsageRecord, UsageTotal } from './types.js';

function count(v: UsageRecord['turn']): { n: number; derived: boolean } | null {
  if (!v) return null;
  const valid = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (valid(v.totalTokens)) return { n: v.totalTokens, derived: false };
  // NIP-AM input is inclusive of cache subsets. Never add cache counters.
  if (valid(v.inputTokens) && valid(v.outputTokens))
    return { n: v.inputTokens + v.outputTokens, derived: true };
  return null;
}
export function accountUsage(records: UsageRecord[]): UsageTotal {
  const ids = new Set<string>(),
    turns = new Set<string>();
  let total = 0,
    measured = 0,
    derived = false,
    partial = false;
  const notes = new Set<string>(),
    used: string[] = [];
  const baselines = new Map<string, { seq: number; n: number; derived: boolean }>();
  // One accounting stream per provider session. Local provider records cover
  // tool calls omitted by some ACP adapters; never add them to their relay copy.
  const rank = (r: UsageRecord) => (r.source === 'provider-log' ? 3 : r.source === 'acp' ? 2 : 1);
  const sources = new Map<string, number>();
  for (const r of records)
    if (r.attributed) {
      const key = `${r.agent}:${r.sessionId ?? r.id}`;
      sources.set(key, Math.max(sources.get(key) ?? 0, rank(r)));
    }
  const selected = records.filter(
    (r) => rank(r) === sources.get(`${r.agent}:${r.sessionId ?? r.id}`),
  );
  const sorted = [...selected].sort(
    (a, b) =>
      (a.sessionId ?? '').localeCompare(b.sessionId ?? '') ||
      (a.turnSeq ?? Infinity) - (b.turnSeq ?? Infinity) ||
      a.at - b.at ||
      a.id.localeCompare(b.id),
  );
  for (const r of sorted) {
    if (ids.has(r.id) || !r.attributed) continue;
    ids.add(r.id);
    const turnKey =
      r.sessionId && (r.turnSeq !== null || r.turnId)
        ? `${r.agent}:${r.sessionId}:${r.turnSeq ?? r.turnId}`
        : null;
    if (turnKey && turns.has(turnKey)) continue;
    if (turnKey) turns.add(turnKey);
    const turn = count(r.turn),
      cum = count(r.cumulative),
      key = r.sessionId ? `${r.agent}:${r.sessionId}` : null;
    const prev = key ? baselines.get(key) : undefined;
    let contribution: { n: number; derived: boolean } | null = null;
    if (r.deltaReliable && turn) contribution = turn;
    else if (
      cum &&
      prev &&
      r.turnSeq !== null &&
      r.turnSeq === prev.seq + 1 &&
      cum.n >= prev.n &&
      cum.derived === prev.derived
    )
      contribution = { n: cum.n - prev.n, derived: cum.derived };
    else {
      partial = true;
      notes.add(
        cum && !prev
          ? 'Cumulative baseline missing; first total excluded.'
          : 'Missing or unreliable turn delta; excluded.',
      );
    }
    if (cum && key && r.turnSeq !== null) {
      if (prev && cum.n < prev.n) {
        partial = true;
        notes.add('Counter reset; a new baseline was established.');
      }
      baselines.set(key, { seq: r.turnSeq, n: cum.n, derived: cum.derived });
    }
    if (r.partial) {
      partial = true;
    }
    if (r.note) notes.add(r.note);
    if (contribution) {
      total += contribution.n;
      measured++;
      derived ||= contribution.derived;
      used.push(r.id);
    }
  }
  return {
    tokens: measured ? total : null,
    label: !measured ? 'unavailable' : partial ? 'partial' : derived ? 'derived' : 'reported',
    records: used,
    notes: [...notes],
  };
}
