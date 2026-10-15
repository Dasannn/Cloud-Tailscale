import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSecrets, mask } from "../../../src/core/output.js";
import {
  getAuthKey,
  getSshKey,
  getSshKeyFile,
  getSshPassword,
  getSshUser,
  registerEnvironmentSecrets,
} from "../../../src/core/secrets.js";

afterEach(() => {
  clearSecrets();
  vi.unstubAllEnvs();
});

describe("secret getters", () => {
  it("prefers TS_AUTHKEY and registers both auth key values", () => {
    const env = { TS_AUTHKEY: "tskey-auth-FAKE", TAILSCALE_AUTHKEY: "FAKE-fallback" };
    expect(getAuthKey(env)).toBe(env.TS_AUTHKEY);
    expect(mask(`${env.TS_AUTHKEY} ${env.TAILSCALE_AUTHKEY}`)).toBe("[REDACTED] [REDACTED]");
  });

  it("falls back for empty or missing TS_AUTHKEY", () => {
    expect(getAuthKey({ TAILSCALE_AUTHKEY: "tskey-auth-FAKE" })).toBe("tskey-auth-FAKE");
    expect(getAuthKey({ TS_AUTHKEY: "", TAILSCALE_AUTHKEY: "tskey-auth-FAKE" })).toBe(
      "tskey-auth-FAKE",
    );
    expect(getAuthKey({})).toBeUndefined();
  });

  it.each([
    [getSshKey, "TS_SSH_KEY", "FAKE-private-key\nwith whitespace\n"],
    [getSshKeyFile, "TS_SSH_KEY_FILE", "/tmp/FAKE-key-file"],
    [getSshPassword, "TS_SSH_PASSWORD", " FAKE-password "],
  ] as const)("reads and registers %s / %s", (getter, variable, value) => {
    expect(getter({ [variable]: value })).toBe(value);
    expect(mask(`before${value}after`)).toBe("before[REDACTED]after");
    expect(getter({})).toBeUndefined();
    expect(getter({ [variable]: "" })).toBeUndefined();
  });

  it.each(["root", "code"])("reads SSH user %s without registering it as a secret", (user) => {
    expect(getSshUser({ TS_SSH_USER: user })).toBe(user);
    expect(mask(`User ${user} can see code.`)).toBe(`User ${user} can see code.`);
    expect(getSshUser({})).toBeUndefined();
    expect(getSshUser({ TS_SSH_USER: "" })).toBeUndefined();
  });

  it("defaults to the process environment", () => {
    vi.stubEnv("TS_AUTHKEY", "tskey-auth-FAKE");
    vi.stubEnv("TS_SSH_KEY", "FAKE-key");
    vi.stubEnv("TS_SSH_KEY_FILE", "/tmp/FAKE-key");
    vi.stubEnv("TS_SSH_PASSWORD", "FAKE-password");
    vi.stubEnv("TS_SSH_USER", "FAKE-user");
    expect(getAuthKey()).toBe("tskey-auth-FAKE");
    expect(getSshKey()).toBe("FAKE-key");
    expect(getSshKeyFile()).toBe("/tmp/FAKE-key");
    expect(getSshPassword()).toBe("FAKE-password");
    expect(getSshUser()).toBe("FAKE-user");
  });

  it("registers all environment secrets before any command can emit them", () => {
    const env = {
      TS_AUTHKEY: "tskey-auth-FAKE",
      TAILSCALE_AUTHKEY: "FAKE-fallback",
      TS_SSH_KEY: "FAKE-key",
      TS_SSH_KEY_FILE: "/tmp/FAKE-key-file",
      TS_SSH_PASSWORD: "FAKE-password",
    };
    registerEnvironmentSecrets({ ...env, TS_SSH_USER: "root" });
    for (const value of Object.values(env)) expect(mask(value)).toBe("[REDACTED]");
    expect(mask("SSH user root")).toBe("SSH user root");
  });

  it.each(["TS_AUTHKEY", "TAILSCALE_AUTHKEY", "TS_SSH_KEY", "TS_SSH_KEY_FILE", "TS_SSH_PASSWORD"])(
    "registers short environment secrets from %s",
    (variable) => {
      registerEnvironmentSecrets({ [variable]: "x" });
      expect(mask("x")).toBe("[REDACTED]");
    },
  );
});
