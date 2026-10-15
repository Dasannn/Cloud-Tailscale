import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clearSecrets, registerSecret } from "../../../src/core/output.js";
import { run } from "../../../src/core/proc.js";
import { hasConnectedDerp, writeMaskedLines } from "../../../src/tailscale/log.js";

afterEach(clearSecrets);

describe("masking daemon output before persistence", () => {
  it("buffers split credentials and UTF-8, masks URL userinfo, and flushes an unterminated line", async () => {
    registerSecret("FAKE-password");
    const raw =
      "register: tskey-auth-FAKE-token\nproxy http://FAKE-user:FAKE%40pass@proxy.example:8080\nFAKE-password €";
    const written: string[] = [];
    // Deliberately split every credential and the multibyte character across pipe chunks.
    await writeMaskedLines(
      Readable.from([...Buffer.from(raw)].map((byte) => Buffer.from([byte]))),
      (line) => written.push(line),
    );
    expect(written.join("")).toBe(
      "register: [REDACTED]\nproxy http://[REDACTED]@proxy.example:8080\n[REDACTED] €\n",
    );
    for (const line of written) {
      expect(line).not.toMatch(/tskey-|FAKE-(?:token|user|password)|FAKE%40pass/);
    }
  });
  it("suppresses multiline and truncated private key bodies", async () => {
    const written: string[] = [];
    await writeMaskedLines(
      Readable.from([
        "start\n-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-private-body\n",
        "FAKE-more-body\n-----END OPENSSH PRIVATE KEY-----\nnormal\n",
        "-----BEGIN RSA PRIVATE KEY-----\nFAKE-truncated-body",
      ]),
      (line) => written.push(line),
    );
    expect(written.join("")).toBe("start\n[REDACTED]\nnormal\n[REDACTED]\n");
  });
  it("discards oversized lines without persisting partial credentials", async () => {
    const written: string[] = [];
    await writeMaskedLines(
      Readable.from(["x".repeat(65_536), "tskey-auth-FAKE-overflow\n"]),
      (line) => written.push(line),
    );
    expect(written).toEqual(["[REDACTED oversized log line]\n"]);
  });
});

describe("confirmed DERP handshake signal", () => {
  it("requires ServerInfo acknowledgement and invalidates it on receive/close errors", async () => {
    const temp = await mkdtemp("/tmp/cts-derp-log-test-");
    const path = join(temp, "tailscaled.log");
    try {
      expect(await hasConnectedDerp(path)).toBe(false);
      const assigned =
        "magicsock: home is now derp-1 (nyc)\nmagicsock: 1 active derp conns: derp-1=cr0s,wr0s\n";
      const handshake = "magicsock: derp-1 connected; connGen=1\n";
      await writeFile(path, assigned);
      expect(await hasConnectedDerp(path)).toBe(false);
      await writeFile(path, assigned + handshake + "FAKE routine log\n".repeat(10_000));
      expect(await hasConnectedDerp(path)).toBe(true);
      for (const failure of [
        "magicsock: [FAKE] derp.Recv(derp-1): proxyconnect tcp: connection refused\n",
        "magicsock: closing connection to derp-1 (rebind), age 1s\n",
        "magicsock: 0 active derp conns\n",
      ]) {
        await writeFile(path, assigned + handshake + failure);
        expect(await hasConnectedDerp(path)).toBe(false);
        await writeFile(path, assigned + handshake + failure + handshake);
        expect(await hasConnectedDerp(path)).toBe(true);
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

describe("detached masked log writer", () => {
  let temp: string;
  let module: string;
  beforeAll(async () => {
    temp = await mkdtemp("/tmp/cts-log-writer-test-");
    // Exercise the actual shipped JS helper, independently of Vitest's TypeScript loader.
    const build = join(temp, "build");
    const result = await run(
      process.execPath,
      [
        fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url)),
        "-p",
        fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
        "--outDir",
        build,
      ],
      { timeoutMs: 10_000 },
    );
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    await writeFile(join(build, "package.json"), '{"type":"module"}');
    module = pathToFileURL(join(build, "tailscale/log.js")).href;
  });
  afterAll(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it("keeps consuming and masking both pipes after the launching CLI exits", async () => {
    const logFile = join(temp, "detached.log");
    const child = `
      const guard = setTimeout(() => process.exit(1), 3000);
      const poll = setInterval(() => {
        try { process.kill(Number(process.argv[1]), 0); return; } catch {}
        clearInterval(poll);
        process.stdout.write('FAKE parent exited\\nregister: tskey-auth-');
        setTimeout(() => {
          process.stdout.write('FAKE-key\\nFAKE-secret\\n');
          process.stderr.write('proxy http://FAKE-user:FAKE-pass@proxy.example:8080\\n-----BEGIN PRIVATE KEY-----\\nFAKE-private-body\\n-----END PRIVATE KEY-----\\n');
          process.stderr.write('FAKE-first-line\\nFAKE-second-line\\n');
          process.stdout.write('FAKE done\\n');
          clearTimeout(guard);
        }, 10);
      }, 10);
    `;
    const launcher = `
      import { spawnLoggedDaemon } from ${JSON.stringify(module)};
      const pid = await spawnLoggedDaemon(process.execPath, ['-e', ${JSON.stringify(child)}, String(process.pid)], {
        env: { PATH: process.env.PATH }, logFile: ${JSON.stringify(logFile)}, secrets: ['FAKE-secret', 'FAKE-first-line\\nFAKE-second-line']
      });
      process.stdout.write(String(pid));
    `;
    const result = await run(process.execPath, ["--input-type=module", "-e", launcher], {
      timeoutMs: 2_000,
    });
    expect(result.exitCode).toBe(0);
    expect(Number(result.stdout)).toBeGreaterThan(1);
    await expect
      .poll(async () => (await readFile(logFile, "utf8")).includes("FAKE done\n"))
      .toBe(true);
    const log = await readFile(logFile, "utf8");
    expect(log).toContain("FAKE parent exited\n");
    expect(log).toContain("proxy http://[REDACTED]@proxy.example:8080");
    expect(log).not.toMatch(
      /tskey-|FAKE-(?:key|secret|user|pass|private-body|first-line|second-line)/,
    );
    expect((await stat(logFile)).mode & 0o777).toBe(0o600);
  });
  it("reports failed daemon and log setup without raw error details", async () => {
    for (const logFile of [join(temp, "failed-spawn.log"), join(temp, "missing", "failed.log")]) {
      const launcher = `
        import { spawnLoggedDaemon } from ${JSON.stringify(module)};
        try { await spawnLoggedDaemon('/FAKE-no-executable', [], { env: {}, logFile: ${JSON.stringify(logFile)}, secrets: [] }); }
        catch (error) { process.stdout.write(error.code); }
      `;
      const result = await run(process.execPath, ["--input-type=module", "-e", launcher], {
        timeoutMs: 2_000,
      });
      expect(result).toMatchObject({ stdout: "PROCESS_FAILED", stderr: "", exitCode: 0 });
    }
  });
});
