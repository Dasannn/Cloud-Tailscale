---
name: cloud-tailscale
description: Connect this cloud coding session to the user's Tailscale tailnet and reach private devices over SSH or TCP. Use when the user asks to connect to their tailnet, check its peers, or access a tailnet device.
---

<!-- cloud-tailscale:managed-skill -->

# Cloud-Tailscale

Cloud-Tailscale (`cts`, also `cloud-tailscale`) joins the user's tailnet as an
ephemeral node. It needs Linux x86_64 or arm64 and Node.js 20 or later; root
and a TUN device are optional.

## Install when missing

For Claude Code with a writable global npm prefix, the recommended
environment setup script is:

```bash
npm install -g cloud-tailscale && cts setup || true
```

This puts `cts` on PATH for the session and installs this skill. Check
`cts status` afterward: `|| true` lets the session start even if setup
fails. If the daemon did not survive setup, run `cts up` again.

Alternatively, use `npx -y cloud-tailscale setup` (or
`npx -y cloud-tailscale up` to connect only). For later commands, replace
`cts` below with `npx -y cloud-tailscale` if it is not on PATH.

With a read-only home (Codex Cloud), install once per task in `/tmp` and use
the full executable path wherever this skill says `cts`:

```bash
npm_config_cache=/tmp/npm-cache npm install --prefix /tmp/cts cloud-tailscale
/tmp/cts/node_modules/.bin/cts up
```

## Connect and reach devices

- `cts up` connects using `TS_AUTHKEY` (or `TAILSCALE_AUTHKEY`) from the
  environment. It is safe to repeat. `cts status` shows the connection,
  node IP, mode, and peers.
- `cts ssh user@host -- uname -a` runs a remote command; `cts ssh user@host`
  opens a shell when a terminal is available. Prefer `TS_SSH_KEY` or
  `TS_SSH_KEY_FILE`; otherwise use `TS_SSH_PASSWORD`. `TS_SSH_USER` supplies
  the default user. OpenSSH and `sshpass` are unnecessary.
- `cts nc host 22` opens a TCP stream through Tailscale. Use it as an
  OpenSSH ProxyCommand (`cts nc %h %p`) when needed. In userspace mode,
  ordinary tools cannot resolve MagicDNS names directly; use `cts ssh`,
  `cts nc`, or the loopback proxy described by `cts env` for tailnet requests.
  Preserve the environment's own HTTPS proxy settings.
- If the connection disappeared after setup, run `cts up` again using the
  environment's auth key. `cts down` logs out and stops the daemon.

Never ask for, accept, or paste auth keys, passwords, or private keys into
chat, command arguments, or the repository. Tell the user to configure
secrets in their cloud environment. Never print secret variables. Recommend
a reusable, ephemeral, pre-approved auth key with an ACL-restricted tag.

## Failures to explain to the user

Relay the command's reason and next step; `--json` includes stable error codes.

| Code | What the user needs to change |
| --- | --- |
| `AUTH_KEY_MISSING` | Add `TS_AUTHKEY` (or `TAILSCALE_AUTHKEY`) to the environment's secrets so it is available to the task, then run `cts up`. |
| `AUTH_KEY_REJECTED` | Replace the expired, revoked, or invalid key in secrets; check its tag and approval settings. |
| `DOWNLOAD_FAILED` | Allow `pkgs.tailscale.com` and check the egress proxy/network policy. |
| `CHECKSUM_MISMATCH` | Retry a fresh download and check the proxy; never bypass checksum verification. |
| `CONTROL_UNREACHABLE` | Allow `controlplane.tailscale.com`, `login.tailscale.com`, and `log.tailscale.com`; check proxy/CA settings and allow POST. |
| `DERP_UNREACHABLE` | Allow `derp*.tailscale.com` (or `*.tailscale.com`); direct UDP is usually blocked, so DERP is required. |
| `KERNEL_MODE_UNAVAILABLE` | Retry `cts up --mode userspace`. |
| `SSH_AUTH_FAILED` | Configure an SSH key (preferred) or `TS_SSH_PASSWORD`, and check the SSH user and peer's ACL/SSH access. |
| `HOST_KEY_CHANGED` | Stop and ask the user to verify the peer's host key; never silently remove trust records. |
| `HOME_UNAVAILABLE` | Set `CLOUD_TAILSCALE_HOME` to a private writable directory outside the project, such as `/tmp/cloud-tailscale`. |
| `SKILL_CONFLICT` | Review the existing skill file before moving or replacing it manually. |
| `SKILL_INSTALL_FAILED` | Check the skill directory's permissions; use `skill --print` with a read-only home. Reinstall the package if its shipped skill is missing. |
| `GIT_ROOT_NOT_FOUND` | Run `skill --repo` inside a Git working tree with git installed, or use `skill --print`. |
| `NOT_IMPLEMENTED` | This build lacks the requested command; use a release that includes it. |

Codex Cloud needs agent internet access enabled with the hosts above and
POST allowed, including during the agent phase.

## Make the skill available later

`cts skill --print` shows this skill. `cts skill --install` installs the
Claude Code user skill. For Codex Cloud, only when the user asks to add the
repository skill, run `cts skill --repo`: it writes only
`.agents/skills/cloud-tailscale/SKILL.md` at the Git root. Tell the user to
review and commit that file. Never add it as a side effect of connecting.
