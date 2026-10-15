import { CtError } from "../../core/errors.js";
import type { Result } from "../../core/output.js";
import { ensurePaths } from "../../core/paths.js";
import { TailscaleClient, type TailscaleStatus } from "../../tailscale/client.js";
import { connected } from "../../tailscale/connect.js";
import { isRunning, readConfig } from "../../tailscale/daemon.js";
import { findInstalled } from "../../tailscale/install.js";
import { hasConnectedDerp } from "../../tailscale/log.js";

export async function statusCommand(args: string[] = []): Promise<Result> {
  if (args.length) {
    throw new CtError(
      "INVALID_ARGUMENT",
      "status takes no arguments.",
      "Run cloud-tailscale status [--json].",
    );
  }
  const paths = await ensurePaths();
  const installation = await findInstalled(paths);
  const daemonRunning = await isRunning(paths);
  let status: TailscaleStatus | undefined;
  if (daemonRunning && installation) {
    status = await new TailscaleClient(installation, paths).statusJson();
  }
  const stopped =
    !daemonRunning || status?.BackendState === "Stopped" || status?.BackendState === "NeedsLogin";
  if (stopped) status = undefined;
  const config = stopped ? undefined : await readConfig(paths);
  const peers = Object.values(status?.Peer ?? {})
    .map((peer) => ({
      name: peer.HostName || peer.DNSName?.replace(/\.$/, "") || "unknown",
      dnsName: peer.DNSName?.replace(/\.$/, "") ?? null,
      ips: peer.TailscaleIPs ?? [],
      online: peer.Online === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const data = {
    installed: Boolean(installation),
    version: installation?.version ?? null,
    daemonRunning,
    connected: status ? connected(status, await hasConnectedDerp(paths.logFile)) : false,
    state: stopped ? "Stopped" : (status?.BackendState ?? "Unknown"),
    name: status?.Self?.HostName ?? config?.hostname ?? null,
    ips: status?.TailscaleIPs ?? status?.Self?.TailscaleIPs ?? [],
    mode:
      typeof status?.TUN === "boolean"
        ? status.TUN
          ? "kernel"
          : "userspace"
        : (config?.mode ?? null),
    derp: status?.Self?.Relay ?? null,
    peers,
  };
  return {
    ok: true,
    message: [
      `Tailscale: ${data.installed ? `installed (${data.version})` : "not installed"}; daemon ${daemonRunning ? "running" : "stopped"}; ${data.state}${data.connected ? " (connected)" : ""}.`,
      ...(data.name
        ? [
            `Node: ${data.name}; IPs: ${data.ips.join(", ") || "none"}; mode: ${data.mode ?? "unknown"}; DERP: ${data.derp ?? "none"}.`,
          ]
        : []),
      ...(peers.length
        ? [
            "NAME\tIPS\tSTATE",
            ...peers.map(
              (peer) =>
                `${peer.name}\t${peer.ips.join(", ")}\t${peer.online ? "online" : "offline"}`,
            ),
          ]
        : stopped
          ? []
          : ["No peers reported."]),
    ].join("\n"),
    data,
  };
}
