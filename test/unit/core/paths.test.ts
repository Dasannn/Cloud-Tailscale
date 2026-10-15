import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrivateDir, ensurePaths, getPaths, resolveHome } from "../../../src/core/paths.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn(actual.access),
    mkdir: vi.fn(actual.mkdir),
    chmod: vi.fn(actual.chmod),
  };
});

let temp: string;
beforeEach(async () => {
  temp = await mkdtemp("/tmp/cloud-tailscale-paths-test-");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(temp, { recursive: true, force: true });
});

describe("portable home", () => {
  it("uses the explicit override without probing the home directory", async () => {
    vi.mocked(access).mockClear();
    expect(await resolveHome({ CLOUD_TAILSCALE_HOME: join(temp, "custom") })).toBe(
      join(temp, "custom"),
    );
    expect(access).not.toHaveBeenCalled();
  });
  it("uses the writable home and reads process.env by default", async () => {
    expect(await resolveHome({ HOME: temp })).toBe(join(temp, ".cloud-tailscale"));
    expect(access).toHaveBeenCalledWith(temp, constants.W_OK);
    vi.stubEnv("CLOUD_TAILSCALE_HOME", join(temp, "from-env"));
    expect(await resolveHome()).toBe(join(temp, "from-env"));
  });
  it("falls back to TMPDIR when the home is read-only", async () => {
    vi.mocked(access).mockRejectedValueOnce(
      Object.assign(new Error("FAKE read-only home"), { code: "EROFS" }),
    );
    expect(await resolveHome({ HOME: "/FAKE-home", TMPDIR: temp })).toBe(
      join(temp, "cloud-tailscale"),
    );
  });
  it("falls back to the OS temp directory if TMPDIR is absent", async () => {
    vi.stubEnv("TMPDIR", temp);
    vi.mocked(access).mockRejectedValueOnce(new Error("FAKE no home"));
    expect(await resolveHome({ HOME: "/FAKE-home" })).toBe(join(temp, "cloud-tailscale"));
  });
});

