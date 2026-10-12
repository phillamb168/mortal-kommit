# Configuration and troubleshooting

Configuration is strict JSON at `~/.local/share/mortal-kommit/config.json`, or `config.json` under `MORTAL_KOMMIT_DATA_DIR` when set. Missing top-level fields use defaults. A minimal example:

```json
{
  "version": 1,
  "relay": "wss://your-community.communities.buzz.xyz",
  "allowance": { "claude": 100000, "codex": 80000 },
  "weight": 30,
  "repos": { "api": "/absolute/path/to/api" },
  "models": {},
  "assetsDir": null
}
```

Let any active review finish, then restart the arena service after editing configuration. `arena setup` fills `channelId`, `ownerPubkey`, and `fighters`; keep those generated fields when editing an existing file. `fighters` contains the dedicated pair's Buzz public identity keys, not model IDs or selectors for existing personal agents. `repo add` preserves the rest of the configuration.

| Field                                                   | Meaning                                                                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay`                                                 | Exact community WebSocket URL. Default uses `BUZZ_RELAY_URL`, then the unique nonempty relay in existing macOS Buzz managed-agent metadata, otherwise localhost:3000. |
| `profiles.codexHome`                                    | Existing Codex authentication directory. Defaults to `~/.codex-work` if present, otherwise `~/.codex`.                                                                |
| `profiles.claudeConfig`                                 | Existing Claude authentication directory. Defaults to `~/.claude-work` if present, otherwise `~/.claude`.                                                             |
| `executables.buzz`                                      | Defaults to `buzz` from PATH.                                                                                                                                         |
| `executables.harness`                                   | Defaults to `/Applications/Buzz.app/Contents/MacOS/buzz-acp`.                                                                                                         |
| `executables.codex`                                     | Defaults to `codex` from PATH.                                                                                                                                        |
| `executables.claudeAdapter`, `executables.codexAdapter` | Paths to installed Buzz ACP adapter entrypoints. See the defaults in `src/backend/config.ts`.                                                                         |
| `models.claude`, `models.codex`                         | Optional model IDs for the Claude and Codex reviewer adapters, respectively. Passed to each reviewer harness as `--model`.                                            |
| `models.analysis`                                       | Optional Codex model ID for neutral scouting and independent analysis.                                                                                                |
| `allowance`                                             | Positive integer tokens per fighter. `--token-budget` overrides both for one match.                                                                                   |
| `weight`                                                | Maximum token fatigue damage, 0–100; default 30.                                                                                                                      |
| `viewer`                                                | Optional permanent viewer settings: `publicUrl` (HTTPS origin), `host` (default `127.0.0.1`), `port` (default `8787`). Null disables the listener.                    |
| `assetsDir`                                             | Absolute path to a complete replacement sprite/stage pack, or null for bundled assets.                                                                                |

When setting `profiles`, `executables`, or `allowance`, include all required members of that object. Never place model credentials or Buzz keys in this JSON. Pair identity keys and runtime capability credentials are written to application-owned files with mode 0600 under a private data directory.

## Host tooling and authentication paths

The live pair is fixed to Claude and Codex. `arena setup` creates/reuses Mortal Kommit's own **ArenaClaude** and **ArenaCodex** identities; it does not select agents already listed in your personal Buzz setup. Provider logins can be reused, while review permissions and sessions are configured separately.

The ARENA host needs the Buzz CLI, `buzz-acp`, both ACP adapters, authenticated Claude/Codex provider tooling, and the Codex CLI for scouting and analysis. These dependencies are not bundled in the Mortal Kommit package. A separate relay server only needs its own Buzz relay deployment; it does not need this reviewer harness. Teammates need access to Buzz and the browser viewer. See [team deployment](deployment.md).

For a non-default installation, merge the following objects into the existing host configuration. Replace `/absolute/path/...` with actual absolute paths; JSON values do not expand `~`, `$HOME`, or shell expressions. Include all members of each object:

```json
{
  "profiles": {
    "claudeConfig": "/absolute/path/to/claude-auth-directory",
    "codexHome": "/absolute/path/to/codex-auth-directory"
  },
  "executables": {
    "buzz": "buzz",
    "harness": "/absolute/path/to/buzz-acp",
    "codex": "codex",
    "claudeAdapter": "/absolute/path/to/claude-agent-acp/dist/index.js",
    "codexAdapter": "/absolute/path/to/codex-acp/dist/index.js"
  }
}
```

Adapter paths must point to the installed JavaScript entrypoints, which Mortal Kommit launches using its Node runtime. On the verified macOS installation, the harness is `/Applications/Buzz.app/Contents/MacOS/buzz-acp` and the adapters are under `~/Library/Application Support/Buzz/node-tools/lib/node_modules/@agentclientprotocol/`. If you use a different installation, inspect its paths and interfaces rather than assuming these defaults apply.

Authenticate the provider tools using their supported login mechanism in the selected profile directories. A working personal agent is only sufficient if Mortal Kommit can use the same authentication from its host account. It does not import that agent's model selection, tools, hooks, or permissions. Run `mortal-kommit doctor` as the same operating-system user and with the same environment that will start the listener. This checks CLI availability, adapter files, and provider login status; it does not prove relay admission, model entitlement, or compatibility with every adapter version.

## Choosing models

The host administrator selects models in `config.json`:

```json
{
  "models": {
    "claude": "YOUR_CLAUDE_MODEL_ID",
    "codex": "YOUR_CODEX_MODEL_ID",
    "analysis": "YOUR_CODEX_ANALYSIS_MODEL_ID"
  }
}
```

Replace these placeholders with supported IDs, or omit the entries you do not want to override. `models.claude` selects the Claude fighter and `models.codex` selects the Codex fighter. `models.analysis` selects the Codex CLI model for **both** neutral preparation and structured conversation analysis; those sessions do not participate in Buzz's review conversation and their usage is counted separately from the fighters.

The inspected harness supports `buzz-acp models` to query an adapter's available IDs without configuring a Buzz relay or identity key. Check your installed version first:

```sh
/Applications/Buzz.app/Contents/MacOS/buzz-acp models --help
```

For each adapter, substitute the configured `executables.harness`, adapter entrypoint, and authentication profile paths. For example, the Claude query is:

```sh
CLAUDE_CONFIG_DIR='/absolute/path/to/claude-auth-directory' \
  /absolute/path/to/buzz-acp models \
  --agent-command node \
  --agent-args '/absolute/path/to/claude-agent-acp/dist/index.js' \
  --json
