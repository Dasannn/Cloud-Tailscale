import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CtError } from "./errors.js";
import { createPrivateDir, findProjectRoot } from "./paths.js";
import { run } from "./proc.js";

// This relative URL works from both src/core and the packaged dist/core.
export const skillPath = new URL("../../skill/SKILL.md", import.meta.url);
const MANAGED_MARKER = "<!-- cloud-tailscale:managed-skill -->";

export interface SkillInstallation {
  path: string;
  action: "installed" | "updated" | "unchanged";
}

export async function readSkill(): Promise<string> {
  try {
    return await readFile(skillPath, "utf8");
  } catch (cause) {
    throw new CtError(
      "SKILL_INSTALL_FAILED",
      "Cannot read the SKILL.md shipped with Cloud-Tailscale.",
      "Reinstall cloud-tailscale from npm, then retry the skill command.",
      { cause },
    );
  }
}

/** Recognize our own versions without treating a user's same-named skill as ours. */
export function isCloudTailscaleSkill(text: string): boolean {
  return /^---\r?\nname: cloud-tailscale\r?\n/.test(text) && text.includes(MANAGED_MARKER);
}

function conflict(path: string, cause?: unknown): CtError {
  return new CtError(
    "SKILL_CONFLICT",
    `The existing skill path at ${path} is not a managed Cloud-Tailscale file; it was left untouched.`,
    "Review the existing path and move it manually if you want Cloud-Tailscale to install there.",
    { cause },
  );
}

async function writeSkill(
  root: string,
  directories: string[],
  privateDirectory: boolean,
): Promise<SkillInstallation> {
  const content = await readSkill();
  const directory = join(root, ...directories);
  const path = join(directory, "SKILL.md");
  try {
    let parent = root;
    for (const component of directories) {
      parent = join(parent, component);
      try {
        await mkdir(parent, { mode: privateDirectory ? 0o700 : 0o755 });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      }
      // Do not follow a repository skill path into another directory or file.
      if (!(await lstat(parent)).isDirectory()) throw conflict(parent);
    }

    const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const { file, action } = await open(path, flags | constants.O_CREAT | constants.O_EXCL, 0o600)
      .then((file) => ({ file, action: "installed" as const }))
      .catch(async (cause: NodeJS.ErrnoException) => {
        if (cause.code !== "EEXIST") throw cause;
        try {
          return { file: await open(path, flags), action: "updated" as const };
        } catch (cause) {
          if (["ELOOP", "EISDIR"].includes((cause as NodeJS.ErrnoException).code ?? "")) {
            throw conflict(path, cause);
          }
          throw cause;
        }
      });
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) throw conflict(path);
      if (action === "updated") {
        const previous = await file.readFile("utf8");
        if (!isCloudTailscaleSkill(previous)) throw conflict(path);
        if (previous === content) return { path, action: "unchanged" };
      }
      if (privateDirectory) await createPrivateDir(directory);
      const buffer = Buffer.from(content);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, offset);
        if (bytesWritten === 0) throw new Error("The skill write made no progress.");
        offset += bytesWritten;
      }
      await file.truncate(buffer.length);
      return { path, action };
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (cause instanceof CtError && cause.code === "SKILL_CONFLICT") throw cause;
    throw new CtError(
      "SKILL_INSTALL_FAILED",
      `Cannot install the Cloud-Tailscale skill at ${path}.`,
      privateDirectory
        ? "Make the Claude Code user skill directory writable, or use cloud-tailscale skill --print for this session."
        : "Check the repository skill directory's permissions, then retry cloud-tailscale skill --repo.",
      { cause },
    );
  }
}

async function gitRoot(cwd: string): Promise<string> {
  let root: string;
  try {
    const result = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeoutMs: 5_000,
    });
    root = result.stdout.replace(/\r?\n$/, "");
    if (result.exitCode !== 0 || !isAbsolute(root)) throw new Error("No Git working tree root.");
  } catch (cause) {
    throw new CtError(
      "GIT_ROOT_NOT_FOUND",
      "Cannot find a Git working tree root for the repository skill.",
      "Run cloud-tailscale skill --repo inside a Git working tree with git installed, or use skill --print.",
      { cause },
    );
  }
  return root;
}

export async function installSkill(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SkillInstallation> {
  const home = resolve(env.HOME || homedir());
  const project = await gitRoot(process.cwd()).catch(() => findProjectRoot(process.cwd()));
  const canonicalHome = await realpath(home).catch(() => home);
  for (const candidate of [home, canonicalHome]) {
    const fromProject = relative(project, join(candidate, ".claude", "skills", "cloud-tailscale"));
    if (
      fromProject === "" ||
      (!isAbsolute(fromProject) && fromProject !== ".." && !fromProject.startsWith(`..${sep}`))
    ) {
      throw new CtError(
        "SKILL_INSTALL_FAILED",
        "The Claude Code user skill directory is inside the current project.",
        "Use a HOME outside the project for skill --install, or explicitly use skill --repo to add the repository skill.",
      );
    }
  }
  return writeSkill(home, [".claude", "skills", "cloud-tailscale"], true);
}

export async function installRepoSkill(cwd: string = process.cwd()): Promise<SkillInstallation> {
  return writeSkill(await gitRoot(cwd), [".agents", "skills", "cloud-tailscale"], false);
}