describe("runtime layout and permissions", () => {
  it("exposes exactly the documented paths", () => {
    expect(getPaths("/FAKE-home")).toEqual({
      home: "/FAKE-home",
      binDir: "/FAKE-home/bin",
      runDir: "/FAKE-home/run",
      stateDir: "/FAKE-home/run/state",
      socketFile: "/FAKE-home/run/tailscaled.sock",
      pidFile: "/FAKE-home/run/tailscaled.pid",
      logFile: "/FAKE-home/run/tailscaled.log",
      setupLogFile: "/FAKE-home/setup.log",
      knownHostsFile: "/FAKE-home/known_hosts",
      configFile: "/FAKE-home/config.json",
    });
  });
  it("creates all runtime directories privately and repairs existing permissions", async () => {
    const home = join(temp, "private");
    await mkdir(home, { mode: 0o755 });
    const paths = await ensurePaths({ CLOUD_TAILSCALE_HOME: home });
    for (const path of [paths.home, paths.binDir, paths.runDir, paths.stateDir]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
      await chmod(path, 0o755);
    }
    expect(await ensurePaths({ CLOUD_TAILSCALE_HOME: home })).toEqual(paths);
    for (const path of [paths.home, paths.binDir, paths.runDir, paths.stateDir]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
    // Layout resolution never creates state files before their owners need them.
    await expect(lstat(paths.knownHostsFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("creates nested directories and rejects a file in place of a directory", async () => {
    await createPrivateDir(join(temp, "nested", "private"));
    expect((await stat(join(temp, "nested", "private"))).mode & 0o777).toBe(0o700);
    const file = join(temp, "file");
    await writeFile(file, "FAKE-data");
    await expect(createPrivateDir(file)).rejects.toMatchObject({
      code: "HOME_UNAVAILABLE",
      next: expect.stringContaining("CLOUD_TAILSCALE_HOME"),
    });
    expect(await readFile(file, "utf8")).toBe("FAKE-data");
  });
  it("rejects symlinks without changing the target's permissions", async () => {
    const target = join(temp, "target");
    await mkdir(target);
    await chmod(target, 0o755);
    const link = join(temp, "link");
    await symlink(target, link);
    await expect(createPrivateDir(link)).rejects.toMatchObject({ code: "HOME_UNAVAILABLE" });
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  });
  it("rejects directories owned by another user", async () => {
    const uid = (await stat(temp)).uid;
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    await expect(createPrivateDir(temp)).rejects.toMatchObject({ code: "HOME_UNAVAILABLE" });
  });
});

async function expectUnavailableHome(env: NodeJS.ProcessEnv): Promise<void> {
  vi.mocked(mkdir).mockClear();
  vi.mocked(chmod).mockClear();
  await expect(ensurePaths(env)).rejects.toMatchObject({
    name: "CtError",
    code: "HOME_UNAVAILABLE",
    next: expect.stringMatching(/CLOUD_TAILSCALE_HOME.*outside/),
  });
  expect(mkdir).not.toHaveBeenCalled();
  expect(chmod).not.toHaveBeenCalled();
}

describe("project protection", () => {
  it.each([".", "..", "private"])(
    "rejects home %s in or above the working directory without Git before any writes",
    async (home) => {
      const project = join(temp, "project");
      await mkdir(project, { mode: 0o755 });
      vi.spyOn(process, "cwd").mockReturnValue(project);

      await expectUnavailableHome({ CLOUD_TAILSCALE_HOME: home });

      expect((await stat(project)).mode & 0o777).toBe(0o755);
      await expect(lstat(join(project, "bin"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(project, "run"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["directory", "file"])(
    "rejects homes throughout a Git work tree with a .git %s from a nested working directory",
    async (marker) => {
      const project = join(temp, "project");
      const cwd = join(project, "packages", "app");
      await mkdir(cwd, { recursive: true });
      if (marker === "directory") await mkdir(join(project, ".git"));
      else await writeFile(join(project, ".git"), "gitdir: /FAKE-git-directory\n");
      const existingHome = join(project, "runtime");
      await mkdir(existingHome, { mode: 0o755 });
      vi.spyOn(process, "cwd").mockReturnValue(cwd);

      for (const home of [
        project,
        existingHome,
        join(cwd, "private"),
        join(project, "packages", "other", "runtime"),
      ]) {
        await expectUnavailableHome({ CLOUD_TAILSCALE_HOME: home });
      }

      expect((await stat(existingHome)).mode & 0o777).toBe(0o755);
    },
  );

  it.each(["HOME", "TMPDIR"])("also validates homes selected through %s", async (source) => {
    const project = join(temp, "project");
    const cwd = join(project, "src");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(project, ".git"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const env: NodeJS.ProcessEnv = { HOME: project };
    if (source === "TMPDIR") {
      env.TMPDIR = project;
      vi.mocked(access).mockRejectedValueOnce(new Error("FAKE read-only home"));
    }

    await expectUnavailableHome(env);
  });

  it("rejects homes reached through a symlink into the project before creating children", async () => {
    const project = join(temp, "project");
    const cwd = join(project, "src");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(project, ".git"));
    const alias = join(temp, "alias");
    await symlink(project, alias);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    await expectUnavailableHome({ CLOUD_TAILSCALE_HOME: join(alias, "missing", "runtime") });
    await expectUnavailableHome({ CLOUD_TAILSCALE_HOME: alias });
  });

  it("rejects a home inside the work tree even when a parent symlink points outside it", async () => {
    const project = join(temp, "project");
    await mkdir(project);
    await mkdir(join(project, ".git"));
    const external = join(temp, "external");
    await mkdir(external);
    const alias = join(project, "alias");
    await symlink(external, alias);
    vi.spyOn(process, "cwd").mockReturnValue(project);

    await expectUnavailableHome({ CLOUD_TAILSCALE_HOME: join(alias, "runtime") });
  });

  it("allows an external home sharing the Git work tree's path prefix", async () => {
    const project = join(temp, "project");
    const cwd = join(project, "src");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(project, ".git"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const home = join(temp, "project-runtime", "private");

    const paths = await ensurePaths({ CLOUD_TAILSCALE_HOME: home });

    expect(paths.home).toBe(home);
    for (const path of [paths.home, paths.binDir, paths.runDir, paths.stateDir]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
  });
});
