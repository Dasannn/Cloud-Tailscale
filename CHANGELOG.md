# Changelog

## 0.1.2 (2026-10-16)

- Fixed: proxy rejections of Tailscale's control/DERP upgrade (HTTP
  403/405/407) are reported as `CONTROL_UNREACHABLE`/`DERP_UNREACHABLE`
  instead of `AUTH_KEY_REJECTED`.
- Changed: Codex Cloud is documented as unsupported for now.

## 0.1.1

- Refresh the README with badges, a short pitch, a relay flow diagram, and
  an SSH example while preserving setup, configuration, and security guidance.
- Use relative repository links and add a link to the sibling Agent-Bridge
  project.
- Add npm keywords and a concise package description.
- Add a security policy for private vulnerability reports and a bug report
  form with environment, version, JSON output, and secret-redaction prompts.

## 0.1.0

Initial release of Cloud-Tailscale for Linux x86_64 and arm64 with Node.js
20 or later.

- Join a Tailscale tailnet as an ephemeral cloud coding agent, with automatic
  kernel or userspace networking, proxy-aware downloads, and verified
  official Tailscale binaries.
- Connect, check peers, and disconnect with `up`, `status`, and `down`.
  Reach peers by name with `nc`, the local SOCKS5/HTTP proxy, or built-in SSH.
- Authenticate SSH with a private key or password from environment secrets,
  verify host keys on first use, and generate optional OpenSSH configuration.
- Install the agent skill for Claude Code or explicitly add it to a Codex
  Cloud repository; reconnect automatically when a command needs a connection.
- Keep credentials out of command arguments and mask them in output and
  daemon logs. Store runtime files privately outside the project and keep
  Tailscale state in memory.
- Provide text and JSON results, actionable errors, `--help`, and `--version`.
