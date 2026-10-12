import { z } from 'zod';

export const Fighter = z.enum(['claude', 'codex']);
export type Fighter = z.infer<typeof Fighter>;
export const other = (a: Fighter): Fighter => (a === 'claude' ? 'codex' : 'claude');
export const Evidence = z
  .object({
    file: z.string().min(1),
    line: z.number().int().positive(),
    endLine: z.number().int().positive(),
    quote: z.string().min(3),
    revision: z.enum(['base', 'head']),
  })
  .strict();
export type Evidence = z.infer<typeof Evidence>;
export const Category = z.enum([
  'correctness',
  'security',
  'data-loss',
  'concurrency',
  'compatibility',
  'performance',
]);
export const Severity = z.enum(['low', 'medium', 'high', 'critical']);
export const FindingStatus = z.enum([
  'proposed',
  'challenged',
  'supported',
  'retracted',
  'unresolved',
]);
export const Action = z
  .object({
    type: z.enum([
      'propose',
      'duplicate',
      'support',
      'challenge',
      'rebut',
      'concede',
      'retract',
      'evidence',
      'unresolved',
    ]),
    agent: Fighter,
    findingId: z.string(),
    title: z.string(),
    severity: Severity,
    category: Category,
    scenario: z.string(),
    impact: z.string(),
    rationale: z.string().min(1),
    evidence: z.array(Evidence).max(8),
    sourceIds: z.array(z.string()).min(1).max(12),
    move: z
      .enum([
        'EDGE CASE UPPERCUT',
        'RACE CONDITION ROUNDHOUSE',
        'NULL POINTER PILEDRIVER',
        'AUTH BYPASS BREAKER',
      ])
      .nullable(),
  })
  .strict();
export type Action = z.infer<typeof Action>;
export const ReviewExchange = z
  .object({
    type: z.enum(['inspection', 'claim', 'challenge', 'rebuttal', 'concession', 'resolution']),
    agent: Fighter,
    topicKey: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    caption: z.string().min(1).max(64),
    rationale: z.string().min(1).max(1800),
    sourceIds: z.array(z.string()).min(1).max(12),
    quote: z.string().min(12).max(1600),
  })
  .strict();
export type ReviewExchange = z.infer<typeof ReviewExchange>;
export const Analysis = z
  .object({
    actions: z.array(Action).max(16),
    exchanges: z.array(ReviewExchange).max(16).default([]),
    independentComplete: z.array(Fighter),
    finalAgents: z.array(Fighter),
    summary: z.string(),
  })
  .strict();
export type Analysis = z.input<typeof Analysis>;
export interface Message {
  id: string;
  matchId: string;
  pubkey: string;
  agent: Fighter | null;
  at: number;
  content: string;
  rootId: string;
  revision: number;
  deleted?: boolean;
  replaces?: string;
  raw?: unknown;
}
export interface Finding {
  id: string;
  discoverer: Fighter;
  title: string;
  severity: z.infer<typeof Severity>;
  category: z.infer<typeof Category>;
  scenario: string;
  impact: string;
  evidence: Evidence[];
  sources: string[];
  history: Action[];
  status: z.infer<typeof FindingStatus>;
  discoveredBy: Fighter[];
  special: string | null;
  rebuttedBy: Fighter | null;
  evidenceCombos: number;
}
export interface Commit {
  sha: string;
  subject: string;
}
export interface RemoteReview {
  url: string;
  title: string;
  description: string;
  discussion: string;
  target: string;
  start: string;
}
export interface Scope {
  repo: string;
  branch: string;
  mode: 'unpublished' | 'base' | 'mr' | 'pr' | 'demo';
  base: string;
  head: string;
  comparison: string;
  commits: Commit[];
  dirty: boolean;
  warnings: string[];
  changedFiles: string[];
  mr?: RemoteReview;
  pr?: RemoteReview;
}
export interface UsageRecord {
  source?: 'buzz' | 'acp' | 'provider-log';
  partial?: boolean;
  note?: string;
  id: string;
  matchId: string;
  agent: Fighter;
  sessionId: string | null;
  turnId: string | null;
  turnSeq: number | null;
  at: number;
  turn: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  } | null;
  cumulative: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  } | null;
  deltaReliable: boolean;
  attributed: boolean;
}
export interface UsageTotal {
  tokens: number | null;
  label: 'reported' | 'derived' | 'partial' | 'unavailable';
  records: string[];
  notes: string[];
}
export const CombatEvent = z
  .object({
    version: z.literal(1),
    id: z.string(),
    matchId: z.string(),
    seq: z.number().int().positive(),
    at: z.number(),
    type: z.enum([
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
      'round',
      'finisher',
      'finish',
    ]),
    agent: Fighter.nullable(),
    findingId: z.string().nullable(),
    sourceIds: z.array(z.string()),
    usageIds: z.array(z.string()),
    caption: z.string(),
    reason: z.string(),
    exchange: ReviewExchange.optional(),
    finisher: z
      .object({ move: z.string().min(1).max(64), basis: z.enum(['quality', 'knockout']) })
      .strict()
      .optional(),
    delta: z.object({ claude: z.number(), codex: z.number() }),
    scores: z.object({ claude: z.number(), codex: z.number() }),
    health: z.object({ claude: z.number(), codex: z.number() }),
    special: z.object({ claude: z.number(), codex: z.number() }),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (
      event.type === 'finisher' &&
      (!event.finisher ||
        !event.agent ||
        event.delta.claude !== 0 ||
        event.delta.codex !== 0 ||
        (!event.sourceIds.length && !event.usageIds.length))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'A finisher requires an evidenced winner and cannot change measured health.',
      });
  });
export type CombatEvent = z.infer<typeof CombatEvent>;
export interface FighterState {
  health: number;
  damage: number;
  fatigue: number;
  quality: number;
  special: number;
  usage: UsageTotal;
}
export interface Battle {
  claude: FighterState;
  codex: FighterState;
  knockout: { seq: number; winner: Fighter | 'draw' } | null;
}
export interface Match {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: 'queued' | 'scouting' | 'reviewing' | 'waiting' | 'complete' | 'failed';
  demo: boolean;
  scope: Scope | null;
  packet: string;
  omissions: string[];
  rootId: string | null;
  messages: Message[];
  findings: Finding[];
  actions: Action[];
  exchanges?: ReviewExchange[];
  usage: UsageRecord[];
  events: CombatEvent[];
  independentComplete: Fighter[];
  finalAgents: Fighter[];
  battle: Battle;
  error: string | null;
  analysisUsage: { input: number; output: number; calls: number };
  prepUsage: { input: number; output: number };
  config: { allowance: Record<Fighter, number>; weight: number };
  summary: string;
}
export const clamp = (n: number, min = 0, max = 100) => Math.max(min, Math.min(max, n));
export function initialBattle(): Battle {
  const fighter = (): FighterState => ({
    health: 100,
    damage: 0,
    fatigue: 0,
    quality: 0,
    special: 0,
    usage: { tokens: null, label: 'unavailable', records: [], notes: [] },
  });
  return { claude: fighter(), codex: fighter(), knockout: null };
}
