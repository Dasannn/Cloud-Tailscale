import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { CtError } from "../core/errors.js";
import { createPrivateDir } from "../core/paths.js";
import { validateHost } from "./auth.js";

export const CONFIG_BEGIN = "# BEGIN cloud-tailscale";
export const CONFIG_END = "# END cloud-tailscale";

export interface SshPeer {
  name: string;
  ip: string;
  online: boolean;
}

export function generateSshConfig(peers: readonly SshPeer[], ctsPath: string): string {
  if (!isAbsolute(ctsPath) || /\p{Cc}/u.test(ctsPath)) {
    throw new CtError(
      "INVALID_ARGUMENT",
      "The SSH ProxyCommand needs an absolute path to cts.",
      "Use the absolute installed Cloud-Tailscale executable path.",
    );
  }
  // OpenSSH expands percent tokens before the shell interprets ProxyCommand.
  const executable = `'${ctsPath.replaceAll("%", "%%").replaceAll("'", "'\"'\"'")}'`;
  const blocks = peers
    .filter((peer) => peer.online)
    .map((peer) => {
      validateHost(peer.name);
      validateHost(peer.ip);
      return `Host ${peer.name}\n  HostName ${peer.ip}\n  ProxyCommand ${executable} nc %h %p`;
    });
  // Reset Host scope so settings below our block keep their original meaning.
  return `${CONFIG_BEGIN}\n${blocks.join("\n\n")}${blocks.length ? "\n" : ""}Host *\n${CONFIG_END}\n`;
}

export function replaceSshConfig(contents: string, block: string): string {
  const begins = [...contents.matchAll(/^# BEGIN cloud-tailscale\r?$/gm)];
  const ends = [...contents.matchAll(/^# END cloud-tailscale\r?$(?:\n)?/gm)];
  if (begins.length === 0 && ends.length === 0) {
    return `${contents}${contents && !contents.endsWith("\n") ? "\n" : ""}${block}`;
  }
  if (begins.length !== 1 || ends.length !== 1 || begins[0].index >= ends[0].index) {
    throw new CtError(
      "SSH_CONFIG_FAILED",
      "The Cloud-Tailscale markers in the SSH configuration are incomplete or duplicated.",
      "Repair the cloud-tailscale marker comments in ~/.ssh/config and retry.",
    );
  }
  return (
    contents.slice(0, begins[0].index) + block + contents.slice(ends[0].index + ends[0][0].length)
  );
}

export async function writeSshConfig(
  sshDir: string,
  configFile: string,
  peers: readonly SshPeer[],
  ctsPath: string,
): Promise<void> {
  const block = generateSshConfig(peers, ctsPath);
  try {
    await createPrivateDir(sshDir);
    const handle = await open(
      configFile,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) {
        throw new Error("The SSH config must be a regular file owned by the current user.");
      }
      const contents = await handle.readFile("utf8");
      const updated = replaceSshConfig(contents, block);
      await handle.chmod(0o600);
      if (updated !== contents) {
        await handle.write(updated, 0, "utf8");
        await handle.truncate(Buffer.byteLength(updated));
      }
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (cause instanceof CtError) throw cause;
    throw new CtError(
      "SSH_CONFIG_FAILED",
      "Cannot update the user's SSH configuration.",
      "Check ~/.ssh/config is a regular file owned by your user and ~/.ssh is writable.",
      { cause },
    );
  }
}
