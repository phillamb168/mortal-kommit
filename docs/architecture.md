# Architecture and review rules

```text
CLI / human channel member !review in ARENA
  → fresh Git range / immutable GitLab diff_refs / GitHub PR head and merge-base
  → bounded sanitized base/head snapshot
  → separate neutral Codex scout
  → two initial Buzz messages in a dedicated review thread

Buzz harness ↔ configured Claude / Codex adapters
  ↔ scoped read-only source + Buzz thread tools
  ↔ normal Buzz peer mentions and message dispatch

verified Buzz events + owner-decrypted usage
  → SQLite observation store
  → independent structured semantic analyzer
  → finding ledger + deterministic battle reducer
  → SSE → React / Canvas / Web Audio
```

## Separation of responsibilities

`repository.ts` resolves scope and sanitizes snapshots. `models.ts` invokes a separate neutral Codex preparation and nonparticipating analyzer. `buzz.ts` owns signing/relay access, while `coordinator.ts` does the initial kickoff, observes messages, associates usage, and controls application-owned lifecycle. The analyzer has no Buzz delivery API and never schedules conversational turns. `acp-proxy.ts` restricts the normal installed provider adapter; `capabilities.ts` exposes bounded snapshot and current-thread communication tools to the reviewer itself.

The permanent private ARENA channel contains separate review threads. The app creates one stable pair and runs one active match at a time. Observation is keyed by thread, authorship, signed message ID, provider session, and review ID. Historical events and reconnect deliveries are deduplicated in SQLite. A message edit/deletion invalidates dependent rewards pending reanalysis. Other reviews and unrelated owner-agent activity never earn tokens or damage in the current match.

`membership.ts` authorizes teammate kickoff with a fresh `buzz channels members --channel` lookup and an authenticated signed kind-0 profile lookup through Buzz's `/query` bridge. The installed CLI was exercised against a loopback fixture to confirm its `{pubkey, role}` output and query filter. Eligible roles are owner, admin, member, and guest. Bot roles, `bot: true` profiles, identities carrying NIP-OA auth tags, and the dedicated fighters are excluded. An absent optional profile is compatible with ordinary human channel membership; malformed responses fail closed. This is Buzz identity classification, not a claim to detect a person automating an ordinary human account.

Each accepted command retains its signed source event and requester public key in the local audit records. Concurrent deliveries and reconnect history cannot enqueue it twice. Current membership is rechecked before preparation and again before review kickoff. Requests must be new topics and can select only host-registered repositories. A queue acknowledgement is an application kickoff message; it does not introduce an agent turn scheduler. The analyzer remains a nonparticipant.

The browser receives persisted match snapshots through authenticated SSE. Reconnects receive the complete current snapshot, making history recovery independent of missed deltas. The browser queues recorded events; idle animation has no scoring effect. Replay uses saved events without new preparation, reviewer, or analyzer calls.

## Ledger and combat

The analyst returns strict Zod/JSON-schema data: finding actions, review exchanges, independent-inspection completions, and final-agent markers. Source authorship is checked; file/line/quote evidence is verified against the pinned snapshot. An analysis batch is validated atomically. The model groups semantically identical defects under a stable finding ID. This is semantic classification, not keyword counting; model mistakes remain possible and evidence is visible.

Findings preserve discovery, severity, practical scenario/impact, evidence, source messages, challenges, and status: proposed, challenged, supported, retracted, or unresolved. An agreement without concrete evidence is not sufficient for support. Unsupported/cosmetic claims do not score. Completed exports retain unresolved disagreements.

Substantive review exchanges also remain visible when the final review contains no defects. The analyzer can classify a completed inspection, concrete concern, challenge, refutation, concession, or final resolution. Each exchange contains a verbatim source quote and signed-message references; challenges also reference the peer's contribution, and concessions reference earlier discussion. Repeated arguments share a topic key, and finding actions take precedence over exchanges from the same source. Greetings, status chatter, repeated arguments and cosmetic nits are skipped. Exchanges animate but never change health, quality, or special meters, and the arena explicitly labels them “no points or damage.” Their captions and evidence are persisted for replay, with no model calls during playback. An empty final ledger therefore does not erase the debate that produced it.

