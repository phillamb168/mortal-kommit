# Security

This is an early release. Live integration is verified against the documented Buzz version on macOS; compatibility with another harness version must be checked before giving it private code.

## Reporting

Use the repository's **Security → Report a vulnerability** option when available. If private reporting is not enabled, open an issue asking the maintainer for a private reporting channel, without exploit details, credentials, private source, or review logs. Do not post sensitive material in a public issue.

## Boundaries

- Reviewers receive sanitized immutable snapshots through restricted read/search tools. Repository and PR/MR text is untrusted material. Review tools cannot execute code or write to the checkout.
- The host's provider credentials and Buzz identity keys stay in backend processes and private application data. GitHub/GitLab access uses existing authenticated CLI tooling.
- Current human ARENA members can request reviews for host-registered repositories. Membership in ARENA therefore grants access to review material for those repositories; register only repositories that all intended channel members may review. Bots cannot initiate reviews.
- The control server binds to loopback and authenticates connections. A configured permanent viewer can bind to another interface for reverse-proxy/container hosting; it and the optional ngrok gateway share a view-only route allowlist and use separate capabilities from local control. Proxy only the viewer port. HTTPS terminates at your trusted proxy; the app validates the configured public Host/Origin and does not trust forwarded headers to override them.
- Shared viewer links permit reading/exporting all stored review material on the instance. Treat links and startup logs as secrets. Permanent viewer credentials persist in private `viewer-key.json`; `mortal-kommit viewer rotate-key` invalidates them and disconnects active viewer streams. Removing Buzz membership does not revoke a copied link. Per-user browser SSO is not included.
- Replay uses saved records, without new model calls. Preparation and analysis usage are separate from fighter totals. A token allowance controls fatigue, not billing or a spending limit.

Credential filtering is heuristic, not a complete secret scanner. Review the repository and access scope before use. Dependencies, model providers, the Buzz relay, and the operating system remain trusted components. Backups and exported reviews can contain private code and conversation; keep them out of the source repository and public release artifacts.

Only the latest release receives fixes. Supported configurations and known limitations are in [verification](docs/verification.md).
