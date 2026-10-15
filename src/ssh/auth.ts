import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { userInfo } from "node:os";
import type { AnyAuthMethod } from "ssh2";
import { CtError } from "../core/errors.js";
import { registerSecret } from "../core/output.js";
import { getSshKey, getSshKeyFile, getSshPassword, getSshUser } from "../core/secrets.js";

export const SSH_AUTH_NEXT =
  "Set TS_SSH_KEY (private key content) or TS_SSH_KEY_FILE; alternatively set TS_SSH_PASSWORD in the environment's secrets. Check TS_SSH_USER or user@host and the peer's SSH permissions.";

export function validateHost(host: string): void {
  if (!host || (!isIP(host) && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host))) {
    throw new CtError(
      "INVALID_ARGUMENT",
      "An SSH host must be a peer name or IP address.",
      "Use cloud-tailscale ssh [user@]host -- command.",
    );
  }
}

export function resolveTarget(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): { host: string; user: string } {
  const parts = target.split("@");
  const host = parts.at(-1) ?? "";
  validateHost(host);
  const user = parts.length === 2 ? parts[0] : (getSshUser(env) ?? userInfo().username);
  if (parts.length > 2 || !user || /[\s\p{Cc}]/u.test(user)) {
    throw new CtError(
      "INVALID_ARGUMENT",
      "An SSH target must be [user@]host with a nonempty user.",
      "Specify user@host or set TS_SSH_USER.",
    );
  }
  return { host, user };
}

/** Explicit ssh2 strategies keep keys ahead of passwords (ssh2's default is the reverse). */
export async function getSshAuth(
  user: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AnyAuthMethod[]> {
  let key = getSshKey(env);
  const file = getSshKeyFile(env);
  const password = getSshPassword(env);
  if (!key && file) {
    try {
      key = registerSecret(await readFile(file, "utf8"));
    } catch (cause) {
      throw new CtError("SSH_AUTH_FAILED", "Cannot read TS_SSH_KEY_FILE.", SSH_AUTH_NEXT, {
        cause,
      });
    }
  }
  const methods: AnyAuthMethod[] = [];
  if (key) methods.push({ type: "publickey", username: user, key });
  if (password) methods.push({ type: "password", username: user, password });
  if (methods.length === 0) {
    throw new CtError("SSH_AUTH_FAILED", "No SSH credentials are configured.", SSH_AUTH_NEXT);
  }
  return methods;
}