| Event                                                          | Quality / damage                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Proposed actionable finding                                    | Attack animation; zero reward until supported                                        |
| Supported low / medium / high / critical                       | Discoverer quality +1 / +3 / +5 / +8; opponent damage 4 / 8 / 14 / 20                |
| Unique supported finding after opponent independent inspection | One special bonus: quality +3, opponent damage +6, special meter +25                 |
| Candidate unique finding                                       | SPECIAL DISCOVERED caption; no immediate bonus                                       |
| Duplicate underlying defect                                    | Block; no repeated reward; uniqueness bonus withdrawn if applicable                  |
| Challenge                                                      | Counterattack animation; no damage merely for objecting                              |
| Successful evidence-backed rebuttal                            | Parry; rebutter quality +3 and opponent damage +6; original finding reward withdrawn |
| Additional distinct supporting evidence                        | Combo; quality +1, capped at two additions per finding                               |
| Retraction / invalidated support                               | Recompute scores and damage; record correction with explanation                      |

Special identifiers include EDGE CASE UPPERCUT, RACE CONDITION ROUNDHOUSE, NULL POINTER PILEDRIVER, and AUTH BYPASS BREAKER. Add names to the schema/semantic mapping to extend the vocabulary. Repeated source/action/evidence combinations cannot farm points. Health and quality are separate. A recorded KO closes the arcade result while observation/review may continue.

## Token accounting

Owner-authorized NIP-AM kind 44200 events are signature-checked and NIP-44 decrypted in the backend. Only the dedicated pair's events can qualify. Attribution requires the active review's provider-session binding or a trusted harness turn mapping; sharing the ARENA channel alone is insufficient. NIP-AO control observation is reduced to attribution metadata; its transcript bodies are not retained.

The read-only proxy keeps a launcher named `claude-agent-acp` or `codex-acp`: Buzz 0.5.23 selects standard ACP metrics by executable basename. Naming both launchers `node` silently disables that path. The proxy also persists validated `session/prompt` response usage locally before marking the provider idle, so relay delivery is not the only copy. Context occupancy (`usage_update.used/size`) is never treated as spend.

Installed Claude ACP 0.75.1 reports completed-turn input/output and separate cache categories. These are normalized to inclusive input once; its computed total is labeled derived. Installed Codex ACP 1.10.0 reports only its last model response in `PromptResponse.usage`, so that reading is partial. For Codex, the backend reads the exact bound thread's rollout through its isolated `state_5.sqlite`, validates provider response IDs and cumulative coverage, and groups reported totals at `task_complete`. It does not scan other profiles. A schema change, missing response series or escaped path fails closed. Raw transcripts are not copied into the arena.

Accounting selects one source per provider session: complete provider response records, then the local ACP capture, then NIP-AM. These are alternative readings of the same spend, never additive. A completed match can receive late usage; its replay retains the fatigue events before the final standings. Historical Claude recovery from response records is explicitly partial because internal/auxiliary calls may be absent.

Prefer reported totals. Otherwise derive from reported input + output, label them derived, and do not add cached-input subsets again. Deduplicate both event ID and logical session/turn identity. Reliable per-turn counters are counted directly. Cumulative counters need consecutive records in the same session; missing baselines, gaps, resets, or unreliable deltas are omitted and marked partial. Explicit reported zero is valid; missing data is null. No continuous counter or message-length estimate is invented.

```text
fatigue = weight × clamp(tokens / allowance, 0, 1)
health = clamp(100 − combatDamage − fatigue, 0, 100)
```

Preparation and analyzer usage are stored separately, never charged to fighters. A configurable allowance is a health scale, not a hard provider budget.

## Source protection

