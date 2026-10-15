import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillCommand } from "../../../src/cli/commands/skill.js";
import { main } from "../../../src/cli/main.js";
import { installRepoSkill, installSkill, readSkill } from "../../../src/core/skill.js";

vi.mock("../../../src/core/skill.js", () => ({
  readSkill: vi.fn(),
  installSkill: vi.fn(),
  installRepoSkill: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readSkill).mockResolvedValue("FAKE packaged skill\n");
  vi.mocked(installSkill).mockResolvedValue({
    path: "/tmp/FAKE-home/.claude/skills/cloud-tailscale/SKILL.md",
    action: "installed",
  });
  vi.mocked(installRepoSkill).mockResolvedValue({
    path: "/tmp/FAKE-repo/.agents/skills/cloud-tailscale/SKILL.md",
    action: "unchanged",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("skill command", () => {
  it("prints the packaged skill without installing", async () => {
    expect(await skillCommand(["--print"])).toEqual({
      ok: true,
      message: "FAKE packaged skill\n",
      data: { content: "FAKE packaged skill\n" },
    });
    expect(installSkill).not.toHaveBeenCalled();
    expect(installRepoSkill).not.toHaveBeenCalled();
  });

  it("installs the Claude user skill", async () => {
    const result = await skillCommand(["--install"]);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      action: "installed",
      path: expect.stringContaining(".claude"),
    });
    expect(installSkill).toHaveBeenCalledOnce();
    expect(installRepoSkill).not.toHaveBeenCalled();
  });

  it("reports the repository path and requests review and commit", async () => {
    const result = await skillCommand(["--repo"]);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Review and commit");
    expect(result.data).toMatchObject({
      action: "unchanged",
      path: expect.stringContaining(".agents"),
    });
    expect(installRepoSkill).toHaveBeenCalledOnce();
    expect(installSkill).not.toHaveBeenCalled();
  });

  it.each([
    { args: [] },
    { args: ["--unknown"] },
    { args: ["--print", "--repo"] },
    { args: ["--install", "--install"] },
    { args: ["--repo", "FAKE-secret"] },
  ])("rejects invalid arguments before writing: $args", async ({ args }) => {
    await expect(skillCommand(args)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(installSkill).not.toHaveBeenCalled();
    expect(installRepoSkill).not.toHaveBeenCalled();
    expect(readSkill).not.toHaveBeenCalled();
  });

  it("is registered in the dispatcher and returns masked JSON", async () => {
    vi.stubEnv("TS_SSH_PASSWORD", "FAKE-password");
    vi.mocked(readSkill).mockResolvedValue("FAKE-password tskey-auth-FAKE");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await main(["skill", "--print", "--json"])).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(JSON.parse(String(stdout.mock.calls[0][0]))).toEqual({
      ok: true,
      message: "[REDACTED] [REDACTED]",
      data: { content: "[REDACTED] [REDACTED]" },
    });
  });
});
