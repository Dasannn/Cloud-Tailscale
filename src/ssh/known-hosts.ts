import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { CtError } from "../core/errors.js";
import { createPrivateDir } from "../core/paths.js";
import { validateHost } from "./auth.js";

// Serialize verifications in this process so two sessions cannot trust different first keys.
const pending = new Map<string, Promise<void>>();

export interface HostKey {
  host: string;
  port: number;
  key: Buffer;
  file: string;
}

async function checkHostKey({ host, port, key, file }: HostKey): Promise<void> {
  validateHost(host);
  const name = port === 22 ? host.toLowerCase() : `[${host.toLowerCase()}]:${port}`;
  try {
    await createPrivateDir(dirname(file));
    const handle = await open(
      file,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) {
        throw new Error("The known hosts file must be owned by the current user.");
      }
      await handle.chmod(0o600);
      const contents = await handle.readFile("utf8");
      const length = key.readUInt32BE(0);
      const algorithm = key.subarray(4, 4 + length).toString("ascii");
      if (!/^[a-zA-Z0-9@._+-]+$/.test(algorithm) || length > key.length - 4) {
        throw new Error("Invalid SSH host key.");
      }
      const encoded = key.toString("base64");
      let found = false;
      for (const line of contents.split(/\r?\n/)) {
        if (!line.trim() || line.trimStart().startsWith("#")) continue;
        const [savedHost, savedAlgorithm, savedKey] = line.trim().split(/\s+/);
        if (!savedHost || !savedAlgorithm || !savedKey) {
          throw new Error("Malformed known hosts file.");
        }
        if (savedHost !== name) continue;
        if (savedAlgorithm !== algorithm || savedKey !== encoded) {
          throw new CtError(
            "HOST_KEY_CHANGED",
            `The SSH host key for ${name} has changed.`,
            "Verify the peer's host key with its owner. Only after verification, remove its old entry from Cloud-Tailscale's known_hosts and retry.",
          );
        }
        found = true;
      }
      if (!found) {
        const separator = contents && !contents.endsWith("\n") ? "\n" : "";
        await handle.writeFile(`${separator}${name} ${algorithm} ${encoded}\n`);
      }
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (cause instanceof CtError) throw cause;
    throw new CtError(
      "SSH_KNOWN_HOSTS_FAILED",
      "Cannot verify or save the SSH host key.",
      "Check the known_hosts file in CLOUD_TAILSCALE_HOME is a regular file owned by your user and the home is writable.",
      { cause },
    );
  }
}

export async function verifyHostKey(options: HostKey): Promise<void> {
  const previous = pending.get(options.file) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => checkHostKey(options));
  pending.set(options.file, current);
  try {
    await current;
  } finally {
    if (pending.get(options.file) === current) pending.delete(options.file);
  }
}
