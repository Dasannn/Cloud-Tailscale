import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { CtError } from "../core/errors.js";
import { detectArch, type TailscaleArch } from "../core/host.js";
import { closeHttp, fetch } from "../core/http.js";
import { createPrivateDir, type RuntimePaths } from "../core/paths.js";
import { run } from "../core/proc.js";

const STABLE = "https://pkgs.tailscale.com/stable/";
const VERSION = /^\d+\.\d+\.\d+$/;

export interface Installation {
  version: string;
  directory: string;
  tailscale: string;
  tailscaled: string;
}

function installation(paths: RuntimePaths, version: string): Installation {
  const directory = join(paths.binDir, `tailscale-${version}`);
  return {
    version,
    directory,
    tailscale: join(directory, "tailscale"),
    tailscaled: join(directory, "tailscaled"),
  };
}

function validVersion(version: string): string {
  if (!VERSION.test(version)) {
    throw new CtError(
      "INVALID_ARGUMENT",
      "The Tailscale version must have the form 1.104.1.",
      "Set --tailscale-version or CLOUD_TAILSCALE_VERSION to a stable release version.",
    );
  }
  return version;
}

async function usable(value: Installation): Promise<boolean> {
  try {
    if (!(await lstat(value.directory)).isDirectory()) return false;
    for (const file of [value.tailscale, value.tailscaled]) {
      if (!(await lstat(file)).isFile()) return false;
      await access(file, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/** Local inspection only: status/down must never download or resolve a release. */
export async function findInstalled(
  paths: RuntimePaths,
  version?: string,
): Promise<Installation | undefined> {
  if (version !== undefined) {
    const value = installation(paths, validVersion(version));
    return (await usable(value)) ? value : undefined;
  }
  try {
    const config = JSON.parse(await readFile(paths.configFile, "utf8"));
    if (typeof config.version === "string" && VERSION.test(config.version)) {
      const value = installation(paths, config.version);
      if (await usable(value)) return value;
    }
  } catch {
    // A new home has no runtime configuration yet.
  }
  let entries: string[];
  try {
    entries = await readdir(paths.binDir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  const versions = entries
    .map((entry) => entry.replace(/^tailscale-/, ""))
    .filter((entry) => VERSION.test(entry))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  for (const candidate of versions) {
    const value = installation(paths, candidate);
    if (await usable(value)) return value;
  }
  return undefined;
}

function downloadError(cause?: unknown): CtError {
  return new CtError(
    "DOWNLOAD_FAILED",
    "Could not download the official Tailscale release from pkgs.tailscale.com.",
    "Allow pkgs.tailscale.com in the environment's network policy and check the proxy and CA bundle settings.",
    { cause },
  );
}

async function download(url: string): Promise<Buffer> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw downloadError();
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (cause) {
    throw downloadError(cause);
  }
}

export async function resolveVersion(
  version?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const pinned = version ?? env.CLOUD_TAILSCALE_VERSION;
  if (pinned !== undefined) return validVersion(pinned);
  try {
    const metadata = JSON.parse((await download(`${STABLE}?mode=json`)).toString("utf8"));
    if (typeof metadata.TarballsVersion !== "string" || !VERSION.test(metadata.TarballsVersion)) {
      throw downloadError();
    }
    return metadata.TarballsVersion;
  } catch (cause) {
    throw downloadError(cause);
  } finally {
    await closeHttp();
  }
}

export async function ensureInstalled(options: {
  paths: RuntimePaths;
  version?: string;
  arch?: TailscaleArch;
  env?: NodeJS.ProcessEnv;
}): Promise<Installation> {
  const arch = options.arch ?? detectArch();
  const version = await resolveVersion(options.version, options.env);
  const existing = await findInstalled(options.paths, version);
  if (existing) return existing;

  const target = installation(options.paths, version);
  await createPrivateDir(options.paths.binDir);
  const temp = await mkdtemp(join(options.paths.binDir, ".install-"));
  try {
    const url = `${STABLE}tailscale_${version}_${arch}.tgz`;
    // The published .sha256 body is just the hexadecimal digest, without a filename.
    const checksum = (await download(`${url}.sha256`)).toString("utf8").trim();
    const tarball = await download(url);
    if (
      !/^[a-fA-F0-9]{64}$/.test(checksum) ||
      createHash("sha256").update(tarball).digest("hex") !== checksum.toLowerCase()
    ) {
      throw new CtError(
        "CHECKSUM_MISMATCH",
        "The Tailscale archive did not match its published SHA-256; nothing was installed.",
        "Retry the download from pkgs.tailscale.com and check the environment's proxy if it persists.",
      );
    }
    const archive = join(temp, "release.tgz");
    const extracted = join(temp, "bin");
    await writeFile(archive, tarball, { mode: 0o600, flag: "wx" });
    await createPrivateDir(extracted);
    // Extract only the two verified release members; do not unpack service files.
    const root = `tailscale_${version}_${arch}`;
    const result = await run(
      "tar",
      [
        "-xzf",
        archive,
        "-C",
        extracted,
        "--strip-components=1",
        "--no-same-owner",
        "--no-same-permissions",
        `${root}/tailscale`,
        `${root}/tailscaled`,
      ],
      { timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0) {
      throw new CtError(
        "INSTALL_FAILED",
        "Could not extract the verified Tailscale release.",
        "Check that tar and gzip are installed and CLOUD_TAILSCALE_HOME is writable, then retry.",
      );
    }
    for (const name of ["tailscale", "tailscaled"]) {
      const file = join(extracted, name);
      if (!(await lstat(file)).isFile()) {
        throw new CtError(
          "INSTALL_FAILED",
          "The Tailscale release did not contain regular executable files.",
          "Retry with an official stable release from pkgs.tailscale.com.",
        );
      }
      await chmod(file, 0o700);
    }
    try {
      await rename(extracted, target.directory);
    } catch (cause) {
      // Another setup invocation may have finished the same atomic installation.
      if (!(await usable(target))) throw cause;
    }
    return target;
  } catch (cause) {
    if (cause instanceof CtError) throw cause;
    throw new CtError(
      "INSTALL_FAILED",
      "Could not install the verified Tailscale binaries into the private home.",
      "Check that CLOUD_TAILSCALE_HOME is writable and has free space; remove an incomplete version directory in its bin directory and retry up.",
      { cause },
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
    await closeHttp();
  }
}
