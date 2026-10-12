# Team deployment

Mortal Kommit connects to an existing Buzz community. It is not a relay plugin or a static website: its host runs source preparation, the restricted Buzz reviewer harnesses, observation, usage accounting, storage, and the arena server. Buzz remains responsible for agent dispatch and the conversation.

## Where each component runs

| Component      | Where it runs                                 | What it needs                                                                                                                                         |
| -------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buzz relay     | A team-reachable server                       | Its own Buzz deployment, community membership and channels.                                                                                           |
| Teammates      | Their own computers                           | Buzz connected to the shared community, human membership in ARENA, and a browser that can reach the arena viewer.                                     |
| ARENA host     | One persistent machine                        | Mortal Kommit, Node, Git, the supported Buzz CLI/harness and Claude/Codex adapters, provider authentication, and registered target-repository clones. |
| Viewer gateway | Alongside the ARENA host in the current build | Built-in HTTP viewer behind your HTTPS proxy, or optional ngrok for previews. Only viewing/export routes reach the local service.                     |

The relay and ARENA host can share a machine if all dependencies are available. They do not have to. A separate compatible ARENA host can use a relay already running in your server environment. Live operation is verified on macOS with Buzz 0.5.23; the relay's own Linux support does not establish that Mortal Kommit's installed provider adapters have been validated there.

