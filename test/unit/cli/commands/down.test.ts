import { beforeEach, describe, expect, it, vi } from "vitest";
import { downCommand } from "../../../../src/cli/commands/down.js";
import { isRunning, stop } from "../../../../src/tailscale/daemon.js";
import { findInstalled } from "../../../../src/tailscale/install.js";

const mocks = vi.hoisted(() => ({ logout: vi.fn() }));
vi.mock("../../../../src/core/paths.js", () => ({
  ensurePaths: vi.fn(async () => ({ home: "/tmp/FAKE-home" })),
}));
vi.mock("../../../../src/tailscale/client.js", () => ({
  TailscaleClient: vi.fn(
    class {
      logout = mocks.logout;
    },
  ),
}));
vi.mock("../../../../src/tailscale/daemon.js", () => ({ isRunning: vi.fn(), stop: vi.fn() }));
vi.mock("../../../../src/tailscale/install.js", () => ({ findInstalled: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isRunning).mockResolvedValue(true);
  vi.mocked(findInstalled).mockResolvedValue({ version: "1.104.1" } as never);
  mocks.logout.mockResolvedValue(undefined);
});

describe("down command", () => {
  it("logs out before stopping the daemon", async () => {
    expect(await downCommand()).toMatchObject({
      ok: true,
      data: { daemonRunning: false, loggedOut: true },
    });
    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(mocks.logout.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(stop).mock.invocationCallOrder[0],
    );
  });
  it("succeeds when already stopped", async () => {
    vi.mocked(isRunning).mockResolvedValue(false);
    expect(await downCommand()).toMatchObject({ ok: true });
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("stops the daemon even if logout fails, and reports that failure", async () => {
    mocks.logout.mockRejectedValue(new Error("FAKE logout failure"));
    await expect(downCommand()).rejects.toThrow("FAKE logout failure");
    expect(stop).toHaveBeenCalledOnce();
  });
  it("reports a missing client but still stops an orphan daemon", async () => {
    vi.mocked(findInstalled).mockResolvedValue(undefined);
    await expect(downCommand()).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
    expect(stop).toHaveBeenCalledOnce();
  });
  it("rejects arguments", async () => {
    await expect(downCommand(["FAKE"])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(stop).not.toHaveBeenCalled();
  });
});