```

The Codex query uses its own profile and adapter:

```sh
CODEX_HOME='/absolute/path/to/codex-auth-directory' \
  /absolute/path/to/buzz-acp models \
  --agent-command node \
  --agent-args '/absolute/path/to/codex-acp/dist/index.js' \
  --json
```

Quote executable paths containing spaces. These are adapter-discovery commands, not manual launches of ARENA reviewers. Use IDs accepted by the installed provider and your account; a displayed model can still be subject to account access restrictions. The analysis model must also be accepted by the configured Codex CLI.

With `"models": {}`, Mortal Kommit passes no explicit model flag. Selection is left to the harness/adapter or Codex CLI defaults, including applicable host environment settings; personal Buzz agent model choices are not imported. The scouting/analysis invocation ignores Codex user configuration, and the Codex fighter uses an isolated profile linked to the selected authentication file. Set explicit model IDs when you want predictable selection instead of assuming your usual personal defaults carry over.

Model settings apply to subsequent reviews after restarting the listener. There are no `--model` options on Mortal Kommit's CLI or `!review` command. Changing `models` cannot replace a provider, add a third fighter, or connect an existing arbitrary Buzz agent. Let the current review finish before restarting; stopping the service interrupts its running reviewer processes.

## Permanent viewer configuration

```json
{
  "viewer": {
    "publicUrl": "https://arena.example.com",
    "host": "127.0.0.1",
    "port": 8787
  }
}
```

`publicUrl` is the browser-facing origin; `host` and `port` specify the app's separate HTTP viewer listener. The listener starts with `arena start` and stops with the service. Keep it on loopback for a proxy on the same machine, or explicitly use `0.0.0.0` inside a container. Expose only that viewer port. `--port` on foreground `arena start` configures the private **control** listener, not the viewer.

Environment variables override JSON when set:

| Variable                    | Overrides          |
| --------------------------- | ------------------ |
| `MORTAL_KOMMIT_PUBLIC_URL`  | `viewer.publicUrl` |
| `MORTAL_KOMMIT_VIEWER_HOST` | `viewer.host`      |
| `MORTAL_KOMMIT_VIEWER_PORT` | `viewer.port`      |

A public URL is required when any viewer environment setting is present. Empty/invalid values fail startup. URLs must use HTTPS and have no credentials, subpath, query or fragment. HTTP is accepted only for `localhost`, `127.0.0.1`, or `[::1]` development origins. Serve the application at a dedicated hostname's root; `/arena/` hosting is not supported. Ports range from 0 to 65535; use a fixed nonzero port in deployments (0 requests an ephemeral port for testing). Bind addresses must be IP literals or `localhost`.

The public origin controls generated links, accepted Host/Origin values, and Secure cookies. It does not configure DNS or TLS. Preserve the public Host header through the proxy; `Forwarded` and `X-Forwarded-*` headers do not override validation. See the [proxy and container instructions](deployment.md#permanent-hosting).

`mortal-kommit viewer url` prints the configured authenticated link. Its key is stored privately in `viewer-key.json` under the data directory and survives restarts. `mortal-kommit viewer rotate-key` rotates it, disconnects active viewer streams, and prints a new link; new Buzz messages use the new key. Existing messages retain old links. These commands require local service access. The key authorizes viewing/export of all stored matches on that instance, not review kickoff or administration.

To disable permanent hosting, set `viewer` to null, unset the three viewer environment variables, and restart. A configured permanent viewer takes precedence over any stale tunnel metadata. `tunnel` refuses to start while permanent hosting is configured; stop an existing tunnel explicitly before switching. Ngrok and permanent hosting use the same view-only route enforcement but separate keys.

## Common problems

**Who can request a review?** Any current human member of ARENA, including owners, admins, members, and guests. The host's owner key remains backend-only. Bots are excluded using channel role, profile `bot` metadata, delegated NIP-OA identity tags, and the configured fighter identities. Teammates can use only host-registered repository aliases or matching GitHub PRs / GitLab MRs. No per-person allowlist is required.

**A teammate's request did not start.** Post `!review` as a new topic, not inside another review thread. Confirm membership and the account's bot/agent classification. If the membership or identity lookup is unavailable or malformed, no review is queued; `arena status` reports the lookup warning. Repost once the relay is available. Reconnect delivery can retry a lookup failure, but accepted/rejected commands are deduplicated. A member removed while their request waits in the queue cannot start a new match from that queued request. This does not cancel an already-running review.

**The shared link opens localhost.** Configure the permanent viewer and restart the host, or run `mortal-kommit tunnel` before requesting a review. New acknowledgements and kickoff messages use the resulting public URL. Existing Buzz messages retain the URL they originally contained. The local and public shared links are view-only; service stop and local review API access are not granted to channel members.

**Shared relay, corporate VPN, or server deployment.** The `relay` field configures Buzz's community endpoint, not the arena website. Run one persistent Mortal Kommit host with the registered clones and provider integrations; teammates use Buzz and their browsers. The host may share the relay's machine if its dependencies are available. Configure `viewer.publicUrl` and proxy its viewer port for a stable VPN/internet address, or use `mortal-kommit tunnel` for a temporary preview. Per-user browser SSO is not built in; a deployment can add an access gateway. See [team deployment](deployment.md) for setup, nginx/container examples and access boundaries.

**“Owner credential required.”** Set `MORTAL_KOMMIT_OWNER_KEY` in the environment that launches the daemon. Use the identity that owns the arena agents and has permission to create/manage ARENA, not the relay server's signing key. `doctor` reports presence, not the key itself or successful relay authorization. The application does not extract credentials from Buzz's UI or Keychain.

**Setup says “auth-required: not authenticated.”** The corrected setup waits for Buzz's positive NIP-42 authentication acknowledgement before publishing, and publishes each agent profile through a connection authenticated as that agent with its owner grant. Earlier builds published too early and used the owner's connection for agent-authored profiles. Install the corrected package, stop the service, and rerun `arena setup` in the terminal containing your owner key. Retrying preserves the stored pair and reuses ARENA. Genuine authentication denials now report `Buzz authentication rejected` with the relay's reason; a missing acknowledgement reports an authentication timeout.

**Models are signed in but ARENA is unavailable.** Provider login and Buzz owner authorization are separate. Confirm the relay URL and owner key, stop the service, run `arena setup`, then restart. `arena status` shows relay warnings. Do not change existing agents to fix the dedicated pair.

**No upstream / diverged / stale information / empty range.** Default mode deliberately does not guess the whole branch. Inspect your Git history and give an explicit `--base <ref>` for the desired comparison. A published branch with no new commits is an empty review.

**GitHub authentication and source access.** Install `gh`, run `gh auth login --hostname github.com` (or your Enterprise hostname), and verify `gh auth status --hostname <host>`. Register a local clone whose origin matches the PR’s **target** repository. Git fetch authentication is separate from API access. Fork PRs use the target repository’s PR head ref; the fork does not need to be cloned or registered. The integration only makes GET API requests and Git fetches; it does not post reviews, approve, merge, or modify PRs.

A fine-grained token for a private target repository needs Contents read (Git fetch), Pull requests read (PR/review comments), and Issues read (conversation comments); your organization may require SSO authorization. An existing authenticated user or team service account can host ARENA. Keep tokens in `gh`’s credential store or its documented environment variables. They never belong in Mortal Kommit JSON, channel messages, or browser URLs. See [GitHub CLI authentication](https://cli.github.com/manual/gh_auth_login).

**PR errors or incomplete discussion.** `--pr` accepts HTTPS `/owner/repo/pull/number` URLs; copy the main PR URL, not `/files`. Custom Enterprise hosts work with matching `gh` authentication and origin. Arbitrary SSH aliases are not guessed. Force-push, target advance, and retarget races fail with a retry message. Ambiguous merge bases and empty comparisons fail explicitly. A merged PR may have no remaining range. Conversation, review summaries, and inline comments each cap at 10 pages; their shared budget is 64,000 bytes, and description is capped at 32,000 bytes. Outdated inline comments are labeled; REST does not expose thread resolution status. API permission/rate-limit failures stop preparation rather than silently presenting complete context.

**GitLab authentication.** Authenticate your installed `glab` for the MR's hostname and ensure normal Git fetch access works. The MR target project must match the current or registered repository's origin. Rebase/force-push races require retrying so the packet remains immutable. MR discussion collection is capped and omissions are recorded.

**GitLab uses a separate SSH hostname.** Mortal Kommit reads `glab config get ssh_host --host <MR-hostname> --global` when the origin host differs. The configured alternate host is accepted for SSH remotes only, with the exact project path and port. It is not guessed from naming conventions or taken from repository-local configuration. Verify the setting with that command and authenticate `glab` against the web/API hostname as usual; Git fetches retain the existing origin and SSH credentials.

**Usage unavailable.** Confirm the installed Mortal Kommit is current: earlier wrappers hid the adapter name from Buzz and disabled its standard NIP-AM path. Current wrappers retain adapter identity and persist completed-turn usage locally. Codex also uses provider records inside its isolated review home because the installed ACP adapter reports only its last model response. No context-window occupancy is charged as spending. The installed adapter/relay may not emit NIP-AM, the owner may lack read authorization, a metric may lack a reliable token total, or its session may not be attributable to this review. No estimate from message length is substituted. Late valid metrics update fatigue. A missing cumulative baseline or reset is omitted rather than treated as spending since zero.

**Review waiting.** Inactivity is not completion. Inspect the conversation and provider/relay error. Both reviewers must publish final reports and become idle. If the service was stopped or crashed, its saved evidence remains available; automatic provider-session restoration is not implemented. Start a new review to restart collaboration safely. Do not resume by manually forwarding messages between agents.

**No sound.** Press ENTER ARENA, unmute, and check both mixer sliders and system sound. Browser autoplay restrictions require a user gesture. Endings resolve to silence; REPLAY starts another battle. Browser background throttling can reduce animation cadence.

**Permanent viewer returns 403 or does not update.** Match `viewer.publicUrl` to the browser origin exactly, including a nonstandard port. Preserve Host at the proxy, disable response buffering/caching for live events, and use HTTPS so the session cookie is sent. `/healthz` is an unauthenticated readiness check and does not grant access to reviews. A bind error fails service startup; fix the occupied port or host before retrying. The listener cannot serve certificates or a subpath.

**ngrok fails.** Confirm `ngrok version` and your existing ngrok authentication. Run `mortal-kommit tunnel stop` then `mortal-kommit tunnel`. A free-plan interstitial may appear before the app. If the local service is unavailable, restart `arena start --background`; the gateway reads its updated address automatically. The tunnel is a viewer and cannot start or stop reviews.

**Port or another service owns the directory.** Only one daemon may use a data directory. Use `arena status` and `arena stop`, or give a separate `MORTAL_KOMMIT_DATA_DIR` for isolated testing. An abandoned lock with a dead PID is recovered on startup. Node 22 may print an experimental SQLite warning; it does not prevent operation.

**Different operating system/Buzz version.** CLI, pure battle logic, and browser code are portable, but automatic adapter-path discovery and process isolation have been verified on macOS only. Configure executable paths and audit the installed harness interfaces before using other versions. Unknown capabilities should fail closed, not be guessed.
