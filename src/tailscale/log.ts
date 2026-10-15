import { spawn } from "node:child_process";
import { type FileHandle, open } from "node:fs/promises";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { CtError } from "../core/errors.js";
import { mask } from "../core/output.js";

export interface LogWriterInput {
  command: string;
  args: readonly string[];
  logFile: string;
  secrets: string[];
}

/** Tailscale 1.104.1 logs this only after receiving the DERP ServerInfoMessage. */
export async function hasConnectedDerp(path: string): Promise<boolean> {
  let file: FileHandle;
  try {
    file = await open(path, "r");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
  const connected = new Set<string>();
  try {
    // Stream the session log: the successful handshake may be older than the diagnostic tail.
    for await (const line of file.readLines()) {
      const success = /magicsock: derp-(\d+) connected; connGen=/.exec(line);
      const failure = /derp\.Recv\(derp-(\d+)\):|closing connection to derp-(\d+)\b/.exec(line);
      if (success) connected.add(success[1]);
      if (failure) connected.delete(failure[1] ?? failure[2]);
      if (/magicsock: 0 active derp conns\b/.test(line)) connected.clear();
    }
    return connected.size > 0;
  } finally {
    await file.close();
  }
}

/** Buffer complete lines so a credential split across pipe chunks is never written raw. */
export async function writeMaskedLines(
  stream: Readable,
  write: (line: string) => void,
): Promise<void> {
  stream.setEncoding("utf8");
  let pending = "";
  let oversized = false;
  let privateKey = false;
  const line = () => {
    if (oversized) {
      // An arbitrarily long line must not force either unbounded memory or an unsafe flush.
      write("[REDACTED oversized log line]\n");
    } else if (privateKey || /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(pending)) {
      if (!privateKey) write("[REDACTED]\n");
      privateKey = !/-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(pending);
    } else {
      write(`${mask(pending)}\n`);
    }
    pending = "";
    oversized = false;
  };
  for await (const chunk of stream) {
    const parts = String(chunk).split("\n");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!oversized) {
        if (pending.length + part.length > 65_536) {
          pending = "";
          oversized = true;
          // Until a known boundary, also suppress potential PEM continuation lines.
          privateKey = true;
        } else {
          pending += part;
        }
      }
      if (i < parts.length - 1) line();
    }
  }
  if (pending || oversized) line();
}

/** The detached helper owns both output pipes after the CLI exits. No raw log fd is inherited. */
export function spawnLoggedDaemon(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; logFile: string; secrets: string[] },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const helper = spawn(
      process.execPath,
      [fileURLToPath(new URL("./log-writer.js", import.meta.url))],
      {
        env: options.env,
        detached: true,
        shell: false,
        stdio: ["pipe", "ignore", "ignore", "ipc"],
      },
    );
    const fail = () => {
      clearTimeout(timer);
      reject(
        new CtError(
          "PROCESS_FAILED",
          "Could not start the Tailscale daemon with masked logging.",
          "Check that Node.js and tailscaled are executable and the private log directory is writable.",
        ),
      );
    };
    const timer = setTimeout(() => {
      helper.kill();
      fail();
    }, 5_000);
    helper.once("error", fail);
    helper.once("exit", fail);
    helper.stdin?.on("error", fail);
    helper.once("message", (message: { pid?: number }) => {
      if (!Number.isSafeInteger(message.pid) || (message.pid ?? 0) <= 1) {
        fail();
        return;
      }
      clearTimeout(timer);
      helper.removeListener("exit", fail);
      helper.unref();
      resolve(message.pid as number);
    });
    // Secrets travel only over an anonymous pipe, never argv, a file, or the daemon's env.
    const input: LogWriterInput = {
      command,
      args,
      logFile: options.logFile,
      secrets: options.secrets,
    };
    helper.stdin?.end(JSON.stringify(input));
  });
}
