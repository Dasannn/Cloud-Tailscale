# Troubleshooting

Run `cts status` to see the connection state and peers; use
`cts status --json` for machine-readable output. When `cts` is missing, use
`npx -y cloud-tailscale`, or the full `/tmp/cts/node_modules/.bin/cts` path
from the [Codex Cloud guide](codex-cloud.md). Never print your environment
or paste credentials into chat while debugging. Relay the error code,
masked reason, and next step instead.

| Code | Next step |
| --- | --- |
| `AUTH_KEY_MISSING` | Add `TS_AUTHKEY` or `TAILSCALE_AUTHKEY` through the environment's secrets so it is available to the command, then run `cts up`. Use a reusable, ephemeral, pre-approved key with an ACL-restricted tag. Setup alone treats this as nonfatal. |
| `AUTH_KEY_REJECTED` | Replace the revoked, expired, or invalid auth key in secrets; check the key's tag, ACLs, and approval settings in Tailscale. |
| `DOWNLOAD_FAILED` | Allow `pkgs.tailscale.com`, including GET, and check the provider's egress proxy and trusted CA bundle. |
| `CHECKSUM_MISMATCH` | Nothing should be installed from that download. Retry a fresh download and check your proxy; never bypass checksum verification. |
| `CONTROL_UNREACHABLE` | Allow `controlplane.tailscale.com`, `login.tailscale.com`, and `log.tailscale.com`; allow POST and preserve proxy/CA settings. |
| `DERP_UNREACHABLE` | Allow `derp*.tailscale.com` or `*.tailscale.com`. The session needs an outbound DERP connection because direct UDP is usually blocked. |
| `KERNEL_MODE_UNAVAILABLE` | Use `cts up --mode userspace`; root and a usable `/dev/net/tun` are required only for kernel mode. |
| `SSH_AUTH_FAILED` | Check the user, remote SSH access, and ACLs. Configure `TS_SSH_KEY` or `TS_SSH_KEY_FILE` (preferred), or `TS_SSH_PASSWORD`, through secrets. |
| `HOST_KEY_CHANGED` | Stop. Verify the new host key with the device owner before changing the trust record in Cloud-Tailscale's home. Never delete it automatically to bypass the failure. |
| `HOME_UNAVAILABLE` | Set `CLOUD_TAILSCALE_HOME` to a private writable directory outside the project, for example `/tmp/cloud-tailscale`. |
| `SKILL_CONFLICT` | A foreign file, link, or directory blocks the skill path. It was left untouched. Review it and move it manually before retrying. |
| `SKILL_INSTALL_FAILED` | Check the reported skill path's write permissions. With a read-only user home, use `cts skill --print` for this task or explicitly add the repository skill with `cts skill --repo`. Reinstall the package if its shipped skill is missing. |
| `GIT_ROOT_NOT_FOUND` | Run `cts skill --repo` from a Git working tree with `git` installed, or print the skill for this session. |
| `UNSUPPORTED_ARCH` | Use a Linux x86_64 or arm64 container. |
| `PROCESS_FAILED` / `PROCESS_TIMEOUT` | Check the tool named in the message, its availability and connectivity, then retry. |
| `INVALID_ARGUMENT` | Run `cts --help` and check the command syntax. Skill actions are mutually exclusive. Never pass a secret as an argument. |
| `NOT_IMPLEMENTED` | Use a release that includes this command. During Phase 1, setup's injected `up` defaults to this error until Phase 2 supplies the real connection function. |
| `INTERNAL_ERROR` | Retry, then report the masked error and relevant environment capabilities if it persists. |

## Setup completed but the session is offline

In Claude Code on the web, the setup script may not see the environment's
secrets, and its daemon may not survive into the agent session. With the
auth key available in the session, the first connection command (`cts ssh`,
`cts nc`, `cts env`, or `cts ssh-config`) connects automatically in about
10 to 15 seconds. You can also run `cts up`, then check `cts status`;
`status` only reports state. After `cts down`, status shows the installed
version and stopped state without old node details or peers.

Read `<home>/setup.log` to see what setup did. Setup prints its exact path:
`$CLOUD_TAILSCALE_HOME/setup.log` when overridden, otherwise
`~/.cloud-tailscale/setup.log` with a writable home, or
`$TMPDIR/cloud-tailscale/setup.log` as a fallback. Each setup run replaces
this private file (0600) with its masked, plain-text step report, a UTC
timestamp, and SET/UNSET markers for credential variables; it never records
their values. UNSET during setup can explain why setup deferred connection
even when the secret is available later in the session. Missing credentials
are nonfatal during setup. Other failed steps exit nonzero, even if skill
installation succeeded.

On Codex Cloud, enable agent internet access with the Tailscale hosts above
and POST allowed. A successful npm installation does not prove that the
agent can reach the control plane or relays. Setup-only secrets may also be
unavailable during the task; see the [Codex guide](codex-cloud.md#configure-credentials-and-networking).

## A peer name does not resolve

In userspace mode, ordinary container DNS and TCP tools do not automatically
use the tailnet. Use `cts ssh user@host -- command` or `cts nc host port`,
which reach the peer through the daemon. `cts env` describes the local
SOCKS5/HTTP proxy for tools that support it; scope it to tailnet requests
and preserve the provider's own HTTPS proxy. A peer must be online and its
ACLs and service must permit the connection.