The application fetches objects into its own bare repository and materializes bounded sanitized snapshots, excluding secret-like content, credential files, symlinks, generated noise, binaries, and oversized files. Context reads cap at 80 files/256 KiB; the packet diff caps at 128 KiB. Snapshot materialization caps at 24 MiB overall (12 MiB reserved per revision, changed files first), 256 KiB per file, and 12,000 files per revision. GitLab discussion caps at 20 pages and 64,000 bytes. GitHub discussion caps at 10 pages per resource (conversation comments, review summaries, inline comments) and 64,000 bytes combined, with a 32,000-byte description cap. Omissions are recorded.

Provider sessions are accepted only for the registered review thread. Their tools are replaced with bounded snapshot list/read/search/context and same-thread Buzz read/send. Built-in execution, filesystem writes, hooks, additional agents, project configuration, and unrelated MCP servers are disabled. Codex uses an application-owned auth-only home for reviewers. No repository code or reproduction test is executed. Git hooks/fsmonitor/external diff/textconv/ext transport are disabled during collection. The original checkout is never passed as the provider working directory.

These controls enforce capabilities in the backend. Prompt text also describes the boundary, but is not the enforcement mechanism. Models still receive source as review material; secret filtering is conservative rather than a guarantee of detecting every possible credential format.

The local server uses separate random control and viewer capabilities exchanged from URL fragments to HttpOnly cookies, exact Host/Origin checks, loopback binding, and a restrictive CSP. Shared Buzz links always use a viewer capability. The optional ngrok gateway uses another independent viewer credential, forwards only viewing/export routes, and does not expose local control credentials. A running tunnel's public viewer URL is selected for new Buzz acknowledgements and kickoffs; otherwise the link points to the host's loopback viewer. Application-owned child process groups are stopped on normal exit without changing unrelated Buzz processes. Abrupt machine/process crashes may require restarting the local service; saved reviews remain available.

## Inspected Buzz interfaces

Implementation was checked against installed Buzz 0.5.23 CLI/harness help and installed adapter sources, together with the project's [NIP-AM](https://github.com/block/buzz/blob/main/docs/nips/NIP-AM.md), [NIP-AO](https://github.com/block/buzz/blob/main/docs/nips/NIP-AO.md), and [NIP-OA](https://github.com/block/buzz/blob/main/docs/nips/NIP-OA.md) documents. The arena is a companion browser link; no undocumented Buzz embedding interface is assumed.

## Contact choreography and victory finishers

`src/web/choreography.ts` produces deterministic sprite poses, contact coordinates and audio cues independently of the ledger. Strike/target points in the atlas determine closing distance. Blocking and parrying bring the incoming opponent's fist to the defender's guard. Three-hit combos have separate contact cues; a brief hold locks both cels at impact. Playback speed scales the same visual clock that triggers sound, and pausing stops future impact cues. Reduced motion removes launch, zoom, camera shake and particle effects.

At review completion, `src/core/ending.ts` inserts one evidence-linked `finisher` event for a recorded knockout winner or the reviewer with higher quality. Ties remain draws, regardless of token estimates. Claude receives CONTEXT COLLAPSE; Codex receives FORCE PUSH: ORBITAL. A finisher has zero health delta and cannot manufacture a finding or change usage. Its source messages and recorded scores explain the award. Existing completed recordings are upgraded locally when the server starts. Late usage remains before the finisher and final result, and replay never invokes a model.

## GitHub provider

`forge.ts` validates request URLs, mutually exclusive scopes and exact registered origins. `github.ts` uses the host’s authenticated `gh api` for read-only metadata and discussion. It fetches the target origin into an application-owned bare repository, verifies `refs/pull/N/head` against `head.sha`, pins `base.sha`, computes the unique merge-base, then rechecks both revisions and branch names. Fork-provided clone URLs and synthetic merge commits are never used. `Scope.pr` stores provider material separately from legacy `Scope.mr`, so existing recordings remain compatible. Context preparation and reviewer capabilities use the same base/head snapshot path for both providers.
