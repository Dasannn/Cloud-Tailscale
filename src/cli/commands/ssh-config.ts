import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CtError } from "../../core/errors.js";
import type { Result } from "../../core/output.js";
import { run } from "../../core/proc.js";
import { type SshPeer, writeSshConfig } from "../../ssh/config.js";
import { ensureConnected } from "../../tailscale/connect.js";

export interface SshConfigDependencies {
  onlinePeers?: () => Promise<readonly SshPeer[]>;
  env?: NodeJS.ProcessEnv;
  ctsPath?: string;
}

async function onlinePeers(env: NodeJS.ProcessEnv): Promise<SshPeer[]> {
  const { status } = await ensureConnected({ env });
  return Object.values(status.Peer ?? {})
    .flatMap((peer) => {
      const ip = peer.TailscaleIPs?.[0];
      if (peer.Online !== true || !ip) return [];
      return [{ name: peer.HostName || peer.DNSName?.replace(/\.$/, "") || ip, ip, online: true }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function createSshConfigCommand(dependencies: SshConfigDependencies = {}) {
  return async (args: string[]): Promise<Result> => {
    if (args.length) {
      throw new CtError(
        "INVALID_ARGUMENT",
        "ssh-config does not accept arguments.",
        "Run cloud-tailscale ssh-config to update entries for online peers.",
      );
    }
    const env = dependencies.env ?? process.env;
    const peers = await (dependencies.onlinePeers ?? (() => onlinePeers(env)))();
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
