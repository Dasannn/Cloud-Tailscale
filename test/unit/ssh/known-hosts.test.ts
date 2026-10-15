import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { utils } from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyHostKey } from "../../../src/ssh/known-hosts.js";
import { changedHostKey, hostKey } from "./server.js";

let temp: string;
beforeEach(async () => {
  temp = await mkdtemp("/tmp/cts-known-hosts-");
});
afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

function key(raw: string): Buffer {
  const parsed = utils.parseKey(raw);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("Invalid test key");
  return parsed.getPublicSSH();
}

describe("TOFU known hosts", () => {
  it("accepts the first key, reuses it, and repairs permissions", async () => {
    const file = join(temp, "private", "known_hosts");
    const options = { host: "PI", port: 22, key: key(hostKey.private), file };
    await verifyHostKey(options);
    const saved = await readFile(file, "utf8");
    expect(saved).toMatch(/^pi ecdsa-sha2-nistp256 /);
    expect(saved).not.toContain(hostKey.private);
    await chmod(file, 0o644);
    await verifyHostKey({ ...options, host: "pi" });
    expect(await readFile(file, "utf8")).toBe(saved);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(temp, "private"))).mode & 0o777).toBe(0o700);
  });

  it("rejects a changed key and keeps the original file", async () => {
    const file = join(temp, "known_hosts");
    const options = { host: "pi", port: 22, key: key(hostKey.private), file };
    await verifyHostKey(options);
    const saved = await readFile(file, "utf8");
    await expect(
      verifyHostKey({ ...options, key: key(changedHostKey.private) }),
    ).rejects.toMatchObject({ code: "HOST_KEY_CHANGED" });
    expect(await readFile(file, "utf8")).toBe(saved);
  });

  it("separates host and port identities, and serializes simultaneous first uses", async () => {
    const file = join(temp, "known_hosts");
    const options = { host: "fd7a:115c:a1e0::1", port: 2222, key: key(hostKey.private), file };
    await Promise.all([verifyHostKey(options), verifyHostKey(options)]);
    await verifyHostKey({ ...options, port: 22, key: key(changedHostKey.private) });
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(2);
    const results = await Promise.allSettled([
      verifyHostKey({ ...options, host: "new-peer" }),
      verifyHostKey({ ...options, host: "new-peer", key: key(changedHostKey.private) }),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "HOST_KEY_CHANGED" } });
  });

  it("refuses symlinks and malformed stores without overwriting them", async () => {
    const target = join(temp, "target");
    const file = join(temp, "known_hosts");
    await writeFile(target, "FAKE unchanged");
    await symlink(target, file);
    const options = { host: "pi", port: 22, key: key(hostKey.private), file };
    await expect(verifyHostKey(options)).rejects.toMatchObject({ code: "SSH_KNOWN_HOSTS_FAILED" });
    expect(await readFile(target, "utf8")).toBe("FAKE unchanged");
    await rm(file);
    await writeFile(file, "broken-entry");
    await expect(verifyHostKey(options)).rejects.toMatchObject({ code: "SSH_KNOWN_HOSTS_FAILED" });
    expect(await readFile(file, "utf8")).toBe("broken-entry");
  });
});
