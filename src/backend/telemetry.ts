import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Fighter, UsageRecord } from '../core/types.js';

const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Counters = z.object({
  inputTokens: Count.nullable(),
  outputTokens: Count.nullable(),
  totalTokens: Count.nullable(),
});
export const LocalUsage = z
  .object({
    id: z.string(),
    matchId: z.string(),
    agent: z.enum(['claude', 'codex']),
    sessionId: z.string(),
    turnId: z.string(),
    turnSeq: Count.nullable(),
    at: Count,
    turn: Counters.nullable(),
    cumulative: Counters.nullable(),
    deltaReliable: z.boolean(),
    attributed: z.literal(true),
    source: z.enum(['acp', 'provider-log']),
    partial: z.boolean().optional(),
    note: z.string().optional(),
  })
  .strict();
export type Binding = {
  agent: Fighter;
  sessionId: string;
  rootId: string;
  matchId: string;
  active: boolean;
};
const promptUsage = z.object({
  inputTokens: Count,
  outputTokens: Count,
  totalTokens: Count,
  cachedReadTokens: Count.nullish(),
  cachedWriteTokens: Count.nullish(),
});
export function promptUsageRecord(
  agent: Fighter,
  matchId: string,
  sessionId: string,
  seq: number,
  result: unknown,
  at: number,
): UsageRecord | null {
  const parsed = promptUsage.safeParse((result as any)?.usage);
  if (!parsed.success) return null;
  const u = parsed.data,
    input = u.inputTokens + (u.cachedReadTokens ?? 0) + (u.cachedWriteTokens ?? 0);
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(input + u.outputTokens)) return null;
  return {
    id: `acp:${agent}:${sessionId}:${seq}`,
    matchId,
    agent,
    sessionId,
    turnId: `acp:${seq}`,
    turnSeq: seq,
    at,
    turn: {
      inputTokens: input,
      outputTokens: u.outputTokens,
      totalTokens: agent === 'codex' ? u.totalTokens : null,
    },
    cumulative: null,
    deltaReliable: true,
    attributed: true,
    source: 'acp',
    ...(agent === 'codex'
      ? {
          partial: true,
          note: 'Installed Codex ACP reports the last model response, not the full tool-using turn. Provider turn records supersede this partial reading.',
        }
      : {
          note: 'ACP completed-turn usage; inclusive input includes cache reads and writes exactly once.',
        }),
  };
}
// Read only an exact bound session file. No profile-wide transcript discovery.
function lines(file: string): any[] {
  if (statSync(file).size > 32 * 1024 * 1024)
    throw new Error('Usage source exceeds bounded read limit');
  const text = readFileSync(file, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}
export function readLocalUsage(
  directory: string,
  agent: Fighter,
  matchId: string,
  bindings: Binding[],
): UsageRecord[] {
  try {
    return lines(join(directory, `${agent}.usage.jsonl`)).flatMap((raw) => {
      const r = LocalUsage.safeParse(raw);
      return r.success &&
        r.data.agent === agent &&
        r.data.matchId === matchId &&
        bindings.some((b) => b.sessionId === r.data.sessionId)
        ? [r.data]
        : [];
    });
  } catch {
    return [];
  }
}
const rawCodex = z.object({
  thread_id: z.string(),
  session_id: z.string(),
  turn_id: z.string(),
  response_id: z.string(),
  usage: z.object({ input_tokens: Count, output_tokens: Count, total_tokens: Count }),
  thread_token_usage: z.object({ total_tokens: Count }),
});
export function codexUsageRecords(rows: any[], binding: Binding): UsageRecord[] {
  const responses = new Map<string, z.infer<typeof rawCodex>>(),
    completed = new Map<string, number>();
  for (const r of rows) {
    if (r.type === 'token_usage_record') {
      const p = rawCodex.safeParse(r.payload);
      if (
        p.success &&
        p.data.thread_id === binding.sessionId &&
        p.data.session_id === binding.sessionId
      )
        responses.set(p.data.response_id, p.data);
    }
    if (
      r.type === 'event_msg' &&
      r.payload?.type === 'task_complete' &&
      typeof r.payload.turn_id === 'string' &&
      Number.isFinite(Date.parse(r.timestamp))
    )
      completed.set(r.payload.turn_id, Date.parse(r.timestamp));
  }
  const groups = new Map<
    string,
    { inputTokens: number; outputTokens: number; totalTokens: number }
  >();
  for (const r of responses.values()) {
    const g = groups.get(r.turn_id) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    g.inputTokens += r.usage.input_tokens;
    g.outputTokens += r.usage.output_tokens;
    g.totalTokens += r.usage.total_tokens;
    groups.set(r.turn_id, g);
  }
  // Require a complete response series from the known new review session. A
  // truncated file or missing response cannot masquerade as a complete total.
  const last = [...responses.values()].at(-1);
  if (
    !last ||
    [...groups.values()].reduce((n, g) => n + g.totalTokens, 0) !==
      last.thread_token_usage.total_tokens
  )
    return [];
  return [...groups].flatMap(([turnId, turn]) =>
    completed.has(turnId) && Object.values(turn).every(Number.isSafeInteger)
      ? [
          {
            id: `provider:codex:${binding.sessionId}:${turnId}`,
            matchId: binding.matchId,
            agent: 'codex' as const,
            sessionId: binding.sessionId,
            turnId,
            turnSeq: null,
            at: completed.get(turnId)!,
            turn,
            cumulative: null,
            deltaReliable: true,
            attributed: true,
            source: 'provider-log' as const,
            note: 'Provider-reported response totals in the bound review session, grouped at turn completion; cache subsets are not added.',
          },
        ]
      : [],
  );
}
export function readCodexUsage(directory: string, binding: Binding): UsageRecord[] {
  let db: DatabaseSync | undefined;
  try {
    const home = join(directory, 'codex-profile');
    db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
    const row = db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(binding.sessionId) as
      { rollout_path: string } | undefined;
    if (!row) return [];
    const file = realpathSync(row.rollout_path),
      root = realpathSync(join(home, 'sessions')) + sep;
    if (!file.startsWith(root)) return [];
    return codexUsageRecords(lines(file), binding);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
const claudeRow = z.object({
  type: z.literal('assistant'),
  sessionId: z.string(),
  timestamp: z.string(),
  message: z.object({
    id: z.string(),
    usage: z.object({
      input_tokens: Count,
      output_tokens: Count,
      cache_read_input_tokens: Count,
      cache_creation_input_tokens: Count,
    }),
  }),
});
export function claudeUsageRecords(rows: any[], binding: Binding): UsageRecord[] {
  const messages = new Map<string, z.infer<typeof claudeRow>>();
  for (const row of rows) {
    const r = claudeRow.safeParse(row);
    if (
      r.success &&
      r.data.sessionId === binding.sessionId &&
      Number.isFinite(Date.parse(r.data.timestamp))
    )
      messages.set(r.data.message.id, r.data);
  }
  return [...messages.values()].flatMap((r) => {
    const u = r.message.usage,
      input = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
    if (!Number.isSafeInteger(input + u.output_tokens)) return [];
    return [
      {
        id: `provider:claude:${binding.sessionId}:${r.message.id}`,
        matchId: binding.matchId,
        agent: 'claude' as const,
        sessionId: binding.sessionId,
        turnId: r.message.id,
        turnSeq: null,
        at: Date.parse(r.timestamp),
        turn: { inputTokens: input, outputTokens: u.output_tokens, totalTokens: null },
        cumulative: null,
        deltaReliable: true,
        attributed: true,
        source: 'provider-log' as const,
        partial: true,
        note: 'Recovered provider message usage, deduplicated by response ID. Input + output is derived; auxiliary/internal provider calls may be absent.',
      },
    ];
  });
}
export function recoverClaudeUsage(
  directory: string,
  claudeHome: string,
  binding: Binding,
): UsageRecord[] {
  if (!/^[a-f0-9-]{36}$/.test(binding.sessionId)) return [];
  const project = resolve(directory, 'model-work').replace(/[^a-zA-Z0-9]/g, '-');
  try {
    return claudeUsageRecords(
      lines(join(claudeHome, 'projects', project, `${binding.sessionId}.jsonl`)),
      binding,
    );
  } catch {
    return [];
  }
}
