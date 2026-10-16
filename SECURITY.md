# Security Policy

## Supported versions

Only the latest published version on [npm](https://www.npmjs.com/package/cloud-tailscale)
is supported.

## What Cloud-Tailscale handles and what it never does

Cloud-Tailscale runs inside your container. Auth keys and SSH credentials
come only from the documented environment variables or a private key file
you provide. They are never accepted as command-line arguments, printed,
logged, or written into your repository. Auth keys reach Tailscale through
a private temporary file removed as soon as joining finishes.

Output and daemon logs mask Tailscale auth keys (`tskey-…`), private keys,
and the values of secret variables. Runtime directories are private to the
user (0700), as are the daemon socket, temporary key file, and known hosts
file (0600). Proxy listeners bind only to loopback. Official Tailscale
downloads are verified against their published SHA-256 checksums before use.

Tailscale state stays in memory, and nodes are ephemeral. Binaries and
runtime files stay outside your repository. The only repository write is
the single agent skill file, when you explicitly run `cts skill --repo`.
Cloud-Tailscale is not a hosted service and does not send your credentials
through a service of its own.

Use reusable, ephemeral, pre-approved auth keys with a dedicated tag and
ACLs limited to the devices and ports the agent needs. Prefer SSH keys to
passwords. Put secrets in your cloud environment's secrets configuration,
never in chat, command arguments, setup scripts, or repository files.
See the [security requirements](docs/spec.md#security-requirements) and
[access configuration](README.md#configure-access-once).

## In scope

Report vulnerabilities in Cloud-Tailscale's CLI, secret masking and
handling, runtime file permissions, download verification, SSH host-key
verification, and loopback proxy exposure. Dependency vulnerabilities that
affect Cloud-Tailscale are also in scope.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: Security tab →
[Report a vulnerability](https://github.com/Dasannn/Cloud-Tailscale/security/advisories/new).
Do not open a public issue. Never include real auth keys, passwords, private
keys, or other credentials in a report. Include the affected version,
environment, and steps to reproduce using dummy values and masked output.

The maintainer is a single person and replies on a best-effort basis.

## Out of scope

The security of Tailscale itself, cloud providers, and your remote devices
and SSH servers is outside Cloud-Tailscale's scope. Report vulnerabilities
in those systems to their maintainers. You control your tailnet policy,
auth keys, and authorized SSH accounts; see the
[security and limits](README.md#security-and-limits).
