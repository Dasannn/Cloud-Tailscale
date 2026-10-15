import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CtError } from "../core/errors.js";
import { detectHost } from "../core/host.js";
import { ensurePaths, type RuntimePaths } from "../core/paths.js";
import { getAuthKey } from "../core/secrets.js";
import { TailscaleClient, type TailscaleStatus } from "./client.js";
import {
  type DaemonConfig,
  isRunning,
  type ModeOption,
  readConfig,
  selectMode,
  start,
  stop,
} from "./daemon.js";
import { diagnose, hasDerpWarning, readLogTail } from "./diagnose.js";
import { ensureInstalled, findInstalled, type Installation } from "./install.js";
import { hasConnectedDerp } from "./log.js";

export interface Connection {
  paths: RuntimePaths;
  installation: Installation;
  client: TailscaleClient;
  config: DaemonConfig;
  status: TailscaleStatus;
  alreadyConnected: boolean;
}

export interface ConnectOptions {
  hostname?: string;
  mode?: ModeOption;
  acceptRoutes?: boolean;
  version?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export function connected(status: TailscaleStatus, derpConfirmed: boolean): boolean {
  return (
    derpConfirmed &&
    status.BackendState === "Running" &&
    Boolean(status.Self?.Relay) &&
    status.Self?.Online !== false &&
    // Status.Health is sourced from the daemon's health tracker in Tailscale 1.104.1.
    // A selected relay is not connected while home-DERP/relay warnings remain.
    (status.Health === null || Array.isArray(status.Health)) &&
    !hasDerpWarning(status)
  );
}

export function defaultHostname(env: NodeJS.ProcessEnv = process.env): string {
  return `${detectHost(env)}-cloud-${randomBytes(2).toString("hex")}`;
}

export async function connect(options: ConnectOptions = {}): Promise<Connection> {
  const env = options.env ?? process.env;
  const paths = await ensurePaths(env);
  const local = await findInstalled(paths);
  let config = await readConfig(paths);
  let client = local ? new TailscaleClient(local, paths, env) : undefined;
  let status: TailscaleStatus | undefined;
  const daemonRunning = await isRunning(paths);
  if (client && daemonRunning) {
    status = await client.statusJson();
    if (connected(status, await hasConnectedDerp(paths.logFile))) {
      config ??= {
        version: client.installation.version,
        mode: status.TUN ? "kernel" : "userspace",
        hostname: status.Self?.HostName ?? "unknown",
        proxyPort: 1055,
      };
      return {
        paths,
        installation: client.installation,
        client,
        config,
        status,
        alreadyConnected: true,
      };
    }
  }
  const key = getAuthKey(env);
  if (!key) {
    throw new CtError(
      "AUTH_KEY_MISSING",
      "No Tailscale auth key is configured.",
      "Create a reusable, ephemeral, pre-approved, tagged auth key in the Tailscale admin console, limit its tag with ACLs, and add TS_AUTHKEY (or TAILSCALE_AUTHKEY) to the environment's secrets. Then run cloud-tailscale up. Never paste the key into chat or command arguments.",
    );
  }
  const mode = await selectMode(options.mode);
  const version = options.version ?? env.CLOUD_TAILSCALE_VERSION;
  // New daemons start a fresh log; reused daemons retain earlier join failures.
  let logStartOffset = 0;
  if (
    !client ||
    !daemonRunning ||
    !config ||
    config.mode !== mode ||
    (version !== undefined && config.version !== version) ||
    config.version !== client.installation.version
  ) {
    const wanted = await ensureInstalled({ paths, version, env });
    if (daemonRunning) await stop(paths);
    config = await start(paths, wanted, {
      mode,
      hostname: options.hostname ?? defaultHostname(env),
      env,
    });
    client = new TailscaleClient(wanted, paths, env);
    status = undefined;
  } else {
    try {
      logStartOffset = (await stat(paths.logFile)).size;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  const keyDir = await mkdtemp(join(paths.runDir, ".auth-"));
  const keyFile = join(keyDir, "key");
  let cliText = "";
  let joinFailed = false;
  let timedOut = false;
  try {
    await writeFile(keyFile, key, { mode: 0o600, flag: "wx" });
    try {
      const result = await client.up({
        keyFile,
        hostname: options.hostname ?? config.hostname,
        acceptRoutes: options.acceptRoutes,
        timeoutMs,
      });
      cliText = `${result.stdout}\n${result.stderr}`;
      joinFailed = result.exitCode !== 0 || /To authenticate, visit:/i.test(cliText);
    } catch (cause) {
      if (cause instanceof CtError && cause.code === "PROCESS_TIMEOUT") {
        timedOut = true;
      } else {
        throw cause;
      }
    }
  } finally {
    // The credential file is gone before status/DERP polling starts, on every join outcome.
    await rm(keyDir, { recursive: true, force: true });
  }
  if (joinFailed || timedOut) {
    status = await client
      .statusJson(Math.max(1, Math.min(5_000, deadline - Date.now())))
      .catch(() => status);
    throw diagnose(`${cliText}\n${await readLogTail(paths.logFile, logStartOffset)}`, status);
  }
  while (Date.now() < deadline) {
    status = await client
      .statusJson(Math.max(1, Math.min(5_000, deadline - Date.now())))
      .catch(() => status);
    if (status && connected(status, await hasConnectedDerp(paths.logFile))) {
      return {
        paths,
        installation: client.installation,
        client,
        config,
        status,
        alreadyConnected: false,
      };
    }
    if (status?.BackendState === "NeedsMachineAuth") break;
    await delay(Math.max(0, Math.min(options.pollIntervalMs ?? 250, deadline - Date.now())));
  }
  throw diagnose(`${cliText}\n${await readLogTail(paths.logFile, logStartOffset)}`, status);
}

/** Used by connection-dependent commands; connect is already idempotent. */
export async function ensureConnected(options: ConnectOptions = {}): Promise<Connection> {
  return connect(options);
}
