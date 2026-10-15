import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSecrets, mask } from "../../../src/core/output.js";
import { getSshAuth, resolveTarget } from "../../../src/ssh/auth.js";

let temp: string;
beforeEach(async () => {
  temp = await mkdtemp("/tmp/cts-ssh-auth-");
});
afterEach(async () => {
  clearSecrets();
  await rm(temp, { recursive: true, force: true });
});

describe("SSH target and credentials", () => {
  it("chooses the explicit user, environment user, then operating system user", () => {
    expect(resolveTarget("alice@pi", { TS_SSH_USER: "bob" })).toEqual({
      host: "pi",
      user: "alice",
    });
    expect(resolveTarget("100.64.0.1", { TS_SSH_USER: "bob" })).toEqual({
      host: "100.64.0.1",
      user: "bob",
    });
    expect(resolveTarget("fd7a:115c:a1e0::1", {})).toEqual({
      host: "fd7a:115c:a1e0::1",
      user: userInfo().username,
    });
  });

  it.each(["", "@pi", "alice@", "a@b@pi", "-pi", "pi\nHost evil", "pi:22", "a b@pi"])(
    "rejects invalid target %j",
    (target) => {
      expect(() => resolveTarget(target, {})).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
    },
  );

  it("uses inline key content before a file and tries a password last", async () => {
    const methods = await getSshAuth("alice", {
      TS_SSH_KEY: "FAKE-inline-key",
      TS_SSH_KEY_FILE: "/FAKE-unreadable",
      TS_SSH_PASSWORD: "FAKE-password",
    });
    expect(methods).toEqual([
      { type: "publickey", username: "alice", key: "FAKE-inline-key" },
      { type: "password", username: "alice", password: "FAKE-password" },
    ]);
    expect(mask("FAKE-inline-key FAKE-password /FAKE-unreadable")).toBe(
      "[REDACTED] [REDACTED] [REDACTED]",
    );
  });

  it("reads and registers the file contents without writing a copy", async () => {
    const file = join(temp, "key");
    await writeFile(file, "FAKE-key-from-file\n");
    expect(await getSshAuth("alice", { TS_SSH_KEY_FILE: file })).toEqual([
      { type: "publickey", username: "alice", key: "FAKE-key-from-file\n" },
    ]);
    expect(mask("FAKE-key-from-file\n")).toBe("[REDACTED]");
  });

  it("explains missing credentials and unreadable key files", async () => {
    for (const env of [{}, { TS_SSH_KEY_FILE: join(temp, "missing") }]) {
      await expect(getSshAuth("alice", env)).rejects.toMatchObject({
        code: "SSH_AUTH_FAILED",
        next: expect.stringMatching(/TS_SSH_KEY.*TS_SSH_KEY_FILE.*TS_SSH_PASSWORD/),
      });
    }
  });
});
