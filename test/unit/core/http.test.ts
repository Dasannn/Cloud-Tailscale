import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeHttp, fetch } from "../../../src/core/http.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("undici", () => ({
  EnvHttpProxyAgent: vi.fn(
    class {
      close = vi.fn().mockResolvedValue(undefined);
    },
  ),
  fetch: vi.fn(),
}));

beforeEach(() => {
  vi.stubEnv("NODE_EXTRA_CA_CERTS", "");
  vi.stubEnv("SSL_CERT_FILE", "");
});
afterEach(async () => {
  await closeHttp().catch(() => {});
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("proxy-aware fetch", () => {
  it("uses the environment proxy agent, forwards options, and reuses the dispatcher", async () => {
    const response = { ok: true, status: 200 } as Awaited<ReturnType<typeof undiciFetch>>;
    vi.mocked(undiciFetch).mockResolvedValue(response);
    expect(
      await fetch("https://pkgs.tailscale.com/stable/?mode=json", {
        method: "GET",
        headers: { accept: "application/json" },
      }),
    ).toBe(response);
    expect(await fetch(new URL("https://pkgs.tailscale.com/stable/"))).toBe(response);
    expect(EnvHttpProxyAgent).toHaveBeenCalledOnce();
    const agent = vi.mocked(EnvHttpProxyAgent).mock.instances[0];
    expect(undiciFetch).toHaveBeenCalledWith(
      new URL("https://pkgs.tailscale.com/stable/?mode=json"),
      { method: "GET", headers: { accept: "application/json" }, dispatcher: agent },
    );
    expect(EnvHttpProxyAgent).toHaveBeenCalledWith({
      connect: undefined,
      requestTls: undefined,
      proxyTls: undefined,
    });
    await closeHttp();
    expect(agent.close).toHaveBeenCalledOnce();
  });
  it("adds both CA bundles to direct, destination, and proxy TLS while retaining public roots", async () => {
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/FAKE-extra.pem");
    vi.stubEnv("SSL_CERT_FILE", "/FAKE-ssl.pem");
    vi.mocked(readFile).mockImplementation(async (path) =>
      path === "/FAKE-extra.pem" ? "FAKE-extra-CA" : "FAKE-ssl-CA",
    );
    await fetch("https://pkgs.tailscale.com");
    const tls = { ca: [...rootCertificates, "FAKE-extra-CA", "FAKE-ssl-CA"] };
    expect(EnvHttpProxyAgent).toHaveBeenCalledWith({
      connect: tls,
      requestTls: tls,
      proxyTls: tls,
    });
  });
  it("reads a shared CA path only once and ignores nonexistent bundles", async () => {
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/FAKE-same.pem");
    vi.stubEnv("SSL_CERT_FILE", "/FAKE-same.pem");
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error("FAKE missing file"), { code: "ENOENT" }),
    );
    await fetch("https://pkgs.tailscale.com");
    expect(readFile).toHaveBeenCalledOnce();
    expect(EnvHttpProxyAgent).toHaveBeenCalledWith({
      connect: undefined,
      requestTls: undefined,
      proxyTls: undefined,
    });
  });
  it("names the failed host and network policy without echoing URL credentials", async () => {
    vi.mocked(undiciFetch).mockRejectedValueOnce(new Error("FAKE proxy failure"));
    await expect(
      fetch("https://FAKE-user:FAKE-password@pkgs.tailscale.com/file?key=FAKE-secret"),
    ).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      message: "Could not download from pkgs.tailscale.com.",
      next: expect.stringContaining("Allow pkgs.tailscale.com"),
    });
  });
  it("reports an unreadable CA bundle as a download configuration failure", async () => {
    vi.stubEnv("SSL_CERT_FILE", "/FAKE-denied.pem");
    vi.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error("FAKE denied"), { code: "EACCES" }),
    );
    await expect(fetch("https://pkgs.tailscale.com")).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      next: expect.stringContaining("CA bundle"),
    });
  });
  it("rejects invalid URLs with a stable code", async () => {
    await expect(fetch("FAKE-invalid-url")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it.each(["options", "positional", "error"])(
    "suppresses only UNDICI-EHPA (%s) and restores warning emission",
    async (format) => {
      const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      vi.mocked(EnvHttpProxyAgent).mockImplementationOnce(
        class {
          close = vi.fn().mockResolvedValue(undefined);
          constructor() {
            if (format === "options") {
              process.emitWarning("FAKE experimental proxy warning", { code: "UNDICI-EHPA" });
            } else if (format === "positional") {
              process.emitWarning("FAKE experimental proxy warning", "Warning", "UNDICI-EHPA");
            } else {
              process.emitWarning(
                Object.assign(new Error("FAKE proxy warning"), { code: "UNDICI-EHPA" }),
              );
            }
            process.emitWarning("FAKE other warning", { code: "FAKE-OTHER" });
            process.emitWarning("FAKE positional warning", "Warning", "FAKE-POSITIONAL");
          }
        } as typeof EnvHttpProxyAgent,
      );
      await fetch("https://pkgs.tailscale.com");
      expect(emitWarning).toHaveBeenCalledTimes(2);
      expect(emitWarning).toHaveBeenCalledWith("FAKE other warning", { code: "FAKE-OTHER" });
      expect(emitWarning).toHaveBeenCalledWith(
        "FAKE positional warning",
        "Warning",
        "FAKE-POSITIONAL",
      );
      expect(process.emitWarning).toBe(emitWarning);
      process.emitWarning("FAKE later warning");
      expect(emitWarning).toHaveBeenLastCalledWith("FAKE later warning");
    },
  );
  it("restores warning emission even when the proxy agent constructor fails", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    vi.mocked(EnvHttpProxyAgent).mockImplementationOnce(
      class {
        constructor() {
          process.emitWarning("FAKE experimental proxy warning", { code: "UNDICI-EHPA" });
          throw new Error("FAKE agent configuration failure");
        }
      } as typeof EnvHttpProxyAgent,
    );
    await expect(fetch("https://pkgs.tailscale.com")).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
    });
    expect(emitWarning).not.toHaveBeenCalled();
    expect(process.emitWarning).toBe(emitWarning);
  });
});
