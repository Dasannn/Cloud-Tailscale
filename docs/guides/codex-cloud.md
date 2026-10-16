# Codex Cloud

Codex Cloud is **unsupported in v0.1.x**. Cloud-Tailscale targets Claude
Code on the web. See [decision 0002](../decisions/0002-codex-cloud.md) for
the evidence and sources.

In a live task on 2026-10-16, installation into `/tmp` worked despite a
read-only home, no root, and no `/dev/net/tun`. The proxy returned HTTP 200
for CONNECT to `controlplane.tailscale.com:443`, then rejected the inner
`POST /ts2021` protocol upgrade with HTTP 403 (`server: envoy`). A curl
probe showed HTTP/2 downgrading, which cannot carry this upgrade. Tailscale
v1.104.1 has no alternative control transport.

Codex network secrets substitute placeholders only in HTTPS requests to
allowed domains; they cannot carry `TS_AUTHKEY` through Tailscale's
encrypted control protocol or supply SSH credentials. The built-in
Tailscale VPN was configured, but `proxy:8088` refused connections and a
CONNECT to the Pi's tailnet IP through `HTTPS_PROXY` returned HTTP 200
without an SSH banner.

Support can be revisited if the egress proxy permits the TS2021 upgrade or
the built-in VPN provides a working TCP path to tailnet devices, verified
in a live task. Explain this limitation to Codex users instead of retrying
the connection.
