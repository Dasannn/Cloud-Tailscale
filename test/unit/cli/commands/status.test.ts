import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { statusCommand } from "../../../../src/cli/commands/status.js";
import { render } from "../../../../src/core/output.js";
import { TailscaleClient } from "../../../../src/tailscale/client.js";
import { isRunning, readConfig } from "../../../../src/tailscale/daemon.js";
import { findInstalled } from "../../../../src/tailscale/install.js";
import { hasConnectedDerp } from "../../../../src/tailscale/log.js";

const mocks = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("../../../../src/core/paths.js", async (original) => ({
  ...(await original<typeof import("../../../../src/core/paths.js")>()),
  ensurePaths: vi.fn(async () => ({ home: "/tmp/FAKE-home" })),
}));
vi.mock("../../../../src/tailscale/client.js", () => ({
  TailscaleClient: vi.fn(
    class {
      statusJson = mocks.status;
    },
  ),
}));
vi.mock("../../../../src/tailscale/daemon.js", () => ({ isRunning: vi.fn(), readConfig: vi.fn() }));
vi.mock("../../../../src/tailscale/install.js", () => ({ findInstalled: vi.fn() }));

vi.mock("../../../../src/tailscale/log.js", () => ({ hasConnectedDerp: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hasConnectedDerp).mockResolvedValue(true);
  vi.mocked(isRunning).mockResolvedValue(false);
  vi.mocked(readConfig).mockResolvedValue(undefined);
  vi.mocked(findInstalled).mockResolvedValue(undefined);
});

describe("status command", () => {
  it("reports not installed and stopped without contacting a package server", async () => {
    expect(await statusCommand()).toMatchObject({
      ok: true,
      data: {
        installed: false,
        daemonRunning: false,
        connected: false,
        state: "Stopped",
        peers: [],
      },
    });
    expect(TailscaleClient).not.toHaveBeenCalled();
  });
  it("reports recorded node and online/offline peers as text and command data", async () => {
    const status = JSON.parse(
      await readFile(
        new URL("../../../fixtures/tailscale/status-running.json", import.meta.url),
        "utf8",
      ),
    );
    vi.mocked(findInstalled).mockResolvedValue({ version: "1.104.1" } as never);
    vi.mocked(isRunning).mockResolvedValue(true);
    mocks.status.mockResolvedValue(status);
    const result = await statusCommand();
    expect(result.data).toMatchObject({
      installed: true,
      daemonRunning: true,
      connected: true,
      mode: "userspace",
      name: "claude-cloud-3f9a",
      peers: [
        { name: "offline-peer", online: false },
        { name: "raspberry5", online: true },
      ],
    });
    expect(result.message).toContain("raspberry5\t100.64.0.20\tonline");
    expect(result.message).toContain("offline-peer\t100.64.0.30\toffline");
  });
  it.each([
    { daemonRunning: false, state: "Running" },
    { daemonRunning: true, state: "NeedsLogin" },
    { daemonRunning: true, state: "Stopped" },
  ])(
    "clears stale session details when daemonRunning=$daemonRunning and backend=$state",
    async ({ daemonRunning, state }) => {
      const status = JSON.parse(
        await readFile(
          new URL("../../../fixtures/tailscale/status-running.json", import.meta.url),
          "utf8",
        ),
      );
      status.BackendState = state;
      vi.mocked(findInstalled).mockResolvedValue({ version: "1.104.1" } as never);
      vi.mocked(isRunning).mockResolvedValue(daemonRunning);
      vi.mocked(readConfig).mockResolvedValue({
        hostname: "FAKE-stale-hostname",
        mode: "userspace",
      } as never);
      mocks.status.mockResolvedValue(status);
      const result = await statusCommand();
      expect(result.data).toEqual({
        installed: true,
        version: "1.104.1",
        daemonRunning,
        connected: false,
        state: "Stopped",
        name: null,
        ips: [],
        mode: null,
        derp: null,
        peers: [],
      });
      expect(result.message).toBe(
        `Tailscale: installed (1.104.1); daemon ${daemonRunning ? "running" : "stopped"}; Stopped.`,
      );
      for (const output of [render(result), render(result, true)]) {
        for (const stale of [
          "FAKE-stale-hostname",
          status.Self.HostName,
          ...status.TailscaleIPs,
          status.Self.Relay,
          "raspberry5",
          "offline-peer",
        ]) {
          expect(output).not.toContain(stale);
        }
      }
      expect(hasConnectedDerp).not.toHaveBeenCalled();
      expect(readConfig).not.toHaveBeenCalled();
      if (!daemonRunning) expect(TailscaleClient).not.toHaveBeenCalled();
    },
  );
  it("uses status TUN as authoritative rather than an old config mode", async () => {
    vi.mocked(findInstalled).mockResolvedValue({ version: "1.104.1" } as never);
    vi.mocked(isRunning).mockResolvedValue(true);
    vi.mocked(readConfig).mockResolvedValue({ mode: "userspace" } as never);
    mocks.status.mockResolvedValue({ BackendState: "Running", TUN: true, Self: { Relay: "nyc" } });
    expect((await statusCommand()).data).toMatchObject({ mode: "kernel" });
  });
  it.each(["warning", "no-handshake"])(
    "reports an assigned relay as disconnected with %s",
    async (cause) => {
      vi.mocked(findInstalled).mockResolvedValue({ version: "1.104.1" } as never);
      vi.mocked(isRunning).mockResolvedValue(true);
      vi.mocked(hasConnectedDerp).mockResolvedValue(cause !== "no-handshake");
      mocks.status.mockResolvedValue({
        BackendState: "Running",
        Self: { Relay: "nyc" },
        Health: cause === "warning" ? ["not connected to home DERP region 1"] : [],
      });
      expect((await statusCommand()).data).toMatchObject({ connected: false, derp: "nyc" });
    },
  );
  it("rejects arguments before inspection", async () => {
    await expect(statusCommand(["--unknown"])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(findInstalled).not.toHaveBeenCalled();
  });
});
