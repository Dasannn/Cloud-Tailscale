import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseUpOptions, upCommand } from "../../../../src/cli/commands/up.js";
import { connect } from "../../../../src/tailscale/connect.js";

vi.mock("../../../../src/tailscale/connect.js", () => ({ connect: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("up command", () => {
  it("parses the documented flags including version pins", () => {
    expect(
      parseUpOptions([
        "--hostname",
        "FAKE-agent",
        "--mode=userspace",
        "--accept-routes",
        "--tailscale-version",
        "1.104.1",
      ]),
    ).toEqual({
      hostname: "FAKE-agent",
      mode: "userspace",
      acceptRoutes: true,
      version: "1.104.1",
    });
    expect(parseUpOptions([])).toEqual({});
  });
  it.each(
    [
      ["--auth-key", "tskey-auth-FAKE"],
      ["--unknown"],
      ["--mode", "FAKE"],
      ["--mode"],
      ["--hostname", "invalid name"],
      ["--hostname="],
      ["--hostname", "--accept-routes"],
      ["--tailscale-version", "../../FAKE"],
    ].map((args) => ({ args })),
  )("rejects invalid options $args", ({ args }) => {
    expect(() => parseUpOptions(args)).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });
  it.each([false, true])(
    "reports node, IP, mode, DERP and peer access (already=%s)",
    async (alreadyConnected) => {
      vi.mocked(connect).mockResolvedValue({
        alreadyConnected,
        config: { mode: "userspace", hostname: "FAKE-agent", proxyPort: 1055 },
        status: {
          BackendState: "Running",
          TUN: false,
          Self: { HostName: "FAKE-agent", Relay: "nyc" },
          TailscaleIPs: ["100.64.0.10"],
        },
      } as never);
      const result = await upCommand(["--hostname", "FAKE-agent"]);
      expect(connect).toHaveBeenCalledWith({ hostname: "FAKE-agent" });
      expect(result).toMatchObject({
        ok: true,
        data: {
          name: "FAKE-agent",
          ips: ["100.64.0.10"],
          mode: "userspace",
          derp: "nyc",
          alreadyConnected,
        },
      });
      expect(result.message).toContain(alreadyConnected ? "Already connected" : "Connected");
      expect(result.message).toContain("cloud-tailscale nc");
      expect(result.message).toContain("cloud-tailscale ssh");
    },
  );
});
