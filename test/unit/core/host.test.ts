import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectArch, detectHost, isRoot, tunUsable } from "../../../src/core/host.js";

vi.mock("node:fs/promises", () => ({ open: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("host and architecture", () => {
  it.each(["CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE"])("detects Claude from %s", (name) => {
    expect(detectHost({ [name]: "1" })).toBe("claude");
  });
  it.each(["CODEX_THREAD_ID", "CODEX_SESSION_ID"])("detects Codex from %s", (name) => {
    expect(detectHost({ [name]: "FAKE-session" })).toBe("codex");
  });
  it("uses Claude first and otherwise falls back to local", () => {
    expect(detectHost({ CLAUDECODE: "1", CODEX_THREAD_ID: "FAKE" })).toBe("claude");
    expect(detectHost({ CLAUDECODE: "", CODEX_THREAD_ID: "" })).toBe("local");
    expect(detectHost({})).toBe("local");
    vi.stubEnv("CLAUDECODE", "1");
    expect(detectHost()).toBe("claude");
  });
  it("maps supported architectures and defaults to the current CPU", () => {
    expect(detectArch("x64")).toBe("amd64");
    expect(detectArch("arm64")).toBe("arm64");
    expect(detectArch()).toBe(process.arch === "x64" ? "amd64" : "arm64");
  });
  it("rejects unsupported architectures with an actionable error", () => {
    expect(() => detectArch("ia32")).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_ARCH",
        next: expect.stringContaining("x86_64"),
      }),
    );
  });
  it("detects root and non-root without requiring privileges", () => {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    expect(isRoot()).toBe(true);
    vi.mocked(process.getuid).mockReturnValue(1000);
    expect(isRoot()).toBe(false);
  });
  it("handles a platform without getuid", () => {
    vi.stubGlobal("process", { ...process, getuid: undefined });
    try {
      expect(isRoot()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("tunUsable", () => {
  it("opens the TUN device read-write and closes its descriptor", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(open).mockResolvedValue({ close } as unknown as Awaited<ReturnType<typeof open>>);
    expect(await tunUsable()).toBe(true);
    expect(open).toHaveBeenCalledWith("/dev/net/tun", constants.O_RDWR);
    expect(close).toHaveBeenCalledOnce();
  });
  it.each(["ENOENT", "EACCES", "ENODEV"])("returns false for %s", async (code) => {
    vi.mocked(open).mockRejectedValue(Object.assign(new Error("FAKE device failure"), { code }));
    expect(await tunUsable()).toBe(false);
  });
});
