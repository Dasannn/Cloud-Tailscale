# Cloud-Tailscale Tasks

Executable tasks for the phases in `docs/plan.md`. Each task names its files
and its done criteria. Every task also requires: lint, typecheck, and tests
pass; no secrets in code, fixtures, or output; no files outside the task.

## Phase 0: Foundation

### 0.1 Scaffold

Files: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`,
`.github/workflows/ci.yml`, `src/cli/bin.ts`, `src/cli/main.ts`, `LICENSE`
(MIT).

- `package.json`: name `cloud-tailscale`, `type: module`, `engines.node >=20`,
  `bin` `cloud-tailscale` and `cts` → `dist/cli/bin.js`, `files` allowlist
  (`dist/cli`, `dist/core`, `dist/tailscale`, `dist/ssh`, `skill`), scripts
  `build`, `prepare`, `typecheck`, `lint`, `test`. Dependencies `ssh2`,
  `undici`; dev dependencies TypeScript, Biome, Vitest, `@types/node`,
  `@types/ssh2`.
- CI on push and pull request: Node 20 and 22, `npm ci`, lint, typecheck,
  test, build.
- `main.ts`: parses `<command> [args] [--json] [--help]`, dispatches to a
  command registry (empty commands may print "not implemented" until their
  track lands), prints results through `core/output.ts`, maps `CtError` to
  stderr and exit 1. `--help` lists commands.

Done: `npm run build && node dist/cli/bin.js --help` works.

### 0.2 Core modules

Files: `src/core/{paths,output,secrets,errors,host,proc,http}.ts` and a test
file per module under `test/unit/core/`.

- `paths.ts`: resolve home per FR-2 (env override, writable `~`, else
  `$TMPDIR`); create private dirs (0700) and expose the runtime layout from
  `ARCHITECTURE.md`.
- `errors.ts`: `CtError { code, message, next }` and the code list.
- `secrets.ts`: getters for `TS_AUTHKEY`/`TAILSCALE_AUTHKEY`, `TS_SSH_KEY`,
  `TS_SSH_KEY_FILE`, `TS_SSH_PASSWORD`, `TS_SSH_USER`; every value read is
  registered with the masker.
- `output.ts`: `Result` type; text and JSON printers; masking of registered
  secrets, `tskey-…` tokens, and PEM private key blocks.
- `host.ts`: host agent (`CLAUDE_CODE_ENTRYPOINT`/`CLAUDECODE` → claude;
  `CODEX_THREAD_ID`/`CODEX_SESSION_ID` → codex; else local); arch mapping
  (`x64`→`amd64`, `arm64`→`arm64`, others unsupported); `isRoot`;
  `tunUsable` (open `/dev/net/tun` read-write succeeds).
- `proc.ts`: `run(cmd, args, {env, timeoutMs, input})` capturing output;
  `spawnDetached(cmd, args, {env, logFile})` returning the pid.
- `http.ts`: `fetch` wrapper using undici `EnvHttpProxyAgent`; honors
  `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE` by adding the CA bundle to the agent's
  TLS options when the file exists; maps network errors to
  `DOWNLOAD_FAILED` naming the host.

Done: unit tests cover each function, including masking edge cases.

## Phase 1: Features

Each track starts from the Phase 0 commit, on its own branch and worktree.

### 1.A Tailscale track

Files: `src/tailscale/{install,daemon,client,connect,diagnose}.ts`,
`src/cli/commands/{up,status,down,nc,env}.ts`, tests and fixtures.

- `install.ts` per FR-3 and the `up` flow in `ARCHITECTURE.md`; extraction
  with `tar` into a temp dir, then atomic rename into
  `bin/tailscale-<version>/`.
- `daemon.ts`: start (mode, socket, statedir, `--state=mem:`, loopback
  SOCKS5/HTTP listener, proxy and CA env), `isRunning` (socket answers),
  `stop` (SIGTERM, then SIGKILL after a timeout), pid and log files.
- `client.ts`: `up`, `statusJson`, `logout`, `ncSpawn(host, port)` returning
  the child process; always passes `--socket`.
- `connect.ts`: FR-4 including idempotency, key file 0600 deleted in
  `finally`, default hostname `<host-agent>-cloud-<4 hex>`, wait for
  `Running` plus a confirmed DERP connection and no relay health warnings,
  timeout; check saved mode/version before reusing an unconnected daemon.
- `diagnose.ts`: classify from the CLI error text and log tail:
  invalid/expired key → `AUTH_KEY_REJECTED`; control connection failures →
  `CONTROL_UNREACHABLE`; no DERP home → `DERP_UNREACHABLE`; each with the
  hosts to allow.
- Commands: `up`, `status` (peers table from status JSON), `down`, `nc`
  (pipes stdio to `ncSpawn`), `env` (prints `ALL_PROXY`/`all_proxy` for
  SOCKS5 and keeps existing `HTTPS_PROXY`; explains scope in a comment line).

Done: unit tests with recorded status JSON and log fixtures; no real network.

### 1.B SSH track

Files: `src/ssh/{session,auth,known-hosts,config}.ts`,
`src/cli/commands/{ssh,ssh-config}.ts`, tests.

- `session.ts`: `openSsh({host, port, user, sock})` over any duplex stream
  (takes a stream factory so tests can use an in-memory `ssh2` server);
  `exec` streams output and resolves the exit code; `shell` when a TTY is
  present (raw mode, window size).
- `auth.ts`: key (`TS_SSH_KEY` or `TS_SSH_KEY_FILE`) before password
  (`TS_SSH_PASSWORD`); user from `user@host`, then `TS_SSH_USER`, then
  `os.userInfo()`; `SSH_AUTH_FAILED` with the variables to set.
- `known-hosts.ts`: TOFU store in the portable home; mismatch →
  `HOST_KEY_CHANGED`.
- `config.ts`: generate OpenSSH `Host` blocks with
  `ProxyCommand <abs path to cts> nc %h %p`; write between marker comments in
  `~/.ssh/config` (create 0600), replacing only our block; no passwords.
- Commands take the stream factory from a single injection point; Track A's
  `ncSpawn` is wired in Phase 2.

Done: tests against an in-process `ssh2` server cover exec exit codes,
password and key auth, TOFU accept and mismatch, config idempotency.

### 1.C Skill and setup track

Files: `skill/SKILL.md`, `src/core/skill.ts`,
`src/cli/commands/{skill,setup}.ts`, `docs/guides/claude-code.md`,
`docs/guides/codex-cloud.md`, `docs/guides/troubleshooting.md`, tests.

- `SKILL.md` per FR-8: install when missing (`npx -y cloud-tailscale` or, with
  a read-only home, `npm install --prefix /tmp/cts cloud-tailscale` with
  `npm_config_cache=/tmp/npm-cache`), `cts up`, `cts status`,
  `cts ssh user@host -- cmd`, `cts nc`; never ask for or paste secrets; error
  codes → what to tell the user.
- `skill.ts`: `--print`, `--install` (`~/.claude/skills/cloud-tailscale/`),
  `--repo` (Git root `.agents/skills/cloud-tailscale/SKILL.md`; leaves a
  foreign existing file untouched).
- `setup`: calls an injected `up` (stubbed until Phase 2), installs the skill
  when the host is Claude Code, reports each step; missing auth key is
  reported, not fatal.
- Guides: secrets to add, setup script line, network hosts and methods to
  allow, recommended auth key settings and ACL tag, SSH key recommendation.

Done: tests for `skill.ts` and `setup` step reporting.

## Phase 2: Integration and live verification

### 2.1 Wiring

Files: `src/cli/main.ts`, `src/cli/commands/{ssh,ssh-config,setup,nc,env}.ts`,
`src/tailscale/connect.ts`, `src/core/http.ts`, tests.

- Replace the `ssh` default stream factory with `tailscale nc <host> <port>`
  from `src/tailscale/client.ts`; propagate an `nc` failure (peer offline,
  unknown name) as a clear `CtError`.
- Replace the `setup` default `up` with the real `up` from
  `src/tailscale/connect.ts`.
- FR-9 auto-up: `nc`, `ssh`, `ssh-config`, and `env` run `up` first when the
  daemon is not connected and an auth key is set; without a key they fail
  with `AUTH_KEY_MISSING`.
- `ssh-config` lists online peers from `tailscale status --json`.
- Remove the obsolete `NOT_IMPLEMENTED` placeholders from `main.ts`.
- Suppress Undici's `EnvHttpProxyAgent` experimental warning (code
  `UNDICI-EHPA`) so it never reaches the agent's output; other warnings
  still print.

Done: unit tests cover the wiring and auto-up paths; checks pass.

### 2.2 Live verification

Run by the lead in a Claude Code on the web session whose environment has
`TS_AUTHKEY`, `TS_SSH_PASSWORD`, and `TS_SSH_USER`, with the setup script
installing this branch from GitHub. Verify acceptance criteria 1, 2, 4, and
5 of `docs/spec.md`, and record the results in `docs/decisions/`.
