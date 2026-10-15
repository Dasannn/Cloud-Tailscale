import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_BEGIN,
  CONFIG_END,
  generateSshConfig,
  replaceSshConfig,
  writeSshConfig,
} from "../../../src/ssh/config.js";

let temp: string;
beforeEach(async () => {
  temp = await mkdtemp("/tmp/cts-ssh-config-");
});
afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

const peers = [
  { name: "pi", ip: "100.64.0.1", online: true },
  { name: "offline", ip: "100.64.0.2", online: false },
  { name: "server.tailnet.ts.net", ip: "fd7a:115c:a1e0::1", online: true },
];

describe("OpenSSH configuration", () => {
  it("generates online entries with an absolute, shell-quoted ProxyCommand", () => {
    const block = generateSshConfig(peers, "/opt/FAKE path/it's-cts%bin");
    expect(block).toContain("Host pi\n  HostName 100.64.0.1\n");
    expect(block).toContain("ProxyCommand '/opt/FAKE path/it'\"'\"'s-cts%%bin' nc %h %p");
    expect(block).toContain("Host server.tailnet.ts.net");
    expect(block).not.toContain("offline");
    expect(block).not.toContain("Password");
    expect(block.endsWith(`Host *\n${CONFIG_END}\n`)).toBe(true);
  });

  it("replaces only its block, is idempotent, and removes stale peers", async () => {
    const sshDir = join(temp, ".ssh");
    const file = join(sshDir, "config");
    await mkdir(sshDir);
    const before = "# My configuration\nHost personal\n  User alice\n\n";
    const after = "# Keep this\nHost work\n  Port 2222\n";
    await writeFile(file, `${before}${generateSshConfig(peers, "/opt/cts")}${after}`);
    await chmod(file, 0o644);
    await writeSshConfig(sshDir, file, [peers[0]], "/opt/cts");
    const saved = await readFile(file, "utf8");
    expect(saved).toBe(`${before}${generateSshConfig([peers[0]], "/opt/cts")}${after}`);
    expect(saved).not.toContain("server.tailnet.ts.net");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(sshDir)).mode & 0o777).toBe(0o700);
    await writeSshConfig(sshDir, file, [peers[0]], "/opt/cts");
    expect(await readFile(file, "utf8")).toBe(saved);
  });

  it("creates a private config and handles empty peers and missing final newlines", async () => {
    const sshDir = join(temp, ".ssh");
    const file = join(sshDir, "config");
    await writeSshConfig(sshDir, file, [], "/opt/cts");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const block = generateSshConfig([], "/opt/cts");
    expect(replaceSshConfig("Host mine\n  User alice", block)).toBe(
      `Host mine\n  User alice\n${block}`,
    );
    expect(
      replaceSshConfig(`${CONFIG_BEGIN}\r\nHost old\r\n${CONFIG_END}\r\nHost other\r\n`, block),
    ).toBe(`${block}Host other\r\n`);
  });

  it.each([
    CONFIG_BEGIN,
    CONFIG_END,
    `${CONFIG_END}\n${CONFIG_BEGIN}`,
    `${CONFIG_BEGIN}\n${CONFIG_BEGIN}\n${CONFIG_END}`,
  ])("refuses malformed markers without overwriting the file: %j", async (contents) => {
    const file = join(temp, "config");
    await writeFile(file, contents);
    await expect(writeSshConfig(temp, file, peers, "/opt/cts")).rejects.toMatchObject({
      code: "SSH_CONFIG_FAILED",
    });
    expect(await readFile(file, "utf8")).toBe(contents);
  });

  it("rejects config injection and symbolic links", async () => {
    for (const name of ["*", "pi\n  Password evil", "!pi", "pi other"]) {
      expect(() => generateSshConfig([{ ...peers[0], name }], "/opt/cts")).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
    }
    expect(() => generateSshConfig(peers, "relative/cts")).toThrow();
    const target = join(temp, "target");
    const file = join(temp, "config");
    await writeFile(target, "FAKE unchanged");
    await symlink(target, file);
    await expect(writeSshConfig(temp, file, peers, "/opt/cts")).rejects.toMatchObject({
      code: "SSH_CONFIG_FAILED",
    });
    expect(await readFile(target, "utf8")).toBe("FAKE unchanged");
  });
});
