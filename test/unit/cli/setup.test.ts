import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupCommand } from "../../../src/cli/commands/setup.js";
import { commands, main } from "../../../src/cli/main.js";
import { CtError } from "../../../src/core/errors.js";
import { clearSecrets } from "../../../src/core/output.js";
import { installSkill } from "../../../src/core/skill.js";

vi.mock("../../../src/core/skill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/skill.js")>()),
  installSkill: vi.fn(),
}));

const installation = {
  path: "/tmp/FAKE-home/.claude/skills/cloud-tailscale/SKILL.md",
  action: "installed" as const,
};
const connected = {
  ok: true,
  message: "Connected as claude-cloud-FAKE.",
  data: { ip: "100.64.0.1" },
};
const claudeEnv = { CLAUDECODE: "1", TS_AUTHKEY: "tskey-auth-FAKE" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(installSkill).mockResolvedValue(installation);
});

afterEach(() => {
  clearSecrets();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("setup steps", () => {
  it("calls the injected up before installing the Claude skill and reports both steps", async () => {
    const calls: string[] = [];
    const result = await setupCommand([], {
      env: claudeEnv,
      up: async () => {
        calls.push("up");
        return connected;
      },
      installSkill: async () => {
        calls.push("skill");
        return installation;
      },
    });
    expect(calls).toEqual(["up", "skill"]);
    expect(result).toMatchObject({
      ok: true,
      data: {
        steps: [
          { name: "up", status: "completed", data: connected.data },
          { name: "skill", status: "completed", data: installation },
        ],
      },
    });
    expect(result.message).toContain("Connected as claude-cloud-FAKE");
    expect(result.message).toContain(installation.path);
  });

  it("skips a missing key without failing setup or skipping skill installation", async () => {
    const up = vi.fn();
    const result = await setupCommand([], { env: { CLAUDECODE: "1" }, up });
    expect(up).not.toHaveBeenCalled();
    expect(installSkill).toHaveBeenCalledExactlyOnceWith({ CLAUDECODE: "1" });
    expect(result).toMatchObject({
      ok: true,
      data: {
        steps: [
          {
            name: "up",
            status: "skipped",
            code: "AUTH_KEY_MISSING",
            next: expect.stringContaining("cts up"),
          },
          { name: "skill", status: "completed" },
        ],
      },
    });
    expect(result.message).toContain("TS_AUTHKEY");
  });

  it("accepts the fallback auth key without passing it as an up argument", async () => {
    const up = vi.fn().mockResolvedValue(connected);
    const result = await setupCommand([], {
      env: { CLAUDE_CODE_ENTRYPOINT: "FAKE", TAILSCALE_AUTHKEY: "tskey-auth-FAKE" },
      up,
    });
    expect(result.ok).toBe(true);
    expect(up).toHaveBeenCalledExactlyOnceWith();
    expect(installSkill).toHaveBeenCalledOnce();
  });

  it("treats an AUTH_KEY_MISSING error from up as nonfatal too", async () => {
    const up = vi
      .fn()
      .mockRejectedValue(
        new CtError("AUTH_KEY_MISSING", "FAKE key missing", "Configure TS_AUTHKEY."),
      );
    const result = await setupCommand([], { env: claudeEnv, up });
    expect(result.ok).toBe(true);
    expect(result.data.steps[0]).toMatchObject({ status: "skipped", code: "AUTH_KEY_MISSING" });
    expect(installSkill).toHaveBeenCalledOnce();
  });

  it("reports NOT_IMPLEMENTED from the default up stub while still installing the skill", async () => {
    const result = await setupCommand([], { env: claudeEnv });
    expect(result.ok).toBe(false);
    expect(result.data.steps).toMatchObject([
      { name: "up", status: "failed", code: "NOT_IMPLEMENTED", next: expect.any(String) },
      { name: "skill", status: "completed" },
    ]);
  });

  it.each(["AUTH_KEY_REJECTED", "CONTROL_UNREACHABLE", "DERP_UNREACHABLE"] as const)(
    "does not suppress %s or prevent skill installation",
    async (code) => {
      const result = await setupCommand([], {
        env: claudeEnv,
        up: () => {
          throw new CtError(code, "FAKE connection failure", "FAKE next step");
        },
      });
      expect(result.ok).toBe(false);
      expect(result.message).toContain(code);
      expect(result.message).toContain("FAKE next step");
      expect(result.data.steps[0]).toMatchObject({ status: "failed", code });
      expect(installSkill).toHaveBeenCalledOnce();
    },
  );

  it("preserves unsuccessful up result details", async () => {
    const result = await setupCommand([], {
      env: claudeEnv,
      up: () => ({ ok: false, message: "FAKE rejected", data: { code: "AUTH_KEY_REJECTED" } }),
    });
    expect(result.ok).toBe(false);
    expect(result.data.steps[0]).toMatchObject({
      status: "failed",
      message: "FAKE rejected",
      data: { code: "AUTH_KEY_REJECTED" },
    });
    expect(installSkill).toHaveBeenCalledOnce();
  });

  it("reports installation failure even if up succeeded", async () => {
    vi.mocked(installSkill).mockRejectedValue(
      new CtError("SKILL_CONFLICT", "FAKE foreign file", "Review the file."),
    );
    const result = await setupCommand([], { env: claudeEnv, up: () => connected });
    expect(result).toMatchObject({
      ok: false,
      data: {
        steps: [
          { name: "up", status: "completed" },
          { name: "skill", status: "failed", code: "SKILL_CONFLICT" },
        ],
      },
    });
    expect(result.message).toContain("Review the file.");
  });

  it("does not suppress a skill error when the auth key is missing", async () => {
    vi.mocked(installSkill).mockRejectedValue(
      new CtError("SKILL_INSTALL_FAILED", "FAKE read-only", "Print the skill."),
    );
    const result = await setupCommand([], { env: { CLAUDECODE: "1" } });
    expect(result.ok).toBe(false);
    expect(result.data.steps.map((step) => step.status)).toEqual(["skipped", "failed"]);
  });

  it.each([{ CODEX_THREAD_ID: "FAKE" }, {}])(
    "does not write a skill on other hosts: %s",
    async (host) => {
      const result = await setupCommand([], {
        env: { ...host, TS_AUTHKEY: "tskey-auth-FAKE" },
        up: () => connected,
      });
      expect(result.ok).toBe(true);
      expect(result.data.steps[1]).toMatchObject({ name: "skill", status: "skipped" });
      expect(installSkill).not.toHaveBeenCalled();
    },
  );

  it.each(["up", "skill"] as const)(
    "reports unexpected %s errors with a next step",
    async (step) => {
      const fail = () => {
        throw new Error("FAKE unexpected error");
      };
      if (step === "skill") vi.mocked(installSkill).mockImplementation(fail);
      const result = await setupCommand([], {
        env: claudeEnv,
        up: step === "up" ? fail : () => connected,
      });
      expect(result.ok).toBe(false);
      expect(result.data.steps.find((value) => value.name === step)).toMatchObject({
        status: "failed",
        code: "INTERNAL_ERROR",
        message: "FAKE unexpected error",
        next: expect.any(String),
      });
    },
  );

  it("rejects arguments before up or skill installation", async () => {
    const up = vi.fn();
    await expect(
      setupCommand(["--auth-key", "tskey-auth-FAKE"], { env: claudeEnv, up }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(up).not.toHaveBeenCalled();
    expect(installSkill).not.toHaveBeenCalled();
  });
});

describe("setup output through the dispatcher", () => {
  it("succeeds without a key and emits one JSON result with both steps", async () => {
    vi.stubEnv("TS_AUTHKEY", "");
    vi.stubEnv("TAILSCALE_AUTHKEY", "");
    vi.stubEnv("CLAUDECODE", "1");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await main(["setup", "--json"])).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({
      ok: true,
      data: { steps: [{ code: "AUTH_KEY_MISSING" }, { status: "completed" }] },
    });
  });

  it.each([false, true])(
    "masks all step data and reports failure on stderr (json=%s)",
    async (json) => {
      vi.stubEnv("TS_AUTHKEY", "tskey-auth-FAKE");
      vi.stubEnv("TS_SSH_PASSWORD", "FAKE-password");
      vi.spyOn(commands, "setup").mockImplementation((args) =>
        setupCommand(args, {
          env: claudeEnv,
          up: () => {
            throw new CtError(
              "AUTH_KEY_REJECTED",
              "Rejected tskey-auth-FAKE",
              "Replace FAKE-password in secrets.",
            );
          },
        }),
      );
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      expect(await main(["setup", ...(json ? ["--json"] : [])])).toBe(1);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledOnce();
      const output = String(stderr.mock.calls[0][0]);
      expect(output).not.toContain("tskey-auth-FAKE");
      expect(output).not.toContain("FAKE-password");
      expect(output).toContain("[REDACTED]");
      if (json) {
        expect(JSON.parse(output)).toMatchObject({
          ok: false,
          data: { steps: [{ code: "AUTH_KEY_REJECTED" }, { status: "completed" }] },
        });
      }
    },
  );
});
