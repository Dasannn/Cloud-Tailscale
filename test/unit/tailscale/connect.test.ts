import { appendFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CtError } from "../../../src/core/errors.js";
import { clearSecrets, mask } from "../../../src/core/output.js";
import { ensurePaths, type RuntimePaths } from "../../../src/core/paths.js";
import { TailscaleClient, type TailscaleStatus } from "../../../src/tailscale/client.js";
import {
  connect,
  connected,
  defaultHostname,
  ensureConnected,
} from "../../../src/tailscale/connect.js";
import { isRunning, readConfig, selectMode, start, stop } from "../../../src/tailscale/daemon.js";
import { ensureInstalled, findInstalled } from "../../../src/tailscale/install.js";
import { hasConnectedDerp } from "../../../src/tailscale/log.js";

const mocks = vi.hoisted(() => ({ up: vi.fn(), statusJson: vi.fn() }));
vi.mock("../../../src/tailscale/client.js", async (original) => ({
  ...(await original<typeof import("../../../src/tailscale/client.js")>()),
  TailscaleClient: vi.fn(
    class {
      constructor(
        readonly installation: unknown,
        readonly paths: unknown,
      ) {}
      up = mocks.up;
      statusJson = mocks.statusJson;
    },
  ),
}));
vi.mock("../../../src/tailscale/daemon.js", () => ({
  isRunning: vi.fn(),
  readConfig: vi.fn(),
  selectMode: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("../../../src/tailscale/install.js", () => ({
  ensureInstalled: vi.fn(),
  findInstalled: vi.fn(),
}));

vi.mock("../../../src/tailscale/log.js", () => ({ hasConnectedDerp: vi.fn() }));

let temp: string;
let paths: RuntimePaths;
let running: TailscaleStatus;
const installation = {
  version: "1.104.1",
  directory: "/FAKE/bin",
  tailscale: "/FAKE/bin/tailscale",
  tailscaled: "/FAKE/bin/tailscaled",
};
const config = {
  version: "1.104.1",
  mode: "userspace",
  hostname: "claude-cloud-3f9a",
  proxyPort: 1055,
} as const;
let env: NodeJS.ProcessEnv;
const success = { stdout: "", stderr: "", exitCode: 0, signal: null };

beforeEach(async () => {
  vi.resetAllMocks();
  temp = await mkdtemp("/tmp/cts-connect-test-");
  env = { CLOUD_TAILSCALE_HOME: temp, TS_AUTHKEY: "tskey-auth-FAKE", CLAUDECODE: "1" };
  paths = await ensurePaths(env);
  running = JSON.parse(
    await readFile(
      new URL("../../fixtures/tailscale/status-running.json", import.meta.url),
      "utf8",
    ),
  );
  vi.mocked(findInstalled).mockResolvedValue(undefined);
  vi.mocked(ensureInstalled).mockResolvedValue(installation);
  vi.mocked(isRunning).mockResolvedValue(false);
  vi.mocked(readConfig).mockResolvedValue(undefined);
  vi.mocked(selectMode).mockResolvedValue("userspace");
  vi.mocked(start).mockResolvedValue(config);
  vi.mocked(hasConnectedDerp).mockResolvedValue(true);
  mocks.up.mockResolvedValue(success);
  mocks.statusJson.mockResolvedValue(running);
});
afterEach(async () => {
  clearSecrets();
  vi.restoreAllMocks();
  await rm(temp, { recursive: true, force: true });
});

describe("ephemeral tailnet join", () => {
  it("joins using a private temporary key file and deletes it before DERP polling", async () => {
    let keyFile = "";
    mocks.up.mockImplementation(async (options) => {
      keyFile = options.keyFile;
      expect(await readFile(keyFile, "utf8")).toBe("tskey-auth-FAKE");
      expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
      expect((await stat(keyFile.slice(0, keyFile.lastIndexOf("/")))).mode & 0o777).toBe(0o700);
      expect(options).toMatchObject({ hostname: "FAKE-agent", acceptRoutes: true });
      return success;
    });
    mocks.statusJson.mockImplementation(async () => {
      await expect(stat(keyFile)).rejects.toMatchObject({ code: "ENOENT" });
      return running;
    });
    const result = await connect({
      env,
      hostname: "FAKE-agent",
      acceptRoutes: true,
      mode: "userspace",
      version: "1.104.1",
    });
    expect(result).toMatchObject({ alreadyConnected: false, status: running, config });
    expect(selectMode).toHaveBeenCalledWith("userspace");
    expect(ensureInstalled).toHaveBeenCalledWith({ paths, version: "1.104.1", env });
    expect(JSON.stringify(mocks.up.mock.calls)).not.toContain("tskey-auth-FAKE");
    expect(await readdir(paths.runDir)).toEqual(["state"]);
    expect(mask("tskey-auth-FAKE")).toBe("[REDACTED]");
  });
  it("reports an existing Running + DERP connection without requiring an auth key or network", async () => {
    delete env.TS_AUTHKEY;
    vi.mocked(findInstalled).mockResolvedValue(installation);
    vi.mocked(isRunning).mockResolvedValue(true);
    vi.mocked(readConfig).mockResolvedValue(config);
    expect(await connect({ env })).toMatchObject({
      alreadyConnected: true,
      config,
      status: running,
    });
    expect(ensureInstalled).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(mocks.up).not.toHaveBeenCalled();
  });
  it("fails with human configuration instructions before downloading when no key is set", async () => {
    delete env.TS_AUTHKEY;
    await expect(connect({ env })).rejects.toMatchObject({
      code: "AUTH_KEY_MISSING",
      next: expect.stringMatching(/reusable, ephemeral, pre-approved, tagged.*TS_AUTHKEY/),
    });
    expect(ensureInstalled).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
  describe.each(["stopped", "logged out", "relay disconnected", "unreadable status"])(
    "automatic connection when %s",
    (state) => {
      beforeEach(() => {
        if (state === "stopped") return;
        vi.mocked(findInstalled).mockResolvedValue(installation);
        vi.mocked(isRunning).mockResolvedValue(true);
        vi.mocked(readConfig).mockResolvedValue(config);
        if (state === "logged out") {
          mocks.statusJson.mockResolvedValueOnce({ BackendState: "NeedsLogin" });
        } else if (state === "relay disconnected") {
          vi.mocked(hasConnectedDerp).mockResolvedValueOnce(false);
        } else {
          mocks.statusJson.mockRejectedValueOnce(
            new CtError("DAEMON_UNAVAILABLE", "FAKE stale socket.", "Run up."),
          );
        }
      });
      it("runs up with an available key", async () => {
        const result = await ensureConnected({ env, pollIntervalMs: 1 });
        expect(result).toMatchObject({ alreadyConnected: false, status: running });
        expect(mocks.up).toHaveBeenCalledOnce();
      });
      it("reports AUTH_KEY_MISSING without a key", async () => {
        delete env.TS_AUTHKEY;
        await expect(ensureConnected({ env })).rejects.toMatchObject({ code: "AUTH_KEY_MISSING" });
        expect(mocks.up).not.toHaveBeenCalled();
        expect(ensureInstalled).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
      });
    },
  );
  it("uses the fallback key variable and the host agent in the default hostname", async () => {
    delete env.TS_AUTHKEY;
    env.TAILSCALE_AUTHKEY = "tskey-auth-FAKE-fallback";
    mocks.up.mockImplementation(async ({ keyFile }) => {
      expect(await readFile(keyFile, "utf8")).toBe("tskey-auth-FAKE-fallback");
      return success;
    });
    await ensureConnected({ env });
    expect(start).toHaveBeenCalledWith(
      paths,
      installation,
      expect.objectContaining({ hostname: expect.stringMatching(/^claude-cloud-[0-9a-f]{4}$/) }),
    );
    expect(TailscaleClient).toHaveBeenCalledWith(installation, paths, env);
  });
  it("uses a cached daemon's version and joins it without starting a second daemon", async () => {
    vi.mocked(findInstalled).mockResolvedValue(installation);
    vi.mocked(isRunning).mockResolvedValue(true);
    vi.mocked(readConfig).mockResolvedValue(config);
    mocks.statusJson
      .mockResolvedValueOnce({ BackendState: "NeedsLogin" })
      .mockResolvedValue(running);
    await connect({ env });
    expect(start).not.toHaveBeenCalled();
    expect(ensureInstalled).not.toHaveBeenCalled();
    expect(mocks.up).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });
  it.each(["kernel", "userspace"] as const)(
    "restarts an unconnected daemon to force %s mode",
    async (mode) => {
      vi.mocked(findInstalled).mockResolvedValue(installation);
      vi.mocked(isRunning).mockResolvedValue(true);
      vi.mocked(readConfig).mockResolvedValue({
        ...config,
        mode: mode === "kernel" ? "userspace" : "kernel",
      });
      vi.mocked(selectMode).mockResolvedValue(mode);
      vi.mocked(start).mockResolvedValue({ ...config, mode });
      mocks.statusJson
        .mockResolvedValueOnce({ BackendState: "NeedsLogin" })
        .mockResolvedValue(running);
      expect((await connect({ env, mode })).config.mode).toBe(mode);
      expect(ensureInstalled).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledExactlyOnceWith(paths);
      expect(start).toHaveBeenCalledWith(paths, installation, expect.objectContaining({ mode }));
      expect(vi.mocked(stop).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(start).mock.invocationCallOrder[0],
      );
    },
  );
  it.each(["option", "environment", "option-overrides-environment"])(
    "restarts an unconnected daemon for a version pin from %s",
    async (source) => {
      const version = "1.106.0";
      const wanted = {
        ...installation,
        version,
        directory: "/FAKE/new",
        tailscale: "/FAKE/new/tailscale",
        tailscaled: "/FAKE/new/tailscaled",
      };
      vi.mocked(findInstalled).mockResolvedValue(installation);
      vi.mocked(isRunning).mockResolvedValue(true);
      vi.mocked(readConfig).mockResolvedValue(config);
      vi.mocked(ensureInstalled).mockResolvedValue(wanted);
      vi.mocked(start).mockResolvedValue({ ...config, version });
      mocks.statusJson
        .mockResolvedValueOnce({ BackendState: "NeedsLogin" })
        .mockResolvedValue(running);
      if (source !== "option")
        env.CLOUD_TAILSCALE_VERSION = source === "environment" ? version : "1.102.0";
      const result = await connect({
        env,
        version: source === "environment" ? undefined : version,
      });
      expect(result.installation).toEqual(wanted);
      expect(result.config.version).toBe(version);
      expect(ensureInstalled).toHaveBeenCalledWith({ paths, version, env });
      expect(stop).toHaveBeenCalledExactlyOnceWith(paths);
      expect(start).toHaveBeenCalledWith(
        paths,
        wanted,
        expect.objectContaining({ mode: "userspace" }),
      );
      expect(TailscaleClient).toHaveBeenLastCalledWith(wanted, paths, env);
    },
  );
  it("restarts an unconnected daemon whose runtime configuration is missing", async () => {
    vi.mocked(findInstalled).mockResolvedValue(installation);
    vi.mocked(isRunning).mockResolvedValue(true);
    mocks.statusJson
      .mockResolvedValueOnce({ BackendState: "NeedsLogin" })
      .mockResolvedValue(running);
    await connect({ env });
    expect(stop).toHaveBeenCalledExactlyOnceWith(paths);
    expect(start).toHaveBeenCalledOnce();
  });
  it("waits for Running plus a home DERP and an online control connection", async () => {
    mocks.statusJson
      .mockResolvedValueOnce({ BackendState: "Starting" })
      .mockResolvedValueOnce({ ...running, Self: { ...running.Self, Relay: "" } })
      .mockResolvedValueOnce({ ...running, Self: { ...running.Self, Online: false } })
      .mockResolvedValue(running);
    expect((await connect({ env, pollIntervalMs: 1 })).status).toEqual(running);
    expect(mocks.statusJson).toHaveBeenCalledTimes(4);
  });
  it("removes the credential before classifying rejected keys or interactive-login requests", async () => {
    const login = await readFile(
      new URL("../../fixtures/tailscale/login-required.txt", import.meta.url),
      "utf8",
    );
    mocks.up.mockResolvedValue({ ...success, stderr: login });
    mocks.statusJson.mockResolvedValue({ BackendState: "NeedsLogin" });
    await expect(connect({ env })).rejects.toMatchObject({ code: "AUTH_KEY_REJECTED" });
    expect(await readdir(paths.runDir)).toEqual(["state"]);
    mocks.up.mockResolvedValue({
      ...success,
      exitCode: 1,
      stderr: "auth key expired: tskey-auth-FAKE",
    });
    await expect(connect({ env })).rejects.toMatchObject({
      code: "AUTH_KEY_REJECTED",
      message: expect.not.stringContaining("tskey-"),
    });
    expect(await readdir(paths.runDir)).toEqual(["state"]);
  });
  it("removes the key file after process exceptions", async () => {
    mocks.up.mockRejectedValue(new CtError("PROCESS_FAILED", "FAKE failed", "Retry."));
    await expect(connect({ env })).rejects.toMatchObject({ code: "PROCESS_FAILED" });
    expect(await readdir(paths.runDir)).toEqual(["state"]);
  });
  it.each(["CLI failure", "CLI timeout", "polling timeout"])(
    "ignores a previous key rejection after replacing the key (%s)",
    async (failure) => {
      vi.mocked(findInstalled).mockResolvedValue(installation);
      vi.mocked(isRunning).mockResolvedValue(true);
      vi.mocked(readConfig).mockResolvedValue(config);
      vi.mocked(hasConnectedDerp).mockResolvedValue(false);
      mocks.statusJson.mockResolvedValue({ BackendState: "NeedsLogin" });
      const rejected = "control: auth key rejected\n";
      mocks.up.mockImplementationOnce(async () => {
        await appendFile(paths.logFile, rejected);
        return { ...success, exitCode: 1 };
      });
      await expect(connect({ env })).rejects.toMatchObject({ code: "AUTH_KEY_REJECTED" });

      env.TS_AUTHKEY = "tskey-auth-FAKE-replacement";
      const derpFailure = "derp.Recv(derp-1): proxyconnect tcp: connection refused\n";
      mocks.up.mockImplementationOnce(async ({ keyFile }) => {
        expect(await readFile(keyFile, "utf8")).toBe(env.TS_AUTHKEY);
        await appendFile(paths.logFile, derpFailure);
        mocks.statusJson.mockResolvedValue(running);
        if (failure === "CLI timeout") {
          throw new CtError("PROCESS_TIMEOUT", "FAKE timeout", "Retry.");
        }
        return { ...success, exitCode: failure === "CLI failure" ? 1 : 0 };
      });
      await expect(connect({ env, timeoutMs: 25, pollIntervalMs: 1 })).rejects.toMatchObject({
        code: "DERP_UNREACHABLE",
      });
      expect(await readFile(paths.logFile, "utf8")).toBe(rejected + derpFailure);
      expect(mocks.up).toHaveBeenCalledTimes(2);
      expect(start).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(ensureInstalled).not.toHaveBeenCalled();
    },
  );
  it("uses the log tail to diagnose a CLI timeout", async () => {
    await writeFile(paths.logFile, "control: proxyconnect tcp: connection refused");
    mocks.up.mockRejectedValue(new CtError("PROCESS_TIMEOUT", "FAKE timeout", "Retry."));
    mocks.statusJson.mockResolvedValue({ BackendState: "Starting" });
    await expect(connect({ env })).rejects.toMatchObject({ code: "CONTROL_UNREACHABLE" });
    expect(await readdir(paths.runDir)).toEqual(["state", "tailscaled.log"]);
  });
  it("reports DERP_UNREACHABLE on the bounded join timeout", async () => {
    mocks.statusJson.mockResolvedValue({ ...running, Self: { ...running.Self, Relay: "" } });
    await expect(connect({ env, timeoutMs: 25, pollIntervalMs: 5 })).rejects.toMatchObject({
      code: "DERP_UNREACHABLE",
    });
  });
  it.each([false, true])(
    "rejects an assigned but unreachable relay (existing daemon: %s)",
    async (existing) => {
      vi.mocked(findInstalled).mockResolvedValue(existing ? installation : undefined);
      vi.mocked(isRunning).mockResolvedValue(existing);
      vi.mocked(readConfig).mockResolvedValue(existing ? config : undefined);
      mocks.statusJson.mockResolvedValue({
        ...running,
        Health: [
          "Tailscale could not connect to the 'New York City' relay server. Your Internet connection might be down, or the server might be temporarily unavailable.",
        ],
      });
      await writeFile(
        paths.logFile,
        "derp.Recv(derp-1): derphttp.Client.Recv: proxyconnect tcp: connection refused",
      );
      await expect(connect({ env, timeoutMs: 25, pollIntervalMs: 1 })).rejects.toMatchObject({
        code: "DERP_UNREACHABLE",
      });
      expect(mocks.up).toHaveBeenCalledOnce();
    },
  );
  it.each([false, true])(
    "does not trust an assigned relay before health warnings are visible (existing: %s)",
    async (existing) => {
      vi.mocked(findInstalled).mockResolvedValue(existing ? installation : undefined);
      vi.mocked(isRunning).mockResolvedValue(existing);
      vi.mocked(readConfig).mockResolvedValue(existing ? config : undefined);
      vi.mocked(hasConnectedDerp).mockResolvedValue(false);
      mocks.statusJson.mockResolvedValue(running);
      await expect(connect({ env, timeoutMs: 25, pollIntervalMs: 1 })).rejects.toMatchObject({
        code: "DERP_UNREACHABLE",
      });
      expect(mocks.up).toHaveBeenCalledOnce();
    },
  );
  it.each(["option", "environment"])(
    "reuses an unconnected daemon that matches the %s version pin",
    async (source) => {
      vi.mocked(findInstalled).mockResolvedValue(installation);
      vi.mocked(isRunning).mockResolvedValue(true);
      vi.mocked(readConfig).mockResolvedValue(config);
      mocks.statusJson
        .mockResolvedValueOnce({ BackendState: "NeedsLogin" })
        .mockResolvedValue(running);
      if (source === "environment") env.CLOUD_TAILSCALE_VERSION = installation.version;
      await connect({ env, version: source === "option" ? installation.version : undefined });
      expect(ensureInstalled).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(mocks.up).toHaveBeenCalledOnce();
    },
  );
  it("waits for a confirmed DERP handshake before reporting success", async () => {
    vi.mocked(hasConnectedDerp).mockResolvedValueOnce(false).mockResolvedValue(true);
    expect((await connect({ env, pollIntervalMs: 1 })).alreadyConnected).toBe(false);
    expect(mocks.statusJson).toHaveBeenCalledTimes(2);
  });
  it("classifies device approval without waiting for the entire deadline", async () => {
    mocks.statusJson.mockResolvedValue({ BackendState: "NeedsMachineAuth" });
    await expect(connect({ env })).rejects.toMatchObject({
      code: "AUTH_KEY_REJECTED",
      next: expect.stringContaining("Approve the device"),
    });
  });
  it("fails a forced unavailable kernel mode before installation", async () => {
    vi.mocked(selectMode).mockRejectedValue(
      new CtError("KERNEL_MODE_UNAVAILABLE", "FAKE kernel unavailable", "Use userspace."),
    );
    await expect(connect({ env, mode: "kernel" })).rejects.toMatchObject({
      code: "KERNEL_MODE_UNAVAILABLE",
    });
    expect(ensureInstalled).not.toHaveBeenCalled();
  });
  it("derives each default hostname and rejects incomplete connected states", () => {
    expect(defaultHostname({ CODEX_THREAD_ID: "FAKE" })).toMatch(/^codex-cloud-[0-9a-f]{4}$/);
    expect(defaultHostname({})).toMatch(/^local-cloud-[0-9a-f]{4}$/);
    expect(connected({ BackendState: "Starting" }, true)).toBe(false);
    expect(connected({ BackendState: "Running" }, true)).toBe(false);
    expect(connected(running, true)).toBe(true);
    expect(connected(running, false)).toBe(false);
    expect(connected({ ...running, Health: undefined }, true)).toBe(false);
    expect(connected({ ...running, Health: null }, true)).toBe(true);
    expect(connected({ ...running, Health: ["not connected to home DERP region 1"] }, true)).toBe(
      false,
    );
    expect(connected({ ...running, Health: ["An update is available."] }, true)).toBe(true);
  });
});
