import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeHttp, fetch } from "../../../src/core/http.js";
import { ensurePaths, type RuntimePaths } from "../../../src/core/paths.js";
import { run } from "../../../src/core/proc.js";
import { ensureInstalled, findInstalled, resolveVersion } from "../../../src/tailscale/install.js";

vi.mock("../../../src/core/http.js", () => ({ fetch: vi.fn(), closeHttp: vi.fn() }));
vi.mock("../../../src/core/proc.js", () => ({ run: vi.fn() }));

let temp: string;
let paths: RuntimePaths;
const archive = Buffer.from("FAKE official static archive bytes; never executable");
const digest = createHash("sha256").update(archive).digest("hex");
const stable = "https://pkgs.tailscale.com/stable/";
const release = `${stable}tailscale_1.104.1_amd64.tgz`;

function response(body: string | Buffer, ok = true) {
  return {
    ok,
    arrayBuffer: async () => Buffer.from(body),
    body: { cancel: vi.fn() },
  } as unknown as Awaited<ReturnType<typeof fetch>>;
}

beforeEach(async () => {
  vi.clearAllMocks();
  temp = await mkdtemp("/tmp/cts-install-test-");
  paths = await ensurePaths({ CLOUD_TAILSCALE_HOME: temp });
  vi.mocked(fetch).mockImplementation(async (url) => {
    if (String(url).endsWith("?mode=json"))
      return response(
        await readFile(new URL("../../fixtures/tailscale/stable.json", import.meta.url)),
      );
    if (String(url).endsWith(".sha256")) return response(`${digest}\n`);
    return response(archive);
  });
  vi.mocked(run).mockImplementation(async (_cmd, args) => {
    const destination = args[args.indexOf("-C") + 1];
    await writeFile(join(destination, "tailscale"), "FAKE client");
    await writeFile(join(destination, "tailscaled"), "FAKE daemon");
    return { stdout: "", stderr: "", exitCode: 0, signal: null };
  });
});
afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("official static installer", () => {
  it("resolves TarballsVersion, verifies digest-only checksum, then atomically installs privately", async () => {
    const installed = await ensureInstalled({ paths, arch: "amd64", env: {} });
    expect(installed.version).toBe("1.104.1");
    expect(installed.directory).toBe(join(paths.binDir, "tailscale-1.104.1"));
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      `${stable}?mode=json`,
      `${release}.sha256`,
      release,
    ]);
    expect(run).toHaveBeenCalledExactlyOnceWith(
      "tar",
      expect.arrayContaining([
        "--strip-components=1",
        "--no-same-owner",
        "--no-same-permissions",
        "tailscale_1.104.1_amd64/tailscale",
        "tailscale_1.104.1_amd64/tailscaled",
      ]),
      { timeoutMs: 30_000 },
    );
    for (const file of [installed.directory, installed.tailscale, installed.tailscaled]) {
      expect((await stat(file)).mode & 0o777).toBe(0o700);
    }
    expect(await readdir(paths.binDir)).toEqual(["tailscale-1.104.1"]);
    expect(closeHttp).toHaveBeenCalled();
  });

  it("reuses a pinned verified installation without network or tar", async () => {
    const first = await ensureInstalled({ paths, version: "1.104.1", arch: "arm64" });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("_arm64.tgz"), expect.any(Object));
    vi.clearAllMocks();
    expect(await ensureInstalled({ paths, version: "1.104.1" })).toEqual(first);
    expect(fetch).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("uses CLI version before the environment pin and rejects path traversal versions", async () => {
    expect(await resolveVersion("1.104.1", { CLOUD_TAILSCALE_VERSION: "1.100.0" })).toBe("1.104.1");
    expect(await resolveVersion(undefined, { CLOUD_TAILSCALE_VERSION: "1.100.0" })).toBe("1.100.0");
    for (const version of ["../../FAKE", "", "1.2", "v1.104.1"]) {
      await expect(resolveVersion(version)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["0".repeat(64), "invalid checksum", `${digest}  filename.tgz`])(
    "installs nothing on checksum failure (%s)",
    async (checksum) => {
      vi.mocked(fetch).mockImplementation(async (url) =>
        response(String(url).endsWith(".sha256") ? checksum : archive),
      );
      await expect(ensureInstalled({ paths, version: "1.104.1" })).rejects.toMatchObject({
        code: "CHECKSUM_MISMATCH",
      });
      expect(run).not.toHaveBeenCalled();
      expect(await readdir(paths.binDir)).toEqual([]);
    },
  );

  it("reports HTTP failures with the host/network policy and cleans staging", async () => {
    vi.mocked(fetch).mockResolvedValue(response("FAKE denied", false));
    await expect(ensureInstalled({ paths, version: "1.104.1" })).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      next: expect.stringContaining("pkgs.tailscale.com"),
    });
    expect(await readdir(paths.binDir)).toEqual([]);
  });

  it("classifies failed body downloads and malformed stable metadata", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("FAKE reset"));
    await expect(resolveVersion(undefined, {})).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    vi.mocked(fetch).mockResolvedValueOnce(response('{"Version":"1.104.1"}'));
    await expect(resolveVersion(undefined, {})).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
  });

  it("does not publish a failed extraction", async () => {
    vi.mocked(run).mockResolvedValue({
      stdout: "",
      stderr: "FAKE tar failure",
      exitCode: 2,
      signal: null,
    });
    await expect(ensureInstalled({ paths, version: "1.104.1" })).rejects.toMatchObject({
      code: "INSTALL_FAILED",
    });
    expect(await readdir(paths.binDir)).toEqual([]);
  });

  it("finds a configured release locally and ignores incomplete installations", async () => {
    const installed = await ensureInstalled({ paths, version: "1.104.1" });
    await writeFile(paths.configFile, JSON.stringify({ version: "1.104.1" }));
    await mkdir(join(paths.binDir, "tailscale-1.106.0"));
    vi.clearAllMocks();
    expect(await findInstalled(paths)).toEqual(installed);
    expect(await findInstalled(paths, "1.106.0")).toBeUndefined();
    await chmod(installed.tailscale, 0o600);
    expect(await findInstalled(paths)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
