# Cloud-Tailscale Architecture

This document describes how Cloud-Tailscale is built. It must stay consistent
with `docs/constitution.md` and `docs/spec.md`.

## Technology

- TypeScript (strict, ES2022, NodeNext modules), compiled to `dist/`.
- Node.js 20 or later. ES modules (`"type": "module"`).
- Biome for lint and format, Vitest for tests.
- Runtime dependencies, deliberately few:
  - `ssh2`: pure-JavaScript SSH client (FR-7), so no OpenSSH or `sshpass` is
    needed in the container.
  - `undici`: `EnvHttpProxyAgent` for downloads, because Node 20/22 `fetch`
    ignores `HTTPS_PROXY`.
- System tools assumed present: `tar` and `gzip` (for extracting the official
  tarball). Everything else is Node or the Tailscale binaries.
- Distributed as a CLI only: `bin` entries `cloud-tailscale` and `cts` point
  at `dist/cli/bin.js`. No library API (`main`/`exports`).

## Repository layout

```text
src/
  cli/
    bin.ts           # entry point: calls main(), sets exit code
    main.ts          # argument parsing and dispatch, global --json
    commands/        # one file per command: up, down, status, nc, env,
                     # ssh, ssh-config, skill, setup
  core/
    paths.ts         # portable home resolution and private directories (FR-2)
    output.ts        # text/JSON results, error formatting, secret masking (SR-2)
    secrets.ts       # reads secret env vars; registers them for masking (SR-1)
    errors.ts        # CtError with code, message, and next step
    host.ts          # host agent detection (Claude Code, Codex) and
                     # capability detection: arch, uid, /dev/net/tun usable
    proc.ts          # spawn helpers: run-and-capture, detached daemon, timeouts
    http.ts          # proxy-aware fetch (undici EnvHttpProxyAgent)
    skill.ts         # skill print/install/repo (FR-8)
  tailscale/
    install.ts       # resolve version, download, verify SHA-256, extract (FR-3)
    daemon.ts        # start/stop tailscaled with mode, socket, state, proxy env
    log.ts           # masked line writer, detached launch, DERP handshake tracking
    log-writer.ts    # detached Node helper owning tailscaled's output pipes
    client.ts        # thin wrapper over the `tailscale` CLI with --socket:
                     # up, status --json, logout, nc
    connect.ts       # `up` orchestration: idempotency, key file, wait for
                     # Running + DERP, failure classification (FR-4)
    diagnose.ts      # maps daemon log lines and CLI errors to CtError codes
  ssh/
    session.ts       # ssh2 connection over a `tailscale nc` stream (FR-7)
    auth.ts          # key/password selection from secrets
    known-hosts.ts   # trust-on-first-use store in the portable home
    config.ts        # OpenSSH Host entries (ssh-config)
skill/
  SKILL.md           # the agent skill shipped in the package (FR-8)
test/
  unit/              # one test file per module; no network
  fixtures/          # recorded `tailscale status --json`, daemon logs, etc.
docs/
  constitution.md, spec.md, plan.md, tasks.md
  decisions/         # numbered decision records
  guides/            # setup for Claude Code and Codex Cloud, troubleshooting
```

Dependency direction: `cli` → `tailscale`, `ssh`, `core`; `tailscale` and
`ssh` → `core`; `ssh` → `tailscale/client` (for `nc`). `core` depends on
nothing internal.

## Runtime layout

The portable home (FR-2), mode 0700:

```text
<home>/
  bin/tailscale-<version>/{tailscale,tailscaled}
  run/
    tailscaled.sock     # LocalAPI socket (private)
    tailscaled.pid
    tailscaled.log      # daemon log, used by diagnose.ts; never holds secrets
    state/              # --statedir (state itself is mem:)
  known_hosts
  config.json           # chosen mode, hostname, proxy port, version
```

## Main flows

### `up`

1. `secrets.ts` reads `TS_AUTHKEY`; missing → `CtError(AUTH_KEY_MISSING)`.
2. `install.ts` ensures the binaries (GET `pkgs.tailscale.com/stable/?mode=json`,
   then the tarball and its `.sha256`; verify; extract with `tar`).
