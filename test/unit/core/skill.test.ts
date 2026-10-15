import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../../src/core/proc.js";
import {
  installRepoSkill,
  installSkill,
  isCloudTailscaleSkill,
  readSkill,
  skillPath,
} from "../../../src/core/skill.js";

vi.mock("../../../src/core/proc.js", () => ({ run: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, mkdir: vi.fn(fs.mkdir), readFile: vi.fn(fs.readFile) };
});

let temp: string;
let repo: string;

beforeEach(async () => {
  vi.clearAllMocks();
  temp = await mkdtemp("/tmp/cts-skill-test-");
  repo = join(temp, "repo");
  await mkdir(repo);
  vi.mocked(run).mockResolvedValue({ stdout: `${repo}\n`, stderr: "", exitCode: 0, signal: null });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(temp, { recursive: true, force: true });
});

describe("packaged skill", () => {
  it("loads the single shipped skill relative to the module, independently of cwd", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(temp);
    const content = await readSkill();
    expect(content).toBe(await readFile(skillPath, "utf8"));
    expect(isCloudTailscaleSkill(content)).toBe(true);
    expect(isCloudTailscaleSkill(content.replaceAll("\n", "\r\n"))).toBe(true);
  });

  it.each([
    "FAKE foreign instructions",
    "---\nname: cloud-tailscale\n---\nUser's own skill.",
    "---\nname: another-skill\n---\n<!-- cloud-tailscale:managed-skill -->",
  ])("does not claim ownership of foreign content: %s", (content) => {
    expect(isCloudTailscaleSkill(content)).toBe(false);
  });

  it("explains how to recover when the packaged skill is missing", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error("FAKE missing"), { code: "ENOENT" }),
    );
    await expect(readSkill()).rejects.toMatchObject({
      code: "SKILL_INSTALL_FAILED",
      next: expect.stringContaining("Reinstall"),
    });
  });
});

