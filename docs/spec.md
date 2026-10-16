# Cloud-Tailscale Specification

This document defines what Cloud-Tailscale v1 does. It describes behavior,
not implementation; see `ARCHITECTURE.md` for structure. It must stay
consistent with `docs/constitution.md`.

## Problem

Cloud coding agents (Claude Code on the web, Codex Cloud) run in remote,
ephemeral containers. The user's private devices, such as a Raspberry Pi at
home, are reachable only inside the user's Tailscale tailnet, and the
container is not part of it.

Joining a tailnet from such a container is not a single command:

- All outbound traffic goes through the provider's egress proxy, and direct
  UDP is blocked, so Tailscale can only connect through its DERP relays.
- The container may lack root or a TUN device (Codex Cloud), so the usual
  kernel networking mode is not always available.
- The home directory may be read-only (Codex Cloud), and nothing installed in
  one session survives into the next.
- Tailnet names such as `raspberry5` do not resolve through the container's
  DNS, and common tools (`ssh`, `sshpass`) may be missing.

## Goal

With one command, a cloud agent joins the user's tailnet as an ephemeral node
and can then reach tailnet devices by name: open SSH sessions, run remote
commands, and send other TCP traffic.

## Feasibility evidence

On 2026-10-15, inside a Claude Code on the web container, the official
Tailscale 1.104.1 static binary in userspace mode, started with only the
environment's `HTTPS_PROXY` and `SSL_CERT_FILE`, registered with the control
plane through the egress proxy, joined the owner's tailnet as an ephemeral
node, pinged `raspberry5` through DERP (about 110 ms), and received its SSH
banner through `tailscale nc`. Direct UDP was unavailable, as expected.

Codex Cloud verification on 2026-10-16 failed because its egress proxy
blocked the control protocol upgrade; the built-in VPN did not provide a
working TCP path. Codex Cloud is unsupported in v0.1.x; see
[0002](decisions/0002-codex-cloud.md).

## Users

- **User**: a person who owns a Tailscale tailnet and works with a cloud
  coding agent.
- **Agent**: the cloud coding agent that runs Cloud-Tailscale on the user's
  behalf.

## User Stories

1. As a user, I add a Tailscale auth key to my cloud environment's secrets and
   one line to its setup script, and every new Claude Code session joins my
   tailnet.
2. **Deferred (not met; see [0002](decisions/0002-codex-cloud.md)).**
   As a user of Codex Cloud, which has no setup script I can rely on, I tell
   the agent to install and run Cloud-Tailscale (or commit its skill to my
   repository once), and the task joins my tailnet.
3. As a user, I ask the agent to run a command on `raspberry5` over SSH, and
   it does so without asking me for my password in the chat.
4. As a user, I ask the agent whether it is connected and which devices it can
   reach.

## Scope (v1)

Supported platforms: Linux containers (x86_64 and arm64) with Node.js 20 or
later. The supported target is Claude Code on the web. Codex Cloud is
unsupported in v0.1.x (see [0002](decisions/0002-codex-cloud.md)). Local
Linux use is allowed but not a primary target.

### Out of scope

- Routing the container's internet traffic through an exit node.
- Accepting inbound connections into the container (Tailscale Serve, Funnel,
  or Tailscale SSH server on the container).
- Persisting Tailscale state or credentials across sessions.
- Managing the user's tailnet (ACLs, keys, devices) through the Tailscale API.
- macOS and Windows.
- An MCP server or a hosted service.

## Functional Requirements

### FR-1 Command

Cloud-Tailscale is distributed as the npm package `cloud-tailscale`, which
provides the command `cloud-tailscale`, with the alias `cts`. Every command
prints plain text written for an agent by default and accepts `--json` for a
machine-readable result with `ok`, `message`, and command data. Success exits
0; failure prints the reason and the next step to stderr and exits non-zero.

### FR-2 Portable home

Cloud-Tailscale keeps its binaries and runtime state in a private directory
(mode 0700): `CLOUD_TAILSCALE_HOME` if set, otherwise
`~/.cloud-tailscale` when the home directory is writable, otherwise
`$TMPDIR/cloud-tailscale`. It never writes into the current project, except
as described in FR-8.

### FR-3 Install

Cloud-Tailscale installs the official Tailscale static binaries for the
container's architecture into its home:

- Resolves the current stable version from Tailscale's package server, unless
  a version is pinned with `--tailscale-version` or
  `CLOUD_TAILSCALE_VERSION`.
- Downloads through the environment's proxy settings and verifies the
  tarball's SHA-256 against the published checksum before extracting. A
  mismatch is an error, and nothing is installed.
- Reuses an already installed binary of the wanted version.
- On a network failure, names the hosts that must be allowed
  (`pkgs.tailscale.com`) and suggests checking the environment's network
  policy.

### FR-4 `up`

`cloud-tailscale up [--hostname <name>] [--mode auto|kernel|userspace]
[--accept-routes]` joins the tailnet:

- Installs Tailscale if needed (FR-3).
- Reads the auth key from `TS_AUTHKEY` (or `TAILSCALE_AUTHKEY`). If none is
  set, fails with instructions for creating a reusable, ephemeral, tagged key
  and adding it to the environment's secrets. It never prompts for a key and
  never accepts one as a command-line argument.
- Passes the key to Tailscale through a private temporary file that is
  removed as soon as the join finishes, so the key never appears in process
  arguments.
- Starts `tailscaled` in the background with in-memory state, a private
  control socket, the environment's proxy and CA bundle settings, and a
  loopback-only SOCKS5 and HTTP proxy listener (default `127.0.0.1:1055`).
- Mode `auto` (the default) uses kernel networking when the process is root
  and `/dev/net/tun` is usable, and userspace networking otherwise. `kernel`
  and `userspace` force a mode; `kernel` fails clearly when unavailable.
