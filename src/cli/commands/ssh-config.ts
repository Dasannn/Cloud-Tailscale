import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CtError } from "../../core/errors.js";
import type { Result } from "../../core/output.js";
import { run } from "../../core/proc.js";
import { type SshPeer, writeSshConfig } from "../../ssh/config.js";

export interface SshConfigDependencies {
  onlinePeers: () => Promise<readonly SshPeer[]>;
  env?: NodeJS.ProcessEnv;
  ctsPath?: string;
}

export function createSshConfigCommand(dependencies: SshConfigDependencies) {
  return async (args: string[]): Promise<Result> => {
    if (args.length) {
      throw new CtError(
        "INVALID_ARGUMENT",
        "ssh-config does not accept arguments.",
        "Run cloud-tailscale ssh-config to update entries for online peers.",
      );
    }
    // Query peers first: the Phase 2 provider will ensure a connection (FR-9).
    const peers = await dependencies.onlinePeers();
    try {
      const result = await run("ssh", ["-V"], { timeoutMs: 5_000 });
      if (result.exitCode !== 0) throw new Error("ssh -V failed");
    } catch (cause) {
      throw new CtError(
        "SSH_CONFIG_FAILED",
        "OpenSSH is unavailable in this container.",
        "Install OpenSSH to use ssh-config, or use cloud-tailscale ssh directly.",
        { cause },
      );
    }
    const env = dependencies.env ?? process.env;
    const sshDir = join(env.HOME || homedir(), ".ssh");
    const configFile = join(sshDir, "config");
    const ctsPath = dependencies.ctsPath ?? fileURLToPath(new URL("../bin.js", import.meta.url));
    await writeSshConfig(sshDir, configFile, peers, ctsPath);
    const count = peers.filter((peer) => peer.online).length;
    return {
      ok: true,
      message: `Updated ${configFile} with SSH entries for ${count} online peers.`,
      data: { configFile, peers: count },
    };
  };
}
