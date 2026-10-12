# Contributing

Mortal Kommit is a TypeScript CLI and browser arena. Buzz owns the reviewer conversation; this application prepares source, observes messages, and presents evidence-backed combat.

## Local development

Use Node 22.13+ and npm. Live Buzz reviews are currently verified on macOS with Buzz 0.5.23; demo, core tests, and browser development do not require Buzz, GitHub, GitLab, or model credentials.

```sh
npm ci
npm run build
MORTAL_KOMMIT_DATA_DIR=/tmp/mortal-kommit-dev node dist/cli.js --demo
```

Use a dedicated data directory for development so you cannot interrupt an existing ARENA listener. Stop your development service with the same environment variable and `node dist/cli.js arena stop`.

Before submitting a change:

```sh
npm run format
npm run check
npm run release:check
```

`npm test` builds the application before running the suite: the HTTP integration tests serve the generated browser files from `dist/web`. Both `check` and `release:check` include that prerequisite, so they work from a fresh checkout without an existing `dist` directory. `release:check` also inspects package contents and high-confidence secret patterns. It does not publish anything. `scripts/model-smoke.ts` is an explicitly opt-in, billable model smoke test; it is not part of CI.

## Code map

- `src/backend/repository.ts`, `forge.ts`, `github.ts`: immutable scope and source snapshots.
- `src/backend/models.ts`: neutral preparation and independent, structured analysis.
- `src/backend/buzz.ts`, `coordinator.ts`, `membership.ts`: Buzz observation, initial kickoff, and human channel authorization.
- `src/backend/capabilities.ts`, `acp-proxy.ts`: read-only, match-scoped reviewer tools.
- `src/core/`: finding ledger, deterministic scoring, usage accounting, demo, and endings.
- `src/web/`: React controls, Canvas choreography, and original Web Audio score.
- `assets/`: replaceable sprite atlases and original stage.

Add regression tests for changes to revision selection, permissions, metering, or scoring. Use temporary repositories and synthetic identities; never use private code, real keys, production discussion, or paid model calls in tests. UI changes should be checked in a browser, including pause/replay and reduced motion.

Preserve these boundaries: both reviewers receive identical source access; the analyzer never participates in the conversation; missing usage is not zero; model agreement is not proof; presentation cannot invent findings or change the review result. A new provider must verify immutable revisions and registered repository identity before authenticated API access.

Describe the problem, resulting behavior, and verification in a pull request. Contributions are under the project's MIT license. Disclose asset provenance and any required attribution. Report security issues privately as described in [SECURITY.md](SECURITY.md).
