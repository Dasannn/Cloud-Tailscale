import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPaths } from "../../../src/core/paths.js";
import { run } from "../../../src/core/proc.js";
import {
  childEnvironment,
  TailscaleClient,
  validateDestination,
} from "../../../src/tailscale/client.js";

vi.mock("../../../src/core/proc.js", () => ({ run: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const paths = getPaths("/tmp/FAKE-cts-home");
const installation = {
  version: "1.104.1",
  directory: "/FAKE/bin",
  tailscale: "/FAKE/bin/tailscale",
  tailscaled: "/FAKE/bin/tailscaled",
};
const env = {
  HTTPS_PROXY: "http://proxy.example:8080",
  TS_AUTHKEY: "tskey-auth-FAKE",
  TS_SSH_PASSWORD: "FAKE-password",
};
const client = new TailscaleClient(installation, paths, env);
const success = { stdout: "", stderr: "", exitCode: 0, signal: null } as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(run).mockResolvedValue({ ...success });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("private Tailscale CLI client", () => {
  it("passes only the credential file path and private socket for up", async () => {
    await client.up({
      keyFile: "/tmp/FAKE-private/key",
      hostname: "claude-cloud-abcd",
      acceptRoutes: true,
      timeoutMs: 1234,
    });
    expect(run).toHaveBeenCalledExactlyOnceWith(
      installation.tailscale,
      [
        `--socket=${paths.socketFile}`,
        "up",
        "--auth-key=file:/tmp/FAKE-private/key",
        "--hostname=claude-cloud-abcd",
        "--timeout=1110ms",
        "--accept-routes",
      ],
      { env: childEnvironment(env), timeoutMs: 1234 },
    );
    expect(JSON.stringify(vi.mocked(run).mock.calls)).not.toContain("tskey-auth-FAKE");
    expect(JSON.stringify(vi.mocked(run).mock.calls)).not.toContain("FAKE-password");
  });
  it("reads recorded status JSON including peers and home DERP", async () => {
    const stdout = await readFile(
      new URL("../../fixtures/tailscale/status-running.json", import.meta.url),
      "utf8",
    );
    vi.mocked(run).mockResolvedValue({ ...success, stdout });
    expect(await client.statusJson()).toMatchObject({
      BackendState: "Running",
      Self: { Relay: "nyc" },
      TUN: false,
    });
    expect(run).toHaveBeenCalledWith(
      installation.tailscale,
      [`--socket=${paths.socketFile}`, "status", "--json"],
      expect.objectContaining({ timeoutMs: 5000 }),
    );
  });
  it("accepts structured and plain-text logged-out states with a nonzero status exit", async () => {
    vi.mocked(run).mockResolvedValueOnce({
      ...success,
      exitCode: 1,
      stdout: '{"BackendState":"NeedsLogin"}',
    });
    expect(await client.statusJson()).toEqual({ BackendState: "NeedsLogin" });
    vi.mocked(run).mockResolvedValueOnce({ ...success, exitCode: 1, stdout: "Logged out.\n" });
    expect(await client.statusJson()).toEqual({ BackendState: "NeedsLogin" });
  });
  it("rejects malformed status and classifies logout failures without copying diagnostics", async () => {
    vi.mocked(run).mockResolvedValueOnce({ ...success, stdout: "FAKE broken JSON" });
    await expect(client.statusJson()).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
    vi.mocked(run).mockResolvedValueOnce({
      ...success,
      exitCode: 1,
      stderr: "FAKE-secret diagnostic",
    });
    await expect(client.logout()).rejects.toMatchObject({
      code: "CONTROL_UNREACHABLE",
      message: expect.not.stringContaining("FAKE-secret"),
    });
  });
  it("logs out using the private socket and accepts already logged out", async () => {
    await client.logout();
    expect(run).toHaveBeenCalledWith(
      installation.tailscale,
      [`--socket=${paths.socketFile}`, "logout"],
      expect.any(Object),
    );
    vi.mocked(run).mockResolvedValueOnce({ ...success, exitCode: 1, stdout: "Logged out." });
    await expect(client.logout()).resolves.toBeUndefined();
  });
  it.each(["raspberry5", "raspberry5.example.ts.net", "100.64.0.20", "fd7a:115c:a1e0::20"])(
    "opens nc for %s without a shell",
    (host) => {
      client.ncSpawn(host, 22);
      expect(spawn).toHaveBeenCalledWith(
        installation.tailscale,
        [`--socket=${paths.socketFile}`, "nc", host, "22"],
        { env: childEnvironment(env), shell: false, stdio: ["pipe", "pipe", "pipe"] },
      );
    },
  );
  it.each([
    ["--help", 22],
    ["host;echo FAKE", 22],
    ["", 22],
    ["host", 0],
    ["host", 65536],
    ["host", 1.5],
  ])("rejects invalid destinations %s:%s before spawning", (host, port) => {
    expect(() => validateDestination(String(host), Number(port))).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
