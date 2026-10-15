import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const bin = fileURLToPath(new URL("../../dist/cli/bin.js", import.meta.url));
let files: string[];
let version: string;

beforeAll(async () => {
  const { stdout } = await exec("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    env: { ...process.env, npm_config_cache: "/tmp/npm-cache" },
    timeout: 60_000,
  });
  const [packed] = JSON.parse(stdout) as { files: { path: string }[] }[];
  files = packed.files.map(({ path }) => path);
  ({ version } = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ));
}, 60_000);

async function cli(args: string[]) {
  // These package checks need neither credentials nor a daemon, even outside the project.
  return exec(process.execPath, [bin, ...args], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH },
    timeout: 10_000,
  });
}

describe("release package", () => {
  it("ships every compiled runtime module and the skill, README, license, and manifest", async () => {
    const sources = await readdir(new URL("../../src/", import.meta.url), { recursive: true });
    const modules = sources
      .filter((path) => path.endsWith(".ts"))
      .map((path) => `dist/${path.slice(0, -3)}.js`);
    expect(files).toEqual(
      expect.arrayContaining([
        ...modules,
        "skill/SKILL.md",
        "README.md",
        "LICENSE",
        "package.json",
      ]),
    );
  });

  it("excludes tests, sources, fixtures, docs, and other development or local files", () => {
    const allowed =
      /^(?:dist\/(?:cli|core|tailscale|ssh)\/.+\.js|skill\/SKILL\.md|README\.md|LICENSE|package\.json)$/;
    expect(files.filter((path) => !allowed.test(path))).toEqual([]);
  });

  it("prints the manifest version from the built CLI independently of cwd", async () => {
    const { stdout, stderr } = await cli(["--version"]);
    expect(stdout).toBe(`${version}\n`);
    expect(stderr).toBe("");
  });

  it("uses the standard result envelope for JSON version output", async () => {
    const { stdout, stderr } = await cli(["--version", "--json"]);
    expect(JSON.parse(stdout)).toEqual({ ok: true, message: version, data: { version } });
    expect(stderr).toBe("");
  });

  it("shows help with the version option", async () => {
    const { stdout, stderr } = await cli(["--help"]);
    expect(stdout).toContain("Usage: cloud-tailscale");
    expect(stdout).toContain("--version");
    expect(stderr).toBe("");
  });

  it("prints the shipped skill from the built CLI independently of cwd", async () => {
    const { stdout, stderr } = await cli(["skill", "--print"]);
    const skill = await readFile(new URL("../../skill/SKILL.md", import.meta.url), "utf8");
    expect(stdout.trimEnd()).toBe(skill.trimEnd());
    expect(stderr).toBe("");
  });
});
