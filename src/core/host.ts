import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { CtError } from "./errors.js";

export type HostAgent = "claude" | "codex" | "local";
export type TailscaleArch = "amd64" | "arm64";

export function detectHost(env: NodeJS.ProcessEnv = process.env): HostAgent {
  if (env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDECODE) return "claude";
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return "codex";
  return "local";
}

export function detectArch(arch: string = process.arch): TailscaleArch {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  throw new CtError(
    "UNSUPPORTED_ARCH",
    `Unsupported CPU architecture: ${arch}.`,
    "Use a Linux x86_64 or arm64 container.",
  );
}

export function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

export async function tunUsable(): Promise<boolean> {
  try {
    const handle = await open("/dev/net/tun", constants.O_RDWR);
    await handle.close();
    return true;
  } catch {
    return false;
  }
}