**`buzz-acp` is required on the ARENA host, not on a separate relay server or each teammate's machine.** Mortal Kommit launches its dedicated ArenaClaude/ArenaCodex pair through this harness. The current release requires both Claude and Codex integrations; it does not automatically select a teammate's existing Buzz agents. The host administrator chooses the models for these two reviewers and the separate scout/analyzer using the [model configuration](configuration.md#choosing-models).

For the relay itself, follow [Buzz's self-hosting documentation](https://github.com/block/buzz/blob/desktop-v0.5.23/README.md) and its [production Compose deployment guide](https://github.com/block/buzz/blob/desktop-v0.5.23/deploy/compose/README.md). Those are relay instructions, not an installation recipe for Mortal Kommit's reviewer host.

## Set up a fresh shared host

1. Connect the team's Buzz clients to the intended community. The host's Buzz owner identity must be admitted there and permitted to manage the private ARENA channel and its pair of agents.
2. Install Mortal Kommit and its required Buzz/provider tooling on the host. Configure `profiles` and `executables` for the authentication directories and installed adapters on that machine, and `models` for any explicit model choices; see [host tooling and authentication paths](configuration.md#host-tooling-and-authentication-paths). Run `mortal-kommit doctor` to check the installation. Provider login status does not guarantee access to a particular model.
3. Before first setup, run `export BUZZ_RELAY_URL='wss://buzz.example.com'`, replacing the example with the team's relay URL. Alternatively, set the `relay` field in the host's Mortal Kommit `config.json`. An existing explicit `relay` value takes precedence over the environment-derived default.
4. Supply `MORTAL_KOMMIT_OWNER_KEY` through the host's secure runtime environment. This is the authorized user's Buzz identity key, not the relay server's signing key. Keep provider and Git credentials on the host as well.
5. Run `mortal-kommit arena setup`. Clone and register each target repository using the [GitHub/GitLab README instructions](../README.md#register-repositories-on-the-arena-host).
6. Choose permanent hosting below, or use ngrok for a temporary preview in the same host account and data-directory environment:

```sh
mortal-kommit arena start --background
mortal-kommit tunnel
```

Start the tunnel before submitting a review so new thread messages contain its reachable viewer link. Existing messages keep the URL they originally contained. All human members of the private ARENA channel can submit supported `!review` commands for registered repositories; one match runs at a time for the configured pair.

Keep the host awake and the listener, reviewer processes and tunnel available. `--background` detaches the service; it does not install an operating-system service, arrange startup after reboot, or prevent the host from sleeping. A managed always-on host should provide its own service supervision and secure credential injection.

## Relay URL versus arena URL

The relay's WebSocket/HTTP endpoint carries Buzz traffic. The browser connects separately to Mortal Kommit for the arcade, evidence, usage, replay and exports. These endpoints can use different domains and machines. Neither a relay URL nor a channel invitation publishes the arena website.

The arena control service binds to `127.0.0.1` and validates Host and Origin. Both permanent hosting and ngrok use the same viewer gateway, with a separate credential and an explicit route allowlist. It can view/export, but cannot submit reviews or stop the service. The permanent viewer starts and stops with the ARENA process. The optional ngrok gateway follows local service restarts automatically.

The browser URL is chosen from the configured permanent viewer, otherwise a running ngrok tunnel, otherwise the local viewer. Moving to a persistent host changes availability, not the team's review workflow. Existing Buzz messages keep their original URLs.

## Permanent hosting

Mortal Kommit behaves like a Node web application behind a reverse proxy. There are three distinct pieces:

1. **DNS** maps your chosen hostname to the machine or load balancer receiving browser traffic.
2. **Your HTTPS proxy** (nginx, Apache, an ingress controller, or an equivalent gateway) accepts that hostname, manages certificates, and forwards HTTP to Mortal Kommit's viewer port.
3. **Mortal Kommit** serves the browser app, assets, live event stream, saved reviews and exports on that port. The advertised URL tells it which browser origin to accept and put in Buzz messages.

DNS, certificate issuance/renewal, proxy installation and corporate access policy are deployment responsibilities. The repository provides the app listener, configuration, a proxy example and a container build. Setting a URL alone does not create DNS, obtain a certificate or open a firewall.

### Configure and start

Merge into the host's existing `config.json`:

```json
{
  "viewer": {
    "publicUrl": "https://arena.example.com",
    "host": "127.0.0.1",
    "port": 8787
  }
}
```

Replace the hostname with your chosen address. Stop an existing ngrok tunnel when switching modes. Let any active review finish before restarting the service to apply configuration.

```sh
mortal-kommit arena start
```

Run this foreground process under your service manager. It starts the private control listener and the configured viewer listener together, and prints their addresses. `--background` remains available for desktop use; omit it for containers and service supervisors. SIGTERM/SIGINT closes listeners, streams and application-owned reviewer processes. The owner key, provider authentication and registered clones are still required for live reviews.

```sh
mortal-kommit arena status
mortal-kommit viewer url
```

Status shows the public origin and actual viewer bind address. `viewer url` prints the authenticated link to open or share. CLI review/demo/replay links and new Buzz messages use that address. The URL fragment contains a viewing capability; keep links and startup logs private.

Supported public URLs are HTTPS origins, optionally with a port, without credentials, query, fragment or subpath. Host at the domain root, such as `https://arena.example.com/`, not `https://example.com/arena/`. HTTP loopback origins are supported for local development only. A private VPN deployment can use an internal hostname and trusted HTTPS certificate with the same configuration.

### Reverse proxy

The [nginx example](deploy/nginx.conf.example) is intended for nginx on the same host as the viewer. Set its `server_name` and certificate paths, route traffic to port 8787, and check your nginx configuration before reloading. Preserve the browser's **Host header**, including a nonstandard port. Do not proxy to the private control listener printed by the CLI.

Live updates use server-sent events, not WebSockets. Disable response buffering and caching, and allow long-lived responses. The gateway also sends `X-Accel-Buffering: no` and a heartbeat arrives every 15 seconds. The example follows nginx's documented [Host forwarding](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header), [buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering), and [read timeout](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout) behavior.

The gateway validates Host and Origin against `viewer.publicUrl`; it does not trust `Forwarded` or `X-Forwarded-*` to override them. TLS terminates at the proxy; the app's viewer listener itself speaks HTTP. Keep that HTTP hop on loopback or a trusted private network. For an internet deployment, your access gateway can require team login in addition to the viewer link. Mortal Kommit does not provide per-user website SSO.

`GET /healthz` on the viewer is an unauthenticated readiness check. It returns only `{ "ok": true }` when the gateway can reach the local arena, or HTTP 503 when unavailable. Local probes can use the loopback address; proxy probes can preserve the public Host. It reports web readiness, not Buzz/provider authentication or review success.

### Container build and runtime

From the source checkout:

```sh
docker build -f docs/deploy/Dockerfile -t mortal-kommit:local .
docker run -d --init --name mortal-kommit --restart unless-stopped \
  -e MORTAL_KOMMIT_PUBLIC_URL=https://arena.example.com \
  -p 127.0.0.1:8787:8787 \
  -v mortal-kommit-data:/home/node/.local/share/mortal-kommit \
  mortal-kommit:local
```

The image runs as the non-root `node` user, starts `arena start` in the foreground, and sets `MORTAL_KOMMIT_VIEWER_HOST=0.0.0.0` and `MORTAL_KOMMIT_VIEWER_PORT=8787`. Publishing it to host loopback lets a host nginx reach the viewer. For a proxy in another container, put them on a private Docker network and use `http://mortal-kommit:8787` as its upstream; no host port publication is needed. Only the viewer binds externally inside the container; the control listener remains container-local.

`MORTAL_KOMMIT_PUBLIC_URL`, `MORTAL_KOMMIT_VIEWER_HOST`, and `MORTAL_KOMMIT_VIEWER_PORT` override JSON. Keep the configured listening port, container publication and proxy upstream consistent. A public URL must be supplied; invalid configuration fails startup. The built-in health check probes the viewer port.

Persist the data volume: it holds configuration, the permanent viewer key, SQLite, snapshots, exports and review history. Recreating the container with the same volume preserves links and replay. A bind-mounted replacement must be writable by the container user (UID 1000 in this image). Keep one active ARENA process per data directory. Use normal graceful shutdown; interrupted review sessions are not automatically resumed after a crash.

The supplied image includes the **web/demo runtime and Git**. It does not bundle Buzz, Claude/Codex provider tools/adapters, `gh`, `glab`, or their credentials. For a live-review image, extend it with compatible Linux tooling, configure executable/profile paths inside the image, securely provide runtime credentials and mount registered repository clones. Run `mortal-kommit doctor` in that environment. A working web container is not proof of Linux Buzz reviewer compatibility; live reviews remain verified on macOS with Buzz 0.5.23. Credentials should be runtime secrets or private mounts, never Docker build arguments or image layers.

You can verify the web runtime without provider credentials by creating the explicitly labeled demo:

```sh
docker exec mortal-kommit mortal-kommit --demo --no-open
docker exec mortal-kommit mortal-kommit viewer url
```

Open the printed viewer link through your configured proxy. Without DNS/TLS, a local-only smoke check can instead use `MORTAL_KOMMIT_PUBLIC_URL=http://localhost:8787` and open the published loopback port directly. Replays and exports use saved data without model calls.

## Team access and data ownership

ARENA membership controls review kickoff. Viewer-link possession controls browser access; the current viewer credential covers stored reviews on that instance, not just the match named in a URL. Register only repositories that the intended channel members and viewers may review. Use separate instances, data directories and configured channels where teams need separate access boundaries.

Removing a member from Buzz does not revoke a copied viewer link. For permanent hosting, run `mortal-kommit viewer rotate-key` locally (or through `docker exec`) to revoke old links and disconnect active viewer streams; redistribute the new link to remaining viewers. The key normally survives restarts in private `viewer-key.json`. For ngrok, stop and restart the tunnel to rotate its separate key. An old link embedded in a past message then requires the new credential. There is no per-user website revocation or audit of individual viewers in this release.

The relay retains Buzz history, while Mortal Kommit stores its own database, snapshots, packets, events and usage under `MORTAL_KOMMIT_DATA_DIR` (default `~/.local/share/mortal-kommit`). Relay backups alone do not back up the arcade. Treat host data and exported reviews as private source material. Reviewer credentials stay on the host; teammates do not need them to request or watch a review.

When moving to a different relay community, use a fresh data directory and run setup for an identity admitted to that community. Existing channel IDs and identity grants are community-specific; changing a hostname in an existing configuration is not a migration procedure. When moving the same instance between machines, preserve its private data securely, update local repository/profile/executable paths, and run only one active listener for that pair.
