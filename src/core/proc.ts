import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { CtError } from "./errors.js";

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string | Buffer;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
}

/** Nonzero exits are returned so callers can classify tool-specific failures. */
export function run(
  cmd: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...options.env },
      // Isolate the process group so timeouts also terminate descendants.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            // Settle at the deadline even if inherited pipes never close.
            reject(
              new CtError(
                "PROCESS_TIMEOUT",
                `${cmd} timed out after ${options.timeoutMs} ms.`,
                "Check the tool's connection and retry.",
              ),
            );
            try {
              if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
            } catch {
              // The group may have exited just before the timeout fired.
              child.kill("SIGKILL");
            } finally {
              child.stdin.destroy();
              child.stdout.destroy();
              child.stderr.destroy();
              child.unref();
            }
          }, options.timeoutMs)
        : undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (cause) => {
      clearTimeout(timer);
      reject(
        new CtError(
          "PROCESS_FAILED",
          `Could not start ${cmd}.`,
          "Check that the tool is installed and executable.",
          { cause },
        ),
      );
    });
    // A child may close stdin before consuming all input. Its exit status still matters.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1, signal });
    });
  });
}

export interface DetachedOptions {
  env?: NodeJS.ProcessEnv;
  logFile: string;
}

/** The caller supplies a log path inside the private runtime directory. */
export async function spawnDetached(
  cmd: string,
  args: readonly string[],
  options: DetachedOptions,
): Promise<number> {
  const log = await open(
    options.logFile,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await log.chmod(0o600);
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(cmd, args, {
        env: { ...process.env, ...options.env },
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        shell: false,
      });
      child.once("error", (cause) => {
        reject(
          new CtError(
            "PROCESS_FAILED",
            `Could not start ${cmd}.`,
            "Check that the tool is installed and executable.",
            { cause },
          ),
        );
      });
      child.once("spawn", () => {
        if (child.pid === undefined) {
          reject(
            new CtError(
              "PROCESS_FAILED",
              `No process ID was returned for ${cmd}.`,
              "Retry starting the tool.",
            ),
          );
          return;
        }
        child.unref();
        resolve(child.pid);
      });
    });
  } finally {
    await log.close();
  }
}
