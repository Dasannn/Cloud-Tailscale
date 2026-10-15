import { registerSecret } from "./output.js";

export function getAuthKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const primary = registerSecret(env.TS_AUTHKEY);
  const fallback = registerSecret(env.TAILSCALE_AUTHKEY);
  return primary ?? fallback;
}

export function getSshKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return registerSecret(env.TS_SSH_KEY);
}

export function getSshKeyFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return registerSecret(env.TS_SSH_KEY_FILE);
}

export function getSshPassword(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return registerSecret(env.TS_SSH_PASSWORD);
}

export function getSshUser(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.TS_SSH_USER || undefined;
}

/** Register every nonempty environment secret before dispatch, including for argument errors. */
export function registerEnvironmentSecrets(env: NodeJS.ProcessEnv = process.env): void {
  getAuthKey(env);
  getSshKey(env);
  getSshKeyFile(env);
  getSshPassword(env);
}
