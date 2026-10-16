# Cloud-Tailscale Plan

This plan sequences the work to deliver `docs/spec.md` v1. Tasks for each
phase are in `docs/tasks.md`.

## Phase 0: Foundation

Scaffold the package (TypeScript, Biome, Vitest, CI) and the `core` modules
every other part depends on: paths, output and masking, secrets, errors, host
and capability detection, process and HTTP helpers, and the CLI dispatcher.

Exit criteria: `npm run lint`, `npm run typecheck`, `npm test` pass; `cts
--help` runs from a local build; CI is green.

## Phase 1: Features (parallel tracks)

Three independent tracks, built in parallel on separate branches against the
Phase 0 interfaces:

- **Track A, Tailscale**: install (FR-3), daemon, client, connect, diagnose;
  commands `up`, `status`, `down`, `nc`, `env` (FR-4 to FR-6).
- **Track B, SSH**: session over a stream, auth, known hosts, OpenSSH config;
  commands `ssh` and `ssh-config` (FR-7), using a stubbed `nc` stream.
- **Track C, Skill and setup**: `SKILL.md`, `skill` command, `setup` command
  (FR-8, FR-9), user guides for Claude Code and Codex Cloud, troubleshooting.

Exit criteria per track: unit tests for every module; lint, typecheck, and
tests pass; the reviewer approves.

## Phase 2: Integration and live verification

Merge the tracks; wire `ssh` to the real `nc`; auto-`up` (FR-9). Verify the
acceptance criteria 1, 2, 4, and 5 live in a Claude Code on the web session
against the owner's tailnet. Record results in a decision record.

## Phase 3: Release

Package checks (`npm pack` contents), README, CHANGELOG, trusted publishing
workflow, first publish of `cloud-tailscale` to npm (owner approves), then a
fresh Claude Code session using `npx -y cloud-tailscale setup` from the
registry.

## Phase 4: Codex Cloud verification

Status: Blocked; see [0002](decisions/0002-codex-cloud.md).

Acceptance criterion 3 is deferred and not met. Revisit live verification
if the proxy permits the TS2021 upgrade or the built-in VPN provides a
working TCP path to tailnet devices.
