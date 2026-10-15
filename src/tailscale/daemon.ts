import { constants } from "node:fs";
import { access, chmod, open, readFile, rename, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { CtError } from "../core/errors.js";
import { isRoot, tunUsable } from "../core/host.js";
import { createPrivateDir, type RuntimePaths } from "../core/paths.js";
import { childEnvironment } from "./client.js";
import type { Installation } from "./install.js";
import { spawnLoggedDaemon } from "./log.js";

export type NetworkingMode = "kernel" | "userspace";
export type ModeOption = "auto" | NetworkingMode;

export interface DaemonConfig {
  version: string;
  mode: NetworkingMode;
  hostname: string;
  proxyPort: number;
}

export async function selectMode(mode: ModeOption = "auto"): Promise<NetworkingMode> {
  if (mode === "userspace") return mode;
  const kernelAvailable = isRoot() && (await tunUsable());
  if (mode === "kernel" && !kernelAvailable) {
    throw new CtError(
      "KERNEL_MODE_UNAVAILABLE",
      "Kernel networking requires root and a usable /dev/net/tun device.",
      "Run cloud-tailscale up --mode userspace (or --mode auto) in this container.",
    );
  }
  return kernelAvailable ? "kernel" : "userspace";
}

export async function readConfig(paths: RuntimePaths): Promise<DaemonConfig | undefined> {
  try {
    const value: DaemonConfig = JSON.parse(await readFile(paths.configFile, "utf8"));
    if (
      value &&
      typeof value.version === "string" &&
      /^\d+\.\d+\.\d+$/.test(value.version) &&
      (value.mode === "kernel" || value.mode === "userspace") &&
      typeof value.hostname === "string" &&
      Number.isInteger(value.proxyPort) &&
      value.proxyPort > 0 &&
      value.proxyPort <= 65535
    ) {
      return value;
    }
  } catch (cause) {
    if (!(cause instanceof SyntaxError) && (cause as NodeJS.ErrnoException).code !== "ENOENT") {
      throw cause;
    }
  }
  return undefined;
}

async function writePrivate(path: string, value: string): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.chmod(0o600);
    await file.writeFile(value);
  } finally {
    await file.close();
  }
}

/** A responding Unix socket is the source of truth, rather than a stale PID file. */
export function isRunning(paths: RuntimePaths): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: paths.socketFile });
    const finish = (running: boolean) => {
      socket.destroy();
      resolve(running);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function daemonEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const child = childEnvironment({ ...process.env, ...env });
  // Diagnostics such as TS_DEBUG_REGISTER can dump auth keys and registration payloads.
  for (const name of Object.keys(child)) {
    if (name.startsWith("TS_DEBUG_")) delete child[name];
  }
  // Go honors HTTPS_PROXY itself, but does not read Node's extra-CA variable.
  for (const bundle of [env.SSL_CERT_FILE, env.NODE_EXTRA_CA_CERTS, "/root/.ccr/ca-bundle.crt"]) {
    if (!bundle) continue;
    try {
      await access(bundle, constants.R_OK);
      child.SSL_CERT_FILE = bundle;
      break;
    } catch {
      // Continue to the next known proxy CA location when a bundle is absent.
    }
  }
  return child;
}

export async function start(
  paths: RuntimePaths,
  installation: Installation,
  options: {
    mode: NetworkingMode;
    hostname: string;
    proxyPort?: number;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<DaemonConfig> {
  if (await isRunning(paths)) {
    const existing = await readConfig(paths);
    if (existing) return existing;
    throw new CtError(
      "DAEMON_UNAVAILABLE",
      "The private socket is already in use without valid daemon configuration.",
      "Run cloud-tailscale down before starting a new daemon.",
    );
  }
  const config: DaemonConfig = {
    version: installation.version,
    mode: options.mode,
    hostname: options.hostname,
    proxyPort: options.proxyPort ?? 1055,
  };
  // A previous owned process may still exist even when its socket no longer answers.
  await stop(paths);
  await createPrivateDir(paths.stateDir);
  // Discard logs from previous sessions so diagnostics describe this startup.
  await writePrivate(paths.logFile, "");
  await rm(paths.socketFile, { force: true });
  const listener = `127.0.0.1:${config.proxyPort}`;
  const env = { ...process.env, ...options.env };
  const secrets = [
    env.TS_AUTHKEY,
    env.TAILSCALE_AUTHKEY,
    env.TS_SSH_KEY,
    env.TS_SSH_KEY_FILE,
    env.TS_SSH_PASSWORD,
  ].filter((value): value is string => Boolean(value));
  const pid = await spawnLoggedDaemon(
    installation.tailscaled,
    [
      "--state=mem:",
      // Otherwise logtail also keeps an unmasked on-disk buffer outside our writer.
      "--no-logs-no-support",
      "--verbose=0",
      `--statedir=${paths.stateDir}`,
      `--socket=${paths.socketFile}`,
      `--socks5-server=${listener}`,
      `--outbound-http-proxy-listen=${listener}`,
      ...(options.mode === "userspace" ? ["--tun=userspace-networking"] : []),
    ],
    { env: await daemonEnvironment(env), logFile: paths.logFile, secrets },
  );
  await writePrivate(paths.pidFile, `${pid}\n`);
  const temporary = `${paths.configFile}.${pid}.tmp`;
  try {
    await writePrivate(temporary, `${JSON.stringify(config)}\n`);
    await rename(temporary, paths.configFile);
  } finally {
    await rm(temporary, { force: true });
  }
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    if (await isRunning(paths)) {
      await chmod(paths.socketFile, 0o600);
      return config;
    }
    if (!alive(pid)) break;
    await delay(100);
  }
  await stop(paths);
  throw new CtError(
    "DAEMON_UNAVAILABLE",
    "The private Tailscale daemon did not open its control socket.",
    "Check that the loopback proxy port 1055 is free and the selected networking mode is available; retry up --mode userspace.",
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw cause;
  }
}

async function ownedPid(paths: RuntimePaths): Promise<number | undefined> {
  let pid: number;
  try {
    const text = (await readFile(paths.pidFile, "utf8")).trim();
    if (!/^[1-9]\d*$/.test(text)) return undefined;
    pid = Number(text);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return undefined;
    // A recycled PID must never terminate an unrelated process.
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
    if (!argv[0]?.endsWith("/tailscaled") || !argv.includes(`--socket=${paths.socketFile}`)) {
      return undefined;
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  return pid;
}

export async function stop(paths: RuntimePaths, timeoutMs = 3_000): Promise<void> {
  const pid = await ownedPid(paths);
  if (pid !== undefined && alive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + timeoutMs;
      while (alive(pid) && Date.now() < deadline) await delay(50);
      if (alive(pid)) {
        // Check ownership again before escalating after the grace period.
        if ((await ownedPid(paths)) === pid) process.kill(pid, "SIGKILL");
        const killDeadline = Date.now() + 1_000;
        while ((await isRunning(paths)) && Date.now() < killDeadline) await delay(50);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
    }
  }
  if (await isRunning(paths)) {
    throw new CtError(
      "DAEMON_UNAVAILABLE",
      "The private Tailscale daemon is still running and could not be safely stopped.",
      "Check the private daemon PID and socket in CLOUD_TAILSCALE_HOME, then retry down.",
    );
  }
  await rm(paths.pidFile, { force: true });
  await rm(paths.socketFile, { force: true });
  // State is mem:, but remove any auxiliary files from the previous session too.
  await rm(paths.stateDir, { recursive: true, force: true });
}