- Uses `--hostname`, or a default derived from the host agent and a short
  random suffix (for example `claude-cloud-3f9a`).
- Waits, with a timeout, until the node is running and connected to at least
  one DERP relay, then reports the node's name, its tailnet IP, the mode, and
  how to reach peers (FR-6, FR-7).
- Is idempotent: when already connected, it reports the current state and
  exits successfully. It is suitable for a setup script.
- On failure, distinguishes at least: missing auth key, rejected or expired
  auth key, control plane unreachable through the proxy, and no DERP relay
  reachable; each with the next step.

### FR-5 `status` and `down`

- `cloud-tailscale status` reports whether Tailscale is installed, whether the
  daemon is running, the node's name, IP, mode and connection state, and the
  tailnet peers with their names, IPs, and online state.
- `cloud-tailscale down` logs the node out (removing it from the tailnet
  immediately) and stops the daemon. It succeeds when nothing is running.

### FR-6 Reaching peers

Once connected, the agent can reach tailnet peers by MagicDNS name or tailnet
IP:

- `cloud-tailscale nc <host> <port>` opens a TCP stream to a peer through the
  daemon, usable as an OpenSSH `ProxyCommand`.
- `cloud-tailscale env` prints shell `export` lines that point
  `ALL_PROXY`-aware tools at the local SOCKS5/HTTP listener for tailnet
  destinations without breaking the environment's own egress proxy.
- In kernel mode, tailnet IPs and names are reachable directly by any tool.

### FR-7 SSH

`cloud-tailscale ssh <[user@]host> [-- <command...>]` connects to a tailnet
peer over SSH without requiring OpenSSH or `sshpass` in the container:

- With a command, runs it, streams its output, and exits with the remote exit
  code. Without a command and with a terminal, opens an interactive shell.
- Authenticates with, in order: a private key from `TS_SSH_KEY` (key content)
  or `TS_SSH_KEY_FILE`, then a password from `TS_SSH_PASSWORD`. The user
  defaults to `TS_SSH_USER`, then the current user.
- Trusts a host key on first use and records it in Cloud-Tailscale's home;
  a changed host key is an error.
- `cloud-tailscale ssh-config` writes an OpenSSH `Host` entry per online peer
  (with the `ProxyCommand` from FR-6) to the user's SSH configuration when
  OpenSSH is available, so plain `ssh dasan@raspberry5` also works.
  Passwords are never written to that configuration.

### FR-8 Skill

Cloud-Tailscale ships one short agent skill, `SKILL.md`, for Claude Code on
the web. It tells the agent how to install Cloud-Tailscale when it is
missing, how to connect, check status, and use `ssh` and `nc`, and never to
ask for or paste secrets into the chat. In Codex Cloud, it tells the agent
to explain the unsupported status instead of retrying the connection.

- `cloud-tailscale skill --print` prints it.
- `cloud-tailscale skill --install` installs it where Claude Code loads user
  skills (`~/.claude/skills/cloud-tailscale/`).
- `cloud-tailscale skill --repo` writes only
  `.agents/skills/cloud-tailscale/SKILL.md` at the Git root,
  and tells the user to review and commit it.

### FR-9 Setup

`cloud-tailscale setup` is the one line for a Claude Code environment setup
script: it runs `up`, installs the skill (FR-8), and reports each step. It
does not fail the setup script when the auth key is missing; it reports it and
leaves `up` for later. Any command that needs a connection (`nc`, `ssh`,
`ssh-config`, `env`) runs `up` first if the daemon is not running and an auth
key is available, so a session still connects if a daemon started by the
setup script did not survive.

## Security Requirements

- **SR-1** Secrets are read only from the environment variables named in this
  document, never from arguments, and never printed or logged.
- **SR-2** All output passes through masking for auth keys (`tskey-…`),
  private keys, and the values of the secret variables.
- **SR-3** The daemon socket, state directory, temporary key file, and known
  hosts file are private to the user (0700 directories, 0600 files).
- **SR-4** Proxy listeners bind to loopback only.
- **SR-5** Downloaded binaries are verified by SHA-256 before use.
- **SR-6** The documentation recommends reusable, ephemeral, pre-approved,
  tagged auth keys with ACLs that limit the tag to the devices the agent
  needs, and SSH keys over passwords.

## Environment Requirements

The documentation describes the supported provider and Codex Cloud's status:

- **Claude Code on the web**: the auth key (and optional SSH secrets) as
  environment variables; setup script line `npx -y cloud-tailscale setup`;
  network access that allows `pkgs.tailscale.com`, `controlplane.tailscale.com`,
  `login.tailscale.com`, `log.tailscale.com`, and `*.tailscale.com` DERP hosts.
- **Codex Cloud**: unsupported in v0.1.x because the proxy blocks Tailscale's
  control protocol upgrade; see [0002](decisions/0002-codex-cloud.md).

## Acceptance Criteria

1. In a Claude Code on the web session with `TS_AUTHKEY` set,
   `npx -y cloud-tailscale setup` joins the tailnet, and the node appears as
   ephemeral in the admin console.
2. In that session, `cloud-tailscale ssh dasan@raspberry5 -- uname -a`
   prints the Pi's kernel version, authenticating with `TS_SSH_PASSWORD`.
3. **Deferred (not met; see [0002](decisions/0002-codex-cloud.md)).**
   The same works in a Codex Cloud task after the agent installs the package
   following the skill, without root.
4. `cloud-tailscale down` removes the node from the tailnet.
5. No secret value appears in any command output, log, process argument list,
   or file outside the private home during these runs.
6. Unit tests cover every module; lint, typecheck, and tests pass in CI.
