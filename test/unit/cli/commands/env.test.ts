import { beforeEach, describe, expect, it, vi } from "vitest";
import { envCommand } from "../../../../src/cli/commands/env.js";
import { CtError } from "../../../../src/core/errors.js";
import { ensureConnected } from "../../../../src/tailscale/connect.js";

vi.mock("../../../../src/tailscale/connect.js", () => ({ ensureConnected: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
});

describe("env command", () => {
  it("auto-connects, exports SOCKS with remote DNS and leaves the provider proxy untouched", async () => {
    vi.mocked(ensureConnected).mockResolvedValue({ config: { proxyPort: 1055 } } as never);
    const result = await envCommand();
    expect(ensureConnected).toHaveBeenCalledOnce();
    expect(result.message).toContain("export ALL_PROXY='socks5h://127.0.0.1:1055'");
    expect(result.message).toContain("export all_proxy='socks5h://127.0.0.1:1055'");
    expect(result.message).not.toMatch(
      /export (?:HTTPS_PROXY|https_proxy|HTTP_PROXY|http_proxy|NO_PROXY|no_proxy)=/,
    );
    expect(result.message).toContain("subshell");
    expect(result.data).toEqual({
      ALL_PROXY: "socks5h://127.0.0.1:1055",
      all_proxy: "socks5h://127.0.0.1:1055",
      httpProxy: "http://127.0.0.1:1055",
    });
  });
  it("rejects arguments before connecting", async () => {
    await expect(envCommand(["FAKE"])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(ensureConnected).not.toHaveBeenCalled();
  });
  it("reports a missing auth key instead of returning disconnected proxy exports", async () => {
    vi.mocked(ensureConnected).mockRejectedValue(
      new CtError("AUTH_KEY_MISSING", "No key configured.", "Set TS_AUTHKEY in secrets."),
    );
    await expect(envCommand()).rejects.toMatchObject({ code: "AUTH_KEY_MISSING" });
  });
});
