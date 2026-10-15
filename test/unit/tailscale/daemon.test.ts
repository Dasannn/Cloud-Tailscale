import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRoot, tunUsable } from "../../../src/core/host.js";
import { ensurePaths, type RuntimePaths } from "../../../src/core/paths.js";
import {
  daemonEnvironment,
  isRunning,
  readConfig,
  selectMode,
  start,
  stop,
} from "../../../src/tailscale/daemon.js";
import { spawnLoggedDaemon } from "../../../src/tailscale/log.js";

vi.mock("../../../src/core/host.js", () => ({ isRoot: vi.fn(), tunUsable: vi.fn() }));
vi.mock("../../../src/tailscale/log.js", () => ({ spawnLoggedDaemon: vi.fn() }));
vi.mock("node:net", () => ({ createConnection: vi.fn() }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), access: vi.fn(actual.access) };
});

let temp: string;
let paths: RuntimePaths;
let answering: boolean;
let pidAlive: boolean;
let commandLine: string;
const pid = 424242;
let kill: ReturnType<typeof vi.spyOn>;
const installation = {
  version: "1.104.1",
  directory: "/FAKE/bin",
  tailscale: "/FAKE/bin/tailscale",
  tailscaled: "/FAKE/bin/tailscaled",
};
const missing = () => Object.assign(new Error("FAKE missing"), { code: "ENOENT" });

beforeEach(async () => {
  vi.clearAllMocks();
  temp = await mkdtemp("/tmp/cts-daemon-test-");
  paths = await ensurePaths({ CLOUD_TAILSCALE_HOME: temp });
  answering = false;
  pidAlive = true;
  commandLine = `${installation.tailscaled}\0--socket=${paths.socketFile}\0`;
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(readFile).mockImplementation((...args) => {
    if (String(args[0]) === `/proc/${pid}/cmdline`)
      return Promise.resolve(commandLine) as ReturnType<typeof readFile>;
    return actual.readFile(...args);
  });
  vi.mocked(access).mockImplementation((...args) => {
    if (String(args[0]) === "/root/.ccr/ca-bundle.crt") return Promise.reject(missing());
    return actual.access(...args);
  });
  vi.mocked(createConnection).mockImplementation(() => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
    queueMicrotask(() =>
      socket.emit(answering ? "connect" : "error", new Error("FAKE socket absent")),
    );
    return socket as unknown as ReturnType<typeof createConnection>;
  });
  vi.mocked(spawnLoggedDaemon).mockImplementation(async () => {
    await writeFile(paths.socketFile, "FAKE socket");
    answering = true;
    return pid;
  });
  kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (!pidAlive) throw Object.assign(new Error("FAKE exited"), { code: "ESRCH" });
    if (signal === "SIGTERM" || signal === "SIGKILL") {
      answering = false;
      pidAlive = false;
    }
    return true;
  });
  vi.mocked(isRoot).mockReturnValue(false);
  vi.mocked(tunUsable).mockResolvedValue(false);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await rm(temp, { recursive: true, force: true });
});

