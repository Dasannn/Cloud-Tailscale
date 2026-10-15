# Tailscale container fixtures

These minimized fixtures preserve the behavior verified in a Claude Code cloud
container on 2026-10-15 with Tailscale 1.104.1: stable metadata uses
`TarballsVersion`, checksum files contain only a SHA-256 hexadecimal digest,
userspace mode uses the environment's HTTPS proxy and its CA bundle, interactive
login prints `To authenticate, visit:`, and logged-out status prints
`Logged out.` MagicDNS short names work with `tailscale nc`; direct UDP is
blocked and connections use DERP.

`status-running.json` models that connection with identifying fields replaced
and unrelated fields omitted. Its `TUN`, `BackendState`, `Self.Relay`, and peer
fields follow the official
[ipnstate schema](https://github.com/tailscale/tailscale/blob/v1.104.1/ipn/ipnstate/ipnstate.go).
`Self.Relay` is a selected region, not a connection acknowledgement. The
tests pair status health with synthetic `magicsock: derp-N connected;
connGen=…` log lines, which the 1.104.1 reader emits on `ServerInfoMessage`;
receive errors and connection closes invalidate that signal. Relay health
failures include both the older home-DERP wording and 1.104.1's relay-server
wording. Log-writer tests use synthetic Node output producers to check masking
and survival of the launching CLI without executing Tailscale.
The three failure logs are synthetic diagnostic cases, not production captures.
Archive bytes and their digest are generated in the installer tests; tests never
download a release, execute a downloaded binary, or start a daemon.
