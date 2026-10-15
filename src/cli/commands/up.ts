import { CtError } from "../../core/errors.js";
import type { Result } from "../../core/output.js";
import { type Connection, type ConnectOptions, connect } from "../../tailscale/connect.js";

export function parseUpOptions(args: string[]): ConnectOptions {
  const options: ConnectOptions = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--accept-routes") {
      options.acceptRoutes = true;
      continue;
    }
    const [flag, ...inline] = arg.split("=");
    if (!["--hostname", "--mode", "--tailscale-version"].includes(flag)) {
      throw new CtError(
        "INVALID_ARGUMENT",
        "Unknown up option. Auth keys are accepted only from environment secrets.",
        "Use up [--hostname <name>] [--mode auto|kernel|userspace] [--accept-routes] [--tailscale-version <version>].",
      );
    }
    const value = inline.length ? inline.join("=") : args[++index];
    if (!value || value.startsWith("--")) {
      throw new CtError(
        "INVALID_ARGUMENT",
        `Missing value for ${flag}.`,
        "Run cloud-tailscale --help.",
      );
    }
    if (flag === "--mode") {
      if (value !== "auto" && value !== "kernel" && value !== "userspace") {
        throw new CtError(
          "INVALID_ARGUMENT",
          "Unknown networking mode.",
          "Choose auto, kernel or userspace.",
        );
      }
      options.mode = value;
    } else if (flag === "--hostname") {
      if (!/^(?=.{1,63}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(value)) {
        throw new CtError(
          "INVALID_ARGUMENT",
          "The hostname must be a DNS label of at most 63 letters, digits or hyphens.",
          "Choose a hostname such as claude-cloud-agent.",
        );
      }
      options.hostname = value;
    } else {
      if (!/^\d+\.\d+\.\d+$/.test(value)) {
        throw new CtError(
          "INVALID_ARGUMENT",
          "Invalid Tailscale version.",
          "Use a release such as 1.104.1.",
        );
      }
      options.version = value;
    }
  }
  return options;
}

export function connectionData(connection: Connection) {
  const { status, config } = connection;
  return {
    name: status.Self?.HostName ?? config.hostname,
    ips: status.TailscaleIPs ?? status.Self?.TailscaleIPs ?? [],
    mode: typeof status.TUN === "boolean" ? (status.TUN ? "kernel" : "userspace") : config.mode,
    derp: status.Self?.Relay ?? null,
    proxy: `127.0.0.1:${config.proxyPort}`,
    state: status.BackendState,
    alreadyConnected: connection.alreadyConnected,
  };
}

export async function upCommand(args: string[] = []): Promise<Result> {
  const data = connectionData(await connect(parseUpOptions(args)));
  return {
    ok: true,
    message: [
      `${data.alreadyConnected ? "Already connected" : "Connected"} as ${data.name} (${data.ips.join(", ") || "IP pending"}) in ${data.mode} mode; DERP ${data.derp}.`,
      "Reach peers with cloud-tailscale ssh user@host, cloud-tailscale nc <host> <port>, or evaluate cloud-tailscale env for proxy-aware tools.",
      ...(data.mode === "kernel"
        ? ["Tailnet IPs and MagicDNS names are also reachable directly."]
        : []),
    ].join("\n"),
    data,
  };
}