3. If the daemon socket answers, the backend is `Running`, a DERP handshake is
   confirmed, and status health has no DERP/relay warning, report and stop.
   Otherwise compare the running daemon's mode and version in `config.json`
   with the selected mode and any CLI/environment version pin. Install the
   requested version and restart an unconnected daemon when they differ or
   its configuration is missing.
4. `host.ts` picks the mode. `daemon.ts` spawns `tailscaled` detached, with
   `--state=mem:`, `--statedir`, `--socket`, `--socks5-server` and
   `--outbound-http-proxy-listen` on `127.0.0.1:<port>`, and
   `--tun=userspace-networking` in userspace mode. The child environment
   keeps `HTTPS_PROXY`/`NO_PROXY` and sets `SSL_CERT_FILE` from the
   environment's CA bundle when present. Every `TS_DEBUG_*` setting is removed.
   `--verbose=0` overrides inherited verbosity, and `--no-logs-no-support`
   disables Tailscale's separate unmasked logtail disk buffer and uploads
   ([upstream log policy](https://github.com/tailscale/tailscale/blob/v1.104.1/logpolicy/logpolicy.go)).
   A detached Node helper owns the daemon's stdout/stderr pipes and writes
   complete, masked lines to the private log. It survives the launching CLI;
   credentials reach it only over an anonymous bootstrap pipe. Auth keys,
   registered secrets, PEM bodies, and URL userinfo are masked before disk
   writes, including across output chunks. Authenticated proxy URLs remain
   available to Go so proxies requiring authentication continue to work.
5. `connect.ts` writes the key to a 0600 file and runs
   `tailscale up --auth-key=file:<path> --hostname=<name> [--accept-routes]`,
   then deletes the file in a `finally`.
6. Polls `tailscale status --json` until `BackendState == Running`, a home
   DERP region is set, and health contains no DERP/relay warnings. It also
   requires the session log's DERP handshake acknowledgement, invalidated by
   a later receive error or connection close. This is the same predicate used
   by idempotent `up` and `status`. In [Tailscale 1.104.1's reader](https://github.com/tailscale/tailscale/blob/v1.104.1/wgengine/magicsock/derp.go),
   `magicsock: derp-N connected; connGen=…` is logged only after receiving
   `derp.ServerInfoMessage`. This positive signal avoids the startup window
   before [relay health warnings become visible](https://github.com/tailscale/tailscale/blob/v1.104.1/health/warnings.go)
   (10 seconds). The session log is streamed, so an older handshake remains
   usable without loading the entire file into memory. On timeout,
   `diagnose.ts` classifies destination/stage errors before generic proxy/TLS
   errors, directing DERP failures to DERP hosts and control failures to
   control hosts.

### `ssh`

1. Ensure connected (runs `up` when needed, FR-9).
2. Spawn `tailscale --socket=… nc <host> 22` and wrap its stdio as a duplex
   stream; pass it to `ssh2` as `sock`. This one path works in both modes.
3. `known-hosts.ts` verifies the host key (TOFU).
4. `auth.ts` supplies a key or password; `ssh2` runs `exec` or `shell`,
   streams stdout/stderr, and the command's exit code becomes ours.

## Output and errors

Every command returns a `Result { ok, message, data }`. `output.ts` prints
`message` (text mode) or the whole object (`--json`) after masking. Errors are
`CtError { code, message, next }`; `main.ts` prints them to stderr and exits 1
(`ssh` exits with the remote code). Codes are stable strings used in tests
and in the skill (for example `AUTH_KEY_MISSING`, `AUTH_KEY_REJECTED`,
`CONTROL_UNREACHABLE`, `DERP_UNREACHABLE`, `DOWNLOAD_FAILED`,
`CHECKSUM_MISMATCH`, `KERNEL_MODE_UNAVAILABLE`, `SSH_AUTH_FAILED`,
`HOST_KEY_CHANGED`).

## Testing

- Unit tests stub `proc.ts` and `http.ts`; no test touches the network or
  starts a real daemon.
- Fixtures under `test/fixtures` come from real runs (status JSON, daemon log
  excerpts) with identifying values replaced.
- Live checks (real tailnet) are manual, recorded in `docs/decisions/`.

## Release

GitHub Actions: CI (lint, typecheck, test on Node 20 and 22) on every push;
publishing with npm trusted publishing (OIDC) and provenance on version tags,
mirroring Agent-Bridge.
