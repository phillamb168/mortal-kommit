# Verification and limits

Tested locally on macOS, Node 22.23.1, Buzz 0.5.23 and its installed Claude/Codex ACP adapters. Latest verification: October 12, 2026. The web runtime was also built and exercised in the supplied Linux container. CI targets macOS/Linux and Node 22/24. The first hosted run exposed a missing build prerequisite in the viewer integration test; `npm test` now builds the application before running the suite.

## Reproducible checks

```sh
npm ci
npm run release:check
```

The suite uses temporary Git repositories, fixture GitHub/GitLab responses, signed Nostr events, encrypted owner telemetry, SQLite, an actual capability-proxy subprocess and a loopback HTTP server. No credentials or model calls are required. `npm test` runs the build first so the viewer can serve `dist/web` even on a clean checkout; no pre-existing build artifacts are needed. Package validation includes both sprite atlases, distribution file inventory and high-confidence credential patterns.

The corrected pipeline passed `npm ci` and `npm run release:check` from four clean source copies with no `dist` or `node_modules`: Node 22 and 24 on macOS, and Node 22 and 24 in Linux containers. All 86 tests, asset validation and package checks passed in each configuration. These are local reproductions; hosted Actions results are recorded on the corresponding GitHub commit.

Coverage includes:

- Unpublished commits versus published history, current upstream state, divergence, missing bases, empty ranges, and checkout/ref preservation.
- GitLab exact diff revisions and separately configured SSH hosts; GitHub target/head pins, fork PRs, merge-base comparisons, force pushes, target advances, retargeting, registered origin matching, discussion pagination/budgets, authentication errors and secret filtering.
- Source access beyond the diff: unchanged callers can be read and searched in the pinned snapshot; dirty working-tree edits are excluded.
- Human channel authorization, bot/outsider rejection, membership removal, signed requester provenance, duplicate delivery, authenticated relay reconnects and independent review threads.
- Finding deduplication, evidence validation, supported scoring, reversible specials, rebuttals/retractions, and unscored debate in a clean review.
- Session-scoped token attribution, reported/partial usage, provider-response deduplication, cached input, cumulative baselines/resets, late reports, health and replay.
- Exact contact points for both fighters, combos, hit pauses, sound cue timing, both finishers, draws, reduced motion, deterministic migrations and late-usage ordering.
- Authenticated HTTP/SSE reconnect, viewer versus control permissions, persisted replay, exports and application-owned process cleanup.
- Permanent viewer origin/config/environment validation, Host/Origin spoof rejection, authenticated exports, streamed updates and reconnects, persistent links across restarts, key rotation disconnecting active viewers, occupied-port cleanup, and the shared ngrok gateway's local-only shutdown.

The scripted demo has 12 messages, 3 findings and 19 combat events including Claude's finisher. It is always labeled as simulated and is not proof of a real review.

## Live integration checks

A private GitLab MR completed through Buzz ARENA. Both restricted reviewers independently inspected pinned source, exchanged challenges and concessions, and published final reviews. The observer persisted their messages and finished without scheduling the dialogue. No substantiated defects remained. Private repository names, revisions, identity details and conversation are intentionally absent from this public record.

The real review exposed and verified fixes for NIP-42 authentication acknowledgement, separate channel/owner-telemetry subscriptions, Buzz Markdown autolinks, unscored debate replay, and adapter usage attribution. Reported Codex usage and explicitly partial Claude provider usage were recovered from their exact bound sessions. Both exhausted the configured fatigue allowance, leaving 70 health and tied quality; preparation and analysis remained separate. Replay made no new model calls.

GitHub uses the same preparation, restricted reviewers, analysis and presentation after scope resolution. A read-only preflight against the public `cli/cli` PR #14636 used authenticated `gh`, fetched the exact head and target, selected one commit and two files, and preserved checkout refs. It made no model calls. Its API and Git preflight are checked independently; a complete GitHub-through-Buzz review has not yet been run. GitHub Enterprise behavior has fixture coverage, not a live Enterprise-host check. Other Buzz versions and operating systems need live compatibility validation.

## Browser, audio and package checks

Chrome was exercised through loopback and the authenticated ngrok viewer: original artwork, contact effects, demo and real replay, evidence/conversation/scope drawers, export, pause/stepping, speed and reduced motion. A 375 CSS-pixel viewport had no horizontal overflow. The viewer could read/export but could not stop the service or submit reviews.

Isolated, explicitly scripted Claude-winner, Codex-winner and draw fixtures verified both contact poses and finishers, victory/defeat endings, and HONORABLE DRAW. Web Audio entered `running` after a gesture and produced nonzero measured output; mute produced zero. This verifies a synthesized signal, not subjective speaker quality. Finishers do not alter measured health or quality.

The packed CLI has been installed and run outside its source directory with a separate data directory, serving its bundled assets and exporting the demo. Source/browser builds, types and automated tests are reproducible with the command above. [The screenshot](screenshots/arena.jpg) contains scripted demo data only.

## Permanent hosting and container verification

All 86 automated tests passed after adding permanent hosting. The supplied Dockerfile built successfully with Node 22 on Linux/ARM64. An isolated instance and an actual nginx container exercised the supplied proxy example using a temporary localhost TLS certificate, trusted explicitly by the test client. HTTPS session exchange set a Secure/HttpOnly cookie; replay and exports were readable, while public review kickoff and administrative controls were rejected. SSE arrived through nginx before the connection ended and reconnected using saved state.

Graceful container restart and abrupt termination/restart preserved the public viewer key and saved demo. Linux process-start identity checks recovered the abandoned lock despite PID reuse. Key rotation revoked an existing viewer cookie. The container's loopback health probe succeeded while the viewer bound to `0.0.0.0` internally.

Chrome also exercised the container through its configured HTTP loopback development origin: session establishment, title screen, full demo playback, artwork, reported fixture fatigue, findings drawer, sound activation/mute and the ending. The browser check caught a missing TypeScript build configuration in the initial Docker recipe; the corrected image copies it and produces the same browser bundle as the local build. These checks used isolated scripted data and made no model calls. They do not establish live Buzz/provider compatibility on Linux, public DNS/certificate automation, SSO, or production load capacity.

## Known limitations

- Live setup is verified with macOS Buzz 0.5.23; executable/profile paths may need configuration elsewhere.
- A local target-repository clone and API/Git read access are required. Teammates share the host's registered review scope.
- Snapshots are bounded and sanitized, not unrestricted repository access. Generated files, binaries, symlinks, submodules, oversized files and over-budget content are omitted. Credential detection is heuristic.
- Reviewers cannot run tests, install dependencies, edit files or invoke arbitrary shell commands. Reproduction execution requires a future isolated capability.
- GitHub REST does not provide inline thread resolution status. Historical/outdated comments are contextual material, not proof about current code. Discussion and description limits are reported in scope warnings.
- Model classification can err. Source evidence, retractions and unresolved disagreements remain accessible; agreement is not proof.
- Usage depends on installed adapters and available provider records. Missing or unreliable usage is labeled, never inferred from text length. Fatigue allowance is not a spending cap.
- Automatic provider-session recovery after a crash is not implemented. Persisted reviews replay; renewed collaboration requires a new match.
- Permanent hosting requires a dedicated origin at `/` and an external HTTPS proxy. Subpath hosting, built-in certificate management and per-user browser SSO are not included. The supplied web image needs additional Buzz/provider tooling and runtime credentials for live reviews.
