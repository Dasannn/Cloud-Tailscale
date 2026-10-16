# Codex Cloud

Install and connect within the task; do not rely on a setup script or a
previous session's daemon. Cloud-Tailscale supports Linux x86_64 and arm64
with Node.js 20 or later, including containers without root or a TUN device.

## Configure credentials and networking

Configure `TS_AUTHKEY` (or `TAILSCALE_AUTHKEY`), optional `TS_SSH_USER`, and
`TS_SSH_KEY` or `TS_SSH_KEY_FILE` under the Codex environment's **Environment
variables**. Prefer a dedicated SSH key over `TS_SSH_PASSWORD`. For
`TS_SSH_KEY_FILE`, the variable points to a private key file available in
the task. See the [credential variables](claude-code.md#configure-credentials).

Codex **network secrets** give programs placeholders. The proxy substitutes
the real values only in HTTPS requests on port 443 to allowed domains;
programs do not receive the raw credentials. See the
[official environment documentation](https://learn.chatgpt.com/docs/environments/cloud-environments#configure-environment-variables-and-network-secrets).
Tailscale's encrypted control protocol and SSH cannot use this substitution,
so `TS_AUTHKEY` and SSH credentials must be environment variables that the
programs can read directly.

Use a dedicated, short-lived, ephemeral, pre-approved auth key with an
ACL-restricted tag such as `tag:cloud-agent`. Ensure the variables are
available when the agent runs `cts up` and SSH; setup-only credentials do
not enable a later reconnect. Never paste credentials into chat, arguments,
or repository files.

Enable **agent internet access** for the environment and allow these hosts:

- `pkgs.tailscale.com`
- `controlplane.tailscale.com`
- `login.tailscale.com`
- `log.tailscale.com`
- `derp*.tailscale.com` (or `*.tailscale.com`)

Allow **HTTPS POST** for control traffic and GET for downloads. The policy
must also permit **HTTP protocol upgrades** over HTTPS. Tailscale upgrades
an HTTPS POST to `/ts2021` for its encrypted control connection. A policy
permitting only GET, HEAD, and
OPTIONS prevents the control plane from joining the node. This must apply
during the agent phase, even if installation worked in setup. See the
[official internet access settings](https://learn.chatgpt.com/docs/environments/cloud-environments#connect-to-services).
Allow the npm registry (`registry.npmjs.org`) for package installation too.
Keep the provider's proxy and CA variables intact; direct UDP is generally
unavailable, so DERP relays are required.

Current limitation: HTTP 403 after a successful CONNECT to
`controlplane.tailscale.com` has been **observed in Codex Cloud**. The egress
proxy blocks the control protocol upgrade before Tailscale evaluates the
auth key. Allowing the domain and POST alone may not suffice: the provider's
network policy must permit upgrades for control and DERP connections. See
[HTTP 403 after CONNECT](troubleshooting.md#http-403-after-connect-to-controlplane).

## Install with a read-only home

Tell the agent to run:

```bash
npm_config_cache=/tmp/npm-cache npm install --prefix /tmp/cts cloud-tailscale
/tmp/cts/node_modules/.bin/cts up
/tmp/cts/node_modules/.bin/cts status
/tmp/cts/node_modules/.bin/cts ssh dasan@raspberry5 -- uname -a
```

Use `/tmp/cts/node_modules/.bin/cts` wherever the skill says `cts`. Both npm's
cache and the package stay in `/tmp`, outside the project. Cloud-Tailscale
also falls back to `$TMPDIR/cloud-tailscale` when the home is read-only, or
you can set `CLOUD_TAILSCALE_HOME=/tmp/cloud-tailscale`. That directory is
private and must stay outside the repository. Repeat installation as needed
in a new task; the node's Tailscale state is never persisted.

## Make the skill available

For this task only, print the packaged instructions:

```bash
/tmp/cts/node_modules/.bin/cts skill --print
```

To add the skill to your repository once, explicitly ask the agent to run
the following from anywhere inside its Git working tree:

```bash
/tmp/cts/node_modules/.bin/cts skill --repo
```

This writes only `.agents/skills/cloud-tailscale/SKILL.md` at the Git root,
including in a linked worktree. Review and commit that file yourself so
later tasks can load it. An existing foreign file is left untouched; a
managed skill can be updated. `skill --install` targets Claude Code's user
skill directory and is not needed for this Codex workflow.

After setup or a daemon restart, run `cts up` again using the full path.
Use `cts nc host 22` for a raw TCP stream or `cts ssh` for a remote command.
Run `cts down` to log out and stop the daemon. See
[troubleshooting](troubleshooting.md) for errors.
