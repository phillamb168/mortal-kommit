import type { Battle, CombatEvent, Fighter, Match } from './types.js';
import { CombatEvent as EventSchema } from './types.js';

export const finishers: Record<Fighter, { name: string; description: string }> = {
  claude: {
    name: 'CONTEXT COLLAPSE',
    description: 'An amber vortex collapses into a close-range palm strike.',
  },
  codex: {
    name: 'FORCE PUSH: ORBITAL',
    description: 'A rocket-assisted uppercut launches the opponent through a cyan shockwave.',
  },
};
export function boutWinner(
  event: Pick<CombatEvent, 'scores' | 'seq'>,
  knockout: Battle['knockout'],
): { winner: Fighter | 'draw'; basis: 'quality' | 'knockout' | 'draw' } {
  if (knockout && event.seq >= knockout.seq)
    return { winner: knockout.winner, basis: knockout.winner === 'draw' ? 'draw' : 'knockout' };
  if (event.scores.claude === event.scores.codex) return { winner: 'draw', basis: 'draw' };
  return {
    winner: event.scores.claude > event.scores.codex ? 'claude' : 'codex',
    basis: 'quality',
  };
}
// This is a presentation award. Keep every measured health value, finding and
// quality score intact. Also upgrades old recordings without any model calls.
export function syncFinisher(m: Match): boolean {
  const ending = m.events.at(-1);
  if (ending?.type !== 'finish') return false;
  const result = boutWinner(ending, m.battle.knockout),
    old = m.events.filter((e) => e.type === 'finisher');
  if (result.winner === 'draw') {
    if (!old.length) return false;
    m.events = m.events.filter((e) => e.type !== 'finisher');
    m.events.forEach((e, i) => (e.seq = i + 1));
    return true;
  }
  if (!ending.sourceIds.length && !ending.usageIds.length) return false;
  const agent = result.winner,
    move = finishers[agent].name;
  const { exchange: ignoredExchange, finisher: ignoredFinisher, ...base } = ending;
  const event = EventSchema.parse({
    ...base,
    id: `${m.id}:finisher`,
    type: 'finisher',
    agent,
    findingId: null,
    finisher: { move, basis: result.basis },
    caption: move,
    reason: `${agent.toUpperCase()} wins ${result.basis === 'knockout' ? 'the recorded arcade knockout' : `on review quality (${ending.scores[agent]} points)`}. ${finishers[agent].description} Victory animation only; measured health and review scores are unchanged.`,
    delta: { claude: 0, codex: 0 },
  });
  const events = m.events.filter((e) => e.type !== 'finisher');
  events.splice(events.length - 1, 0, event);
  events.forEach((e, i) => (e.seq = i + 1));
  const changed = JSON.stringify(m.events) !== JSON.stringify(events);
  m.events = events;
  return changed;
}