describe("private ephemeral daemon", () => {
  it("selects kernel only for root with usable TUN; explicit kernel fails clearly", async () => {
    expect(await selectMode()).toBe("userspace");
    expect(tunUsable).not.toHaveBeenCalled();
    await expect(selectMode("kernel")).rejects.toMatchObject({ code: "KERNEL_MODE_UNAVAILABLE" });
    vi.mocked(isRoot).mockReturnValue(true);
    expect(await selectMode()).toBe("userspace");
    vi.mocked(tunUsable).mockResolvedValue(true);
    expect(await selectMode()).toBe("kernel");
    expect(await selectMode("userspace")).toBe("userspace");
  });
  it("checks whether the socket answers, including timeout", async () => {
    expect(await isRunning(paths)).toBe(false);
    answering = true;
    expect(await isRunning(paths)).toBe(true);
    vi.mocked(createConnection).mockImplementationOnce(() => {
      const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
      queueMicrotask(() => socket.emit("timeout"));
      return socket as unknown as ReturnType<typeof createConnection>;
    });
    expect(await isRunning(paths)).toBe(false);
  });
  it("starts detached with mem state, private files, loopback listeners, proxy and preferred CA", async () => {
    const ca = join(temp, "proxy-ca.crt");
    await writeFile(ca, "FAKE certificate");
    const env = {
      HTTPS_PROXY: "http://proxy.example:8080",
      NO_PROXY: "localhost",
      SSL_CERT_FILE: ca,
      NODE_EXTRA_CA_CERTS: "/FAKE-other",
      TS_AUTHKEY: "tskey-auth-FAKE",
    };
    const config = await start(paths, installation, {
      mode: "userspace",
      hostname: "claude-cloud-abcd",
      env,
    });
    expect(spawnLoggedDaemon).toHaveBeenCalledExactlyOnceWith(
      installation.tailscaled,
      [
        "--state=mem:",
        "--no-logs-no-support",
        "--verbose=0",
        `--statedir=${paths.stateDir}`,
        `--socket=${paths.socketFile}`,
        "--socks5-server=127.0.0.1:1055",
        "--outbound-http-proxy-listen=127.0.0.1:1055",
        "--tun=userspace-networking",
      ],
      expect.objectContaining({
        logFile: paths.logFile,
        env: expect.objectContaining({
          HTTPS_PROXY: env.HTTPS_PROXY,
          NO_PROXY: "localhost",
          SSL_CERT_FILE: ca,
          TS_AUTHKEY: undefined,
        }),
      }),
    );
    for (const file of [paths.pidFile, paths.logFile, paths.socketFile, paths.configFile])
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readConfig(paths)).toEqual(config);
    expect(await readFile(paths.configFile, "utf8")).not.toContain("tskey-");
    expect(await start(paths, installation, { mode: "kernel", hostname: "ignored" })).toEqual(
      config,
    );
    expect(spawnLoggedDaemon).toHaveBeenCalledOnce();
  });
  it("maps NODE_EXTRA_CA_CERTS into SSL_CERT_FILE and preserves the provider egress settings", async () => {
    const ca = join(temp, "extra.crt");
    await writeFile(ca, "FAKE certificate");
    expect(
      await daemonEnvironment({
        NODE_EXTRA_CA_CERTS: ca,
        https_proxy: "http://proxy.example:8080",
      }),
    ).toMatchObject({ SSL_CERT_FILE: ca, https_proxy: "http://proxy.example:8080" });
  });
  it("uses the verified cloud CA location as a fallback only when available", async () => {
    vi.mocked(access).mockResolvedValue(undefined);
    expect(await daemonEnvironment({})).toMatchObject({
      SSL_CERT_FILE: "/root/.ccr/ca-bundle.crt",
    });
  });
  it("removes every inherited and supplied TS_DEBUG setting while keeping authenticated proxies", async () => {
    vi.stubEnv("TS_DEBUG_REGISTER", "1");
    vi.stubEnv("TS_DEBUG_FAKE_INHERITED", "1");
    const proxy = "http://FAKE-user:FAKE-password@proxy.example:8080";
    try {
      const env = await daemonEnvironment({
        TS_DEBUG_NETMAP: "1",
        TS_DEBUG_FAKE_SUPPLIED: "1",
        HTTPS_PROXY: proxy,
      });
      expect(Object.keys(env).filter((name) => name.startsWith("TS_DEBUG_"))).toEqual([]);
      expect(env.HTTPS_PROXY).toBe(proxy);
      await start(paths, installation, {
        mode: "userspace",
        hostname: "FAKE-agent",
        env: { TS_AUTHKEY: "FAKE-arbitrary-key", TS_SSH_PASSWORD: "FAKE-ssh-password" },
      });
      const options = vi.mocked(spawnLoggedDaemon).mock.calls[0][2];
      expect(options.secrets).toEqual(
        expect.arrayContaining(["FAKE-arbitrary-key", "FAKE-ssh-password"]),
      );
      expect(Object.keys(options.env).filter((name) => name.startsWith("TS_DEBUG_"))).toEqual([]);
      expect(options.env.TS_AUTHKEY).toBeUndefined();
      expect(options.env.TS_SSH_PASSWORD).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("omits the userspace TUN flag in kernel mode", async () => {
    await start(paths, installation, { mode: "kernel", hostname: "local-cloud-abcd", env: {} });
    expect(vi.mocked(spawnLoggedDaemon).mock.calls[0][1]).not.toContain(
      "--tun=userspace-networking",
    );
  });
  it("stops an owned daemon with SIGTERM and removes runtime state", async () => {
    await start(paths, installation, { mode: "userspace", hostname: "local-cloud-abcd", env: {} });
    await stop(paths);
    expect(kill).toHaveBeenCalledWith(pid, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(pid, "SIGKILL");
    await expect(stat(paths.pidFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("escalates to SIGKILL for an unresponsive owned daemon", async () => {
    await writeFile(paths.pidFile, String(pid));
    kill.mockImplementation((_pid: number, signal: string) => {
      if (signal === "SIGKILL") {
        pidAlive = false;
        answering = false;
      }
      if (!pidAlive && signal === 0)
        throw Object.assign(new Error("FAKE exited"), { code: "ESRCH" });
      return true;
    });
    await stop(paths, 0);
    expect(kill).toHaveBeenCalledWith(pid, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(pid, "SIGKILL");
  });
  it("never signals a recycled PID or the current process; down with no daemon succeeds", async () => {
    commandLine = "/usr/bin/FAKE-unrelated\0";
    await writeFile(paths.pidFile, String(pid));
    await stop(paths);
    expect(kill).not.toHaveBeenCalled();
    await writeFile(paths.pidFile, String(process.pid));
    await stop(paths);
    expect(kill).not.toHaveBeenCalled();
    await stop(paths);
  });
  it("cleans up a daemon that exits before opening its socket", async () => {
    vi.mocked(spawnLoggedDaemon).mockResolvedValue(pid);
    pidAlive = false;
    await expect(
      start(paths, installation, { mode: "userspace", hostname: "FAKE" }),
    ).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
    await expect(stat(paths.pidFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("tolerates absent or malformed config without treating it as a running daemon", async () => {
    expect(await readConfig(paths)).toBeUndefined();
    await writeFile(paths.configFile, "{");
    expect(await readConfig(paths)).toBeUndefined();
    await writeFile(paths.configFile, "null");
    expect(await readConfig(paths)).toBeUndefined();
    await writeFile(
      paths.configFile,
      '{"version":"1.104.1","mode":"userspace","hostname":"FAKE","proxyPort":65536}',
    );
    expect(await readConfig(paths)).toBeUndefined();
  });
  it("stops a previous owned process whose socket has disappeared before starting again", async () => {
    await writeFile(paths.pidFile, String(pid));
    await start(paths, installation, { mode: "userspace", hostname: "FAKE-agent", env: {} });
    expect(kill).toHaveBeenCalledWith(pid, "SIGTERM");
    expect(kill.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(spawnLoggedDaemon).mock.invocationCallOrder[0],
    );
    expect((await stat(paths.stateDir)).mode & 0o777).toBe(0o700);
  });
});