describe("Claude user skill", () => {
  it("installs outside the project with a private skill directory and is idempotent", async () => {
    const first = await installSkill({ HOME: temp });
    expect(first).toEqual({
      path: join(temp, ".claude/skills/cloud-tailscale/SKILL.md"),
      action: "installed",
    });
    expect(await readFile(first.path, "utf8")).toBe(await readSkill());
    expect((await stat(join(temp, ".claude/skills/cloud-tailscale"))).mode & 0o777).toBe(0o700);
    const before = await stat(first.path);
    expect(await installSkill({ HOME: temp })).toEqual({ ...first, action: "unchanged" });
    expect((await stat(first.path)).mtimeMs).toBe(before.mtimeMs);
    await expect(lstat(join(temp, ".cloud-tailscale"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the process HOME by default", async () => {
    vi.stubEnv("HOME", temp);
    expect((await installSkill()).path).toBe(join(temp, ".claude/skills/cloud-tailscale/SKILL.md"));
  });

  it("falls back to the OS home when HOME is absent without writing there", async () => {
    vi.mocked(mkdir).mockRejectedValueOnce(new Error("FAKE read-only home"));
    await expect(installSkill({})).rejects.toMatchObject({
      code: "SKILL_INSTALL_FAILED",
      message: expect.stringContaining(join(homedir(), ".claude/skills/cloud-tailscale/SKILL.md")),
    });
  });

  it("reports read-only homes without falling back to an undiscoverable directory", async () => {
    vi.mocked(mkdir).mockRejectedValueOnce(
      Object.assign(new Error("FAKE read-only"), { code: "EROFS" }),
    );
    await expect(installSkill({ HOME: temp })).rejects.toMatchObject({
      code: "SKILL_INSTALL_FAILED",
      next: expect.stringContaining("skill --print"),
    });
    await expect(lstat(join(temp, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])(
    "rejects a HOME inside the project before writing (symlink=%s)",
    async (link) => {
      let home = repo;
      if (link) {
        home = join(temp, "alias");
        await symlink(repo, home);
      }
      await expect(installSkill({ HOME: home })).rejects.toMatchObject({
        code: "SKILL_INSTALL_FAILED",
      });
      expect(await readdir(repo)).toEqual([]);
    },
  );

  it.each(["directory", "file"])(
    "rejects a HOME at the Git root from a subdirectory without git (.git %s)",
    async (marker) => {
      const cwd = join(repo, "src");
      await mkdir(cwd);
      if (marker === "directory") await mkdir(join(repo, ".git"));
      else await writeFile(join(repo, ".git"), "gitdir: /FAKE/main/.git/worktrees/task\n");
      vi.spyOn(process, "cwd").mockReturnValue(cwd);
      vi.mocked(run).mockRejectedValue(
        Object.assign(new Error("FAKE git missing"), { code: "ENOENT" }),
      );
      vi.mocked(mkdir).mockClear();

      await expect(installSkill({ HOME: repo })).rejects.toMatchObject({
        code: "SKILL_INSTALL_FAILED",
        next: expect.stringContaining("HOME outside the project"),
      });

      expect(mkdir).not.toHaveBeenCalled();
      expect((await readdir(repo)).sort()).toEqual([".git", "src"]);
    },
  );

  it("does not require git to install a user skill", async () => {
    vi.mocked(run).mockRejectedValue(new Error("FAKE git missing"));
    expect((await installSkill({ HOME: temp })).action).toBe("installed");
  });
});

describe("repository skill", () => {
  it("uses the Git root from a nested directory and creates just one file", async () => {
    const cwd = join(repo, "packages", "app");
    const first = await installRepoSkill(cwd);
    expect(run).toHaveBeenCalledWith("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeoutMs: 5_000,
    });
    expect(first).toEqual({
      path: join(repo, ".agents/skills/cloud-tailscale/SKILL.md"),
      action: "installed",
    });
    const files = await readdir(repo, { recursive: true, withFileTypes: true });
    expect(files.filter((entry) => entry.isFile()).map((entry) => entry.name)).toEqual([
      "SKILL.md",
    ]);
    expect(await readFile(first.path, "utf8")).toBe(await readSkill());
    expect(await installRepoSkill(cwd)).toEqual({ ...first, action: "unchanged" });
  });

  it("supports Git worktrees whose .git is a file", async () => {
    await writeFile(join(repo, ".git"), "gitdir: /FAKE/main/.git/worktrees/task\n");
    const installation = await installRepoSkill(repo);
    expect(installation.path).toBe(join(repo, ".agents/skills/cloud-tailscale/SKILL.md"));
    expect(await readFile(join(repo, ".git"), "utf8")).toBe(
      "gitdir: /FAKE/main/.git/worktrees/task\n",
    );
  });

  it("preserves whitespace in the Git root path", async () => {
    const root = join(temp, "FAKE repository ");
    await mkdir(root);
    vi.mocked(run).mockResolvedValue({
      stdout: `${root}\n`,
      stderr: "",
      exitCode: 0,
      signal: null,
    });
    const installation = await installRepoSkill(root);
    expect(installation.path).toBe(join(root, ".agents/skills/cloud-tailscale/SKILL.md"));
    expect(await readFile(installation.path, "utf8")).toBe(await readSkill());
  });

  it("defaults Git discovery to the working directory", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(repo);
    await installRepoSkill();
    expect(run).toHaveBeenCalledWith(
      "git",
      ["-C", repo, "rev-parse", "--show-toplevel"],
      expect.any(Object),
    );
  });

  it("updates an owned older version without touching neighboring files", async () => {
    const first = await installRepoSkill(repo);
    await writeFile(first.path, `${await readSkill()}\nFAKE old version\n`);
    const neighbor = join(repo, ".agents/skills/cloud-tailscale/notes.md");
    await writeFile(neighbor, "FAKE user notes");
    expect(await installRepoSkill(repo)).toEqual({ ...first, action: "updated" });
    expect(await readFile(first.path, "utf8")).toBe(await readSkill());
    expect(await readFile(neighbor, "utf8")).toBe("FAKE user notes");
  });

  it.each(["foreign text", "---\nname: cloud-tailscale\n---\nUser's own skill\n"])(
    "preserves a foreign existing file and its permissions: %s",
    async (content) => {
      const directory = join(repo, ".agents/skills/cloud-tailscale");
      await mkdir(directory, { recursive: true });
      const path = join(directory, "SKILL.md");
      await writeFile(path, content);
      await chmod(path, 0o640);
      const before = await stat(path);
      await expect(installRepoSkill(repo)).rejects.toMatchObject({ code: "SKILL_CONFLICT" });
      expect(await readFile(path, "utf8")).toBe(content);
      const after = await stat(path);
      expect(after.mode).toBe(before.mode);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    },
  );

  it.each([
    ".agents",
    ".agents/skills",
    ".agents/skills/cloud-tailscale",
    ".agents/skills/cloud-tailscale/SKILL.md",
  ])("does not follow a symlink at %s", async (link) => {
    const external = join(temp, "external");
    await mkdir(external);
    await writeFile(join(external, "SKILL.md"), "FAKE private file");
    const components = link.split("/");
    const name = components.pop();
    await mkdir(join(repo, ...components), { recursive: true });
    await symlink(
      link.endsWith("SKILL.md") ? join(external, "SKILL.md") : external,
      join(repo, ...components, name ?? ""),
    );
    await expect(installRepoSkill(repo)).rejects.toMatchObject({ code: "SKILL_CONFLICT" });
    expect(await readdir(external)).toEqual(["SKILL.md"]);
    expect(await readFile(join(external, "SKILL.md"), "utf8")).toBe("FAKE private file");
  });

  it("does not replace a directory at the destination", async () => {
    await mkdir(join(repo, ".agents/skills/cloud-tailscale/SKILL.md"), { recursive: true });
    await expect(installRepoSkill(repo)).rejects.toMatchObject({ code: "SKILL_CONFLICT" });
  });

  it.each([1, 128])("does not write anything if git fails with exit %s", async (exitCode) => {
    vi.mocked(run).mockResolvedValue({
      stdout: "",
      stderr: "FAKE not a repository",
      exitCode,
      signal: null,
    });
    await expect(installRepoSkill(repo)).rejects.toMatchObject({ code: "GIT_ROOT_NOT_FOUND" });
    expect(await readdir(repo)).toEqual([]);
  });

  it("reports a missing git executable", async () => {
    vi.mocked(run).mockRejectedValue(new Error("FAKE git missing"));
    await expect(installRepoSkill(repo)).rejects.toMatchObject({ code: "GIT_ROOT_NOT_FOUND" });
    expect(await readdir(repo)).toEqual([]);
  });
});
