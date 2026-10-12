# Preparing a release

The intended repository is `phillamb168/mortal-kommit`. Repository creation, pushes, tags, GitHub releases, and npm publishing are manual maintainer actions. The local preparation commands below do not perform them.

1. Use a clean source checkout, Node 22.13+ and `npm ci`.
2. Run `npm run release:check`. Review the package inventory, test results, and `npm audit --omit=dev` output.
3. Run `npm pack` and install the resulting archive in a temporary prefix. From another directory, verify `mortal-kommit --help`, `--demo --no-open`, replay, assets, and export with a separate `MORTAL_KOMMIT_DATA_DIR`.
4. In a browser, check ordinary contact, both finishers, a draw, source evidence, replay, audio controls and reduced motion. No model calls are needed for the demo.
5. Update version, changelog, and verification notes. Keep runtime credentials, databases, snapshots, provider transcripts, private review exports, tunnel links, and `.firecrawl/` out of Git and the package. The bundled screenshots must show scripted demo data only.
6. Inspect `git status` and the staged diff before committing or pushing. Enable private vulnerability reporting on the new GitHub repository. Confirm the repository URL and package-name availability before publishing.

The npm package uses an explicit file allowlist: built application, original assets, public documentation, and license notices. CI checks the source, tests, assets and package inventory on macOS and Linux; live Buzz integration is not exercised in CI. No credentials or publication tokens are required by CI.

`scripts/release-check.mjs` checks high-confidence credential patterns and accidentally included local state. It is a useful gate, not a guarantee that every possible secret or confidential phrase has been recognized. Keep private runtime data outside this source tree and review the actual staged content.

## Integration references

- [GitHub CLI authenticated API requests](https://cli.github.com/manual/gh_api)
- [GitHub pull-request metadata](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)
- [GitHub PR head refs, including forks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/checking-out-pull-requests-locally)
- [GitHub review comments](https://docs.github.com/en/rest/pulls/comments#list-review-comments-on-a-pull-request)
- [GitHub review summaries](https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request)
- [GitHub conversation comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments)

The implementation uses documented REST resources through `gh api`, and verifies Git objects locally. It never uses an LLM to invent provider endpoints or select a revision.
