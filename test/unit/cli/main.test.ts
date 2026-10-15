import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, main } from "../../../src/cli/main.js";
import { CtError } from "../../../src/core/errors.js";

let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("CLI dispatcher", () => {
  it.each([{ args: [] }, { args: ["--help"] }, { args: ["up", "--help"] }])(
    "shows help for $args",
    async ({ args }) => {
      expect(await main(args)).toBe(0);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Usage: cloud-tailscale"));
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining("ssh-config, skill, setup"));
      expect(stderr).not.toHaveBeenCalled();
    },
  );
  it.each(["up", "status", "down", "nc", "env"])(
    "returns NOT_IMPLEMENTED for %s",
    async (command) => {
      expect(await main([command])).toBe(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("NOT_IMPLEMENTED"));
      expect(stdout).not.toHaveBeenCalled();
    },
  );
  it("uses the same result envelope for JSON help and errors", async () => {
    expect(await main(["--json", "--help"])).toBe(0);
    expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({
      ok: true,
      data: { commands: expect.arrayContaining(["up"]) },
    });
    expect(await main(["up", "--json"])).toBe(1);
    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toMatchObject({
      ok: false,
      data: { code: "NOT_IMPLEMENTED", next: expect.any(String) },
    });
  });
  it.each(["FAKE-command", "toString", "__proto__"])(
    "rejects an unknown command %s",
    async (command) => {
      expect(await main([command, "--json"])).toBe(1);
      expect(JSON.parse(String(stderr.mock.calls[0][0]))).toMatchObject({
        data: { code: "INVALID_ARGUMENT" },
      });
    },
  );
  it("masks environment secrets even in invalid command names", async () => {
    vi.stubEnv("TS_SSH_PASSWORD", 'FAKE-"password"');
    expect(await main(['FAKE-"password"', "--json"])).toBe(1);
    expect(String(stderr.mock.calls[0][0])).not.toContain("FAKE");
  });

  it.each([false, true])("fully masks token-like passwords in errors (json=%s)", async (json) => {
    const password = "tskey-FAKE!password-suffix";
    vi.stubEnv("TS_SSH_PASSWORD", password);
    expect(await main([password, ...(json ? ["--json"] : [])])).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledOnce();
    const output = String(stderr.mock.calls[0][0]);
    if (json) {
      expect(JSON.parse(output)).toMatchObject({
        ok: false,
        message: "Unknown command: [REDACTED].",
      });
    } else {
      expect(output).toBe(
        "INVALID_ARGUMENT: Unknown command: [REDACTED].\nNext: Run cloud-tailscale --help to list commands.\n",
      );
    }
    expect(output).not.toContain("password-suffix");
  });
  it("preserves arguments after -- without interpreting remote flags", async () => {
    vi.spyOn(commands, "ssh").mockRejectedValue(
      new CtError("NOT_IMPLEMENTED", "FAKE transport", "Retry after Phase 2."),
    );
    expect(await main(["ssh", "FAKE-host", "--", "--help", "--json"])).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("NOT_IMPLEMENTED:"));
  });

  it.each([false, true])("dispatches arguments and output context (json=%s)", async (json) => {
    const command = vi.spyOn(commands, "ssh").mockResolvedValue({
      ok: true,
      message: "FAKE command completed.",
      data: { exitCode: 0 },
    });
    expect(
      await main([...(json ? ["--json"] : []), "ssh", "FAKE-host", "--", "--help", "--json"]),
    ).toBe(0);
    expect(command).toHaveBeenCalledExactlyOnceWith(["FAKE-host", "--", "--help", "--json"], {
      json,
    });
    expect(stdout).toHaveBeenCalledExactlyOnceWith(
      json
        ? '{"ok":true,"message":"FAKE command completed.","data":{"exitCode":0}}\n'
        : "FAKE command completed.\n",
    );
    expect(stderr).not.toHaveBeenCalled();
  });

  describe.each([false, true])("explicit command exit codes (json=%s)", (json) => {
    it.each([
      { ok: true, exitCode: 37 },
      { ok: false, exitCode: 42 },
      { ok: false, exitCode: 0 },
    ])("returns $exitCode and routes masked output for ok=$ok", async ({ ok, exitCode }) => {
      vi.stubEnv("TS_SSH_PASSWORD", "tskey-FAKE!password-suffix");
      vi.spyOn(commands, "ssh").mockResolvedValue({
        ok,
        message: "SSH finished with tskey-FAKE!password-suffix.",
        data: { exitCode, detail: "tskey-FAKE!password-suffix" },
        exitCode,
      });
      expect(await main(["ssh", "FAKE-host", ...(json ? ["--json"] : [])])).toBe(exitCode);
      const output = ok ? stdout : stderr;
      expect(ok ? stderr : stdout).not.toHaveBeenCalled();
      expect(output).toHaveBeenCalledExactlyOnceWith(
        json
          ? `${JSON.stringify({
              ok,
              message: "SSH finished with [REDACTED].",
              data: { exitCode, detail: "[REDACTED]" },
            })}\n`
          : "SSH finished with [REDACTED].\n",
      );
    });
  });

  it.each([false, true])(
    "prints unsuccessful results only to stderr and exits 1 (json=%s)",
    async (json) => {
      vi.stubEnv("TS_SSH_PASSWORD", "tskey-FAKE!password-suffix");
      vi.spyOn(commands, "status").mockReturnValue({
        ok: false,
        message: "Rejected tskey-FAKE!password-suffix. Next: replace the password.",
        data: { next: "Replace tskey-FAKE!password-suffix." },
      });
      expect(await main(["status", ...(json ? ["--json"] : [])])).toBe(1);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledExactlyOnceWith(
        json
          ? '{"ok":false,"message":"Rejected [REDACTED]. Next: replace the password.","data":{"next":"Replace [REDACTED]."}}\n'
          : "Rejected [REDACTED]. Next: replace the password.\n",
      );
    },
  );

  it("formats unexpected errors through the masker without printing a stack", async () => {
    vi.stubEnv("TS_SSH_PASSWORD", "FAKE-password");
    vi.spyOn(commands, "up").mockRejectedValue(new Error("Unexpected FAKE-password"));
    expect(await main(["up", "--json"])).toBe(1);
    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toMatchObject({
      ok: false,
      message: "Unexpected [REDACTED]",
      data: { code: "INTERNAL_ERROR" },
    });
    expect(String(stderr.mock.calls[0][0])).not.toContain("stack");
  });
});
