# 0002: Codex Cloud Support Deferred

- Status: Accepted
- Date: 2026-10-16

## Context

Phase 4 requires checking acceptance criterion 3 of [the specification](../spec.md)
in a Codex Cloud task. Claude Code on the web has already passed live
verification ([0001](0001-live-verification.md)). A Codex Cloud task on
2026-10-16 tested both Cloud-Tailscale's own Tailscale client and Codex's
built-in Tailscale VPN integration.

## Findings

**Task environment.** The task ran without root or `/dev/net/tun`, with a
read-only home directory. Installing the npm package into `/tmp` worked;
package installation and userspace networking were not the blocker.

**Control connection.** `tailscaled` reached the egress proxy:
`CONNECT controlplane.tailscale.com:443` returned HTTP 200. The inner
`POST /ts2021` with `Upgrade: tailscale-control-protocol` then received HTTP
403, with `server: envoy` in the response. A curl probe showed that the
proxy downgraded the request to HTTP/2, which cannot carry this HTTP/1.1
protocol upgrade. Together, these observations identify the proxy path as
the blocker; a successful CONNECT does not establish a working Tailscale
control channel. The failure precedes auth-key evaluation.

**Client transport.** The official Linux client at v1.104.1 requires the
TS2021 upgrade and HTTP 101 before exchanging encrypted control traffic.
Its HTTP/80 and HTTPS/443 attempts use the same upgrade; HTTP/2 is disabled
in the client's transport for this reason. There is no alternative control
transport in this version: forcing port 443 still requires the upgrade,
and DERP WebSockets would affect relay traffic only. See the tagged
[client.go](https://github.com/tailscale/tailscale/blob/v1.104.1/control/controlhttp/client.go#L221-L242),
[HTTP transport setup](https://github.com/tailscale/tailscale/blob/v1.104.1/control/controlhttp/client.go#L429-L448),
and [upgrade response check](https://github.com/tailscale/tailscale/blob/v1.104.1/control/controlhttp/client.go#L504-L521).
[Tailscale issue #4593](https://github.com/tailscale/tailscale/issues/4593)
records a separate Squid proxy rejecting TS2021 upgrades; it illustrates
the protocol's proxy requirements, rather than proving Codex's behavior.

**Network secrets.** Codex gives programs placeholders for network secrets;
the proxy substitutes their values only in HTTPS requests on port 443 to
allowed domains. This mechanism cannot supply `TS_AUTHKEY` inside
Tailscale's encrypted control protocol or credentials inside SSH. Direct
environment variables are a separate mechanism, but do not resolve the
transport failure. See the
[Codex cloud environment documentation](https://learn.chatgpt.com/docs/environments/cloud-environments#configure-environment-variables-and-network-secrets).

**Built-in VPN.** Codex's Tailscale integration under **Advanced > VPN**
was configured for the test. Tailscale's
[Codex Cloud blog](https://tailscale.com/blog/codex-cloud-tailscale#connecting-codex-cloud-with-tailscale)
describes arbitrary TCP over HTTP CONNECT through `proxy:8088`, separately
from Cloud-Tailscale's own daemon. In this task, `proxy:8088` refused
connections. A CONNECT to the Pi's tailnet IP through `HTTPS_PROXY`
returned HTTP 200 but no SSH banner. Neither probe established a working
TCP path to the Pi.

## Decision

- Codex Cloud is unsupported in v0.1.x. The supported target is Claude Code
  on the web.
- Defer user story 2 and acceptance criterion 3 as not met, and mark Phase 4
  blocked. Replace Codex setup instructions with the unsupported status;
  agents should explain the limitation instead of retrying.
- Revisit if the egress proxy allows the TS2021 upgrade or the built-in
  VPN exposes a working TCP path to tailnet devices. Verify that path live
  before claiming support.

## Consequences

Codex users cannot currently connect with Cloud-Tailscale; installing in
`/tmp`, allowing domains or POST, changing auth keys, or retrying does not
resolve the observed proxy failure. Keep the existing `skill --repo`
command behavior, but do not promote it as a Codex connection workflow.
Report proxy rejections of control and DERP upgrades as
`CONTROL_UNREACHABLE` and `DERP_UNREACHABLE`, respectively, rather than
`AUTH_KEY_REJECTED`.
