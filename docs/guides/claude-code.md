# Claude Code on the web

Cloud-Tailscale connects a Linux cloud session to your own tailnet without
root. Node.js 20 or later and x86_64 or arm64 are required.

## Configure credentials

In the Tailscale admin console, create an auth key with **Reusable**,
**Ephemeral**, and **Pre-approved** enabled. Assign a dedicated tag such as
`tag:cloud-agent`. Restrict that tag's ACLs to the devices and ports the
agent needs, for example SSH on your Raspberry Pi; avoid granting the tag
access to your entire tailnet. Configure the tag's ownership in your tailnet
policy before generating the key.

Add credentials to the Claude Code environment's secrets, never the
repository, setup script, or chat:

| Variable | Purpose |
| --- | --- |
| `TS_AUTHKEY` | Tailscale auth key; `TAILSCALE_AUTHKEY` is a fallback. |
| `TS_SSH_USER` | Optional default SSH user. |
| `TS_SSH_KEY` | Optional SSH private key content; preferred over passwords. |
| `TS_SSH_KEY_FILE` | Alternative path to a private key you provide outside the project. |
| `TS_SSH_PASSWORD` | Optional password when no SSH key is available. |

Use a separate SSH key for the agent and authorize its public key on the
target device. The SSH account and tailnet ACLs both need to permit access.
Cloud-Tailscale does not configure the remote SSH server or your tailnet
policy.

## Allow network access

Allow outbound HTTPS to:

- `pkgs.tailscale.com` for official binary downloads and checksums.
- `controlplane.tailscale.com` and `login.tailscale.com` for joining.
- `log.tailscale.com` for the official client's logging service.
- `derp*.tailscale.com`, or `*.tailscale.com`, for DERP relays.

Allow GET for downloads and POST for control-plane operations; do not use a
policy restricted to read-only HTTP methods. Package installation also
needs the npm registry (`registry.npmjs.org`). Preserve the provider's
`HTTPS_PROXY`, `NO_PROXY`, and CA bundle settings. Direct UDP is commonly
blocked; DERP carries the tailnet connection through the egress proxy.

## Set the setup script

Add this exact line to the Claude Code environment's setup script:

```bash
npx -y cloud-tailscale setup
```

Setup runs `up`, installs the skill into
`~/.claude/skills/cloud-tailscale/SKILL.md` on a Claude Code host, and reports
both steps. A missing auth key defers the connection and exits successfully
if skill installation succeeds. Configure the secret, then have the agent
run `cts up` later. Other failures are reported with a nonzero exit status.

The skill contains the install commands if `cts` is not on PATH. Have the
agent check the connection and run a command on a peer:

```bash
npx -y cloud-tailscale status
npx -y cloud-tailscale ssh dasan@raspberry5 -- uname -a
```

If the daemon did not survive setup, run `npx -y cloud-tailscale up` again.
The node's state stays in memory. Run `npx -y cloud-tailscale down` to log out
and stop it immediately. See [troubleshooting](troubleshooting.md) for error
codes and recovery steps.
