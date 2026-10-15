# 0001: Live Verification in Claude Code on the Web

- Status: Accepted
- Date: 2026-10-15

## Context

Task 2.2 requires checking acceptance criteria 1, 2, 4, and 5 of
`docs/spec.md` against the owner's real tailnet, from a Claude Code on the
web session whose environment holds `TS_AUTHKEY`, `TS_SSH_PASSWORD`, and
`TS_SSH_USER`.

## Findings

**Feasibility probe (before implementation).** The official Tailscale
1.104.1 static binary, in userspace mode, registered through the
environment's egress proxy using only `HTTPS_PROXY` and `SSL_CERT_FILE`.
Direct UDP was unavailable; `netcheck` reached DERP over HTTPS. After an
interactive login, `raspberry5` answered pings through DERP (about 110 ms)
and `tailscale nc raspberry5 22` returned the SSH banner.

**Running from a GitHub branch with `npx`.** In sessions using auto
permission mode, commands of the form `npx -y github:<owner>/<repo>#<ref>`
were refused as "Code from External", even after the user approved in chat.
Installing the package from the setup script into a fixed prefix and linking
`cts` into `PATH` avoided this: later `cts` commands ran without prompts, so
no permission rule is needed.

**End-to-end run.** With `cts` installed:

| Check | Result |
| --- | --- |
| `cts up` | Connected in kernel mode, DERP `ord`, in 11.8 s |
| `cts ssh raspberry5 -- uname -a` | Pi kernel printed, exit code 0 |
| `cts ssh raspberry5 -- 'echo hello; exit 3'` | `hello`, exit code 3 |
| `cts status --json` | Connected, 6 peers listed |
| Secrets | No `tskey` in the daemon log or process arguments; run directory 0700, files 0600 |
| `cts down` | Logged out and stopped the daemon |

**Setup script.** The setup script installed `cts` and the Claude Code
skill, but the session started without a running daemon and without
`~/.cloud-tailscale`. The first `cts ssh` connected through the automatic
`up` (FR-9) and succeeded. The likely cause is that the setup script does not
see the environment's secrets, so `setup` reports a missing key without
failing; task 2.3 adds `setup.log` to confirm it.

**Setup script failures.** Setup scripts stop at the first failing command,
so each independent step needs its own `|| true`. Otherwise a failure in an
earlier tool prevents Cloud-Tailscale from being installed.

## Decision

- Recommend installing Cloud-Tailscale in the setup script (globally once
  published, or into a fixed prefix linked into `PATH` before release) and
  rely on the automatic `up` for the connection.
- Do not add Claude Code permission rules in `setup`; they were not needed.
- Fix the stale node name shown by `status` after `down` (task 2.3).

## Consequences

The first tailnet command in a session takes about 10 to 15 seconds longer
while Tailscale installs and connects. Acceptance criteria 2, 4, and 5 are
met; criterion 1 is met through the automatic `up` rather than by the setup
script itself.
