import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CtError } from "./errors.js";

export interface RuntimePaths {
  home: string;
  binDir: string;
  runDir: string;
  stateDir: string;
  socketFile: string;
  pidFile: string;
  logFile: string;
  setupLogFile: string;
  knownHostsFile: string;
  configFile: string;
}

export async function resolveHome(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (env.CLOUD_TAILSCALE_HOME) return resolve(env.CLOUD_TAILSCALE_HOME);
  const userHome = env.HOME || homedir();
  try {
    await access(userHome, constants.W_OK);
    return join(userHome, ".cloud-tailscale");
  } catch {
    return join(env.TMPDIR || tmpdir(), "cloud-tailscale");
  }
}

export function getPaths(home: string): RuntimePaths {
  const binDir = join(home, "bin");
  const runDir = join(home, "run");
  return {
    home,
    binDir,
    runDir,
    stateDir: join(runDir, "state"),
    socketFile: join(runDir, "tailscaled.sock"),
    pidFile: join(runDir, "tailscaled.pid"),
    logFile: join(runDir, "tailscaled.log"),
    setupLogFile: join(home, "setup.log"),
    knownHostsFile: join(home, "known_hosts"),
    configFile: join(home, "config.json"),
  };
}

function containsPath(parent: string, path: string): boolean {
  const fromParent = relative(parent, path);
  return (
    fromParent === "" ||
    (fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent))
  );
}

/** Resolve symlinked parents even when the home has not been created yet. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (cause) {
    const parent = dirname(path);
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || parent === path) throw cause;
    return join(await canonicalPath(parent), basename(path));
  }
}

/** Find a work tree without Git, falling back to the canonical working directory. */
export async function findProjectRoot(cwd: string): Promise<string> {
  const directory = await realpath(cwd);
  let project = directory;
  while (true) {
    try {
      // A linked worktree has a .git file rather than a directory.
      await lstat(join(project, ".git"));
      return project;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    const parent = dirname(project);
    if (parent === project) return directory;
    project = parent;
  }
}

async function validateHome(home: string): Promise<void> {
  try {
    const cwd = await realpath(process.cwd());
    const resolvedHome = await canonicalPath(home);
    const project = await findProjectRoot(cwd);
    if (
      [home, resolvedHome].some((path) => containsPath(path, cwd) || containsPath(project, path))
    ) {
      throw new Error("The home overlaps the current project or contains the working directory.");
    }
  } catch (cause) {
    throw new CtError(
      "HOME_UNAVAILABLE",
      `Cannot safely use ${home} as the Cloud-Tailscale home outside the current project.`,
      "Set CLOUD_TAILSCALE_HOME to a private writable directory outside the project that is not an ancestor of the current working directory.",
      { cause },
    );
  }
}

export async function createPrivateDir(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    ) {
      throw new Error("The path must be a directory owned by the current user.");
    }
    await chmod(path, 0o700);
  } catch (cause) {
    throw new CtError(
      "HOME_UNAVAILABLE",
      `Cannot create a private Cloud-Tailscale directory at ${path}.`,
      "Set CLOUD_TAILSCALE_HOME to a writable directory owned by your user outside the project.",
      { cause },
    );
  }
}

export async function ensurePaths(env: NodeJS.ProcessEnv = process.env): Promise<RuntimePaths> {
  const paths = getPaths(resolve(await resolveHome(env)));
  await validateHome(paths.home);
  for (const path of [paths.home, paths.binDir, paths.runDir, paths.stateDir]) {
    await createPrivateDir(path);
  }
  return paths;
}
