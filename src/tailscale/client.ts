import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { isIP } from "node:net";
import { CtError } from "../core/errors.js";
import type { RuntimePaths } from "../core/paths.js";
import { type RunResult, run } from "../core/proc.js";
import type { Installation } from "./install.js";

export interface PeerStatus {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
  Relay?: string;
}

export interface TailscaleStatus {
  Version?: string;
  TUN?: boolean;
  BackendState: string;
  TailscaleIPs?: string[];
  Self?: PeerStatus | null;
  Peer?: Record<string, PeerStatus> | null;
  Health?: string[] | null;
  CurrentTailnet?: { MagicDNSSuffix?: string } | null;
}

/** Do not hand unrelated auth/SSH secrets to long-lived child processes. */
export function childEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    TS_AUTHKEY: undefined,
    TAILSCALE_AUTHKEY: undefined,
    TS_SSH_KEY: undefined,
    TS_SSH_KEY_FILE: undefined,
    TS_SSH_PASSWORD: undefined,
  };
}

export function validateDestination(host: string, port: number): void {
  if (
    (!isIP(host) && !/^(?=.{1,253}\.?$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.?$/.test(host)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new CtError(
      "INVALID_ARGUMENT",
      "A peer hostname or IP and a TCP port from 1 to 65535 are required.",
      "Run cloud-tailscale nc <host> <port>, for example cloud-tailscale nc raspberry5 22.",
    );
  }
}

export class TailscaleClient {
  constructor(
    readonly installation: Installation,
    readonly paths: RuntimePaths,
    readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private run(args: string[], timeoutMs: number): Promise<RunResult> {
    return run(this.installation.tailscale, [`--socket=${this.paths.socketFile}`, ...args], {
      timeoutMs,
      env: childEnvironment(this.env),
    });
  }

  up(options: {
    keyFile: string;
    hostname: string;
    acceptRoutes?: boolean;
    timeoutMs?: number;
  }): Promise<RunResult> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    return this.run(
      [
        "up",
        `--auth-key=file:${options.keyFile}`,
        `--hostname=${options.hostname}`,
        // Let the CLI return its diagnostic before the process helper's hard deadline.
        `--timeout=${Math.max(1, Math.floor(timeoutMs * 0.9))}ms`,
        ...(options.acceptRoutes ? ["--accept-routes"] : []),
      ],
      timeoutMs,
    );
  }

  async statusJson(timeoutMs = 5_000): Promise<TailscaleStatus> {
    const result = await this.run(["status", "--json"], timeoutMs);
    try {
      // A logged-out status may be returned with a nonzero exit code.
      const status: TailscaleStatus = JSON.parse(result.stdout);
      if (!status || typeof status.BackendState !== "string") throw new Error("Invalid status");
      return status;
    } catch {
      if (/^Logged out\./im.test(`${result.stdout}\n${result.stderr}`)) {
        return { BackendState: "NeedsLogin" };
      }
      throw new CtError(
        "DAEMON_UNAVAILABLE",
        "Could not read the private Tailscale daemon's status.",
        "Run cloud-tailscale up; if it persists, run down and retry up.",
      );
    }
  }

  async logout(): Promise<void> {
    const result = await this.run(["logout"], 10_000);
    if (result.exitCode !== 0 && !/logged out/i.test(`${result.stdout}\n${result.stderr}`)) {
      throw new CtError(
        "CONTROL_UNREACHABLE",
        "Tailscale could not confirm logout with the control plane.",
        "Allow controlplane.tailscale.com and login.tailscale.com through the egress proxy and retry down.",
      );
    }
  }

  ncSpawn(host: string, port: number): ChildProcessWithoutNullStreams {
    validateDestination(host, port);
    return spawn(
      this.installation.tailscale,
      [`--socket=${this.paths.socketFile}`, "nc", host, String(port)],
      { env: childEnvironment(this.env), shell: false, stdio: ["pipe", "pipe", "pipe"] },
    );
  }
}

/** A single stream factory for the SSH integration, with the runtime supplied by connect. */
export function ncSpawn(
  host: string,
  port: number,
  client: TailscaleClient,
): ChildProcessWithoutNullStreams {
  return client.ncSpawn(host, port);
}
