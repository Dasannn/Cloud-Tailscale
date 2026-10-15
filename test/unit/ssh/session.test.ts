import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSecrets } from "../../../src/core/output.js";
import {
  openSsh,
  type SshSession,
  type TerminalInput,
  type TerminalOutput,
} from "../../../src/ssh/session.js";
import { changedHostKey, hostKey, memoryServer, password, userKey } from "./server.js";

let temp: string;
const servers: ReturnType<typeof memoryServer>[] = [];
const sessions: SshSession[] = [];
beforeEach(async () => {
  temp = await mkdtemp("/tmp/cts-ssh-session-");
});
afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  for (const server of servers.splice(0)) server.close();
  clearSecrets();
  await rm(temp, { recursive: true, force: true });
});

function server(options: Parameters<typeof memoryServer>[0] = {}) {
  const result = memoryServer(options);
  servers.push(result);
  return result;
}

async function connect(
  remote: ReturnType<typeof memoryServer>,
  env: NodeJS.ProcessEnv = { TS_SSH_PASSWORD: password },
) {
  const session = await openSsh({
    host: "pi",
    user: "alice",
    sock: remote.factory,
    knownHostsFile: join(temp, "known_hosts"),
    env,
    readyTimeoutMs: 1_000,
  });
  sessions.push(session);
  return session;
}

function capture() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  return { stream, value: () => text };
}

describe("SSH sessions over in-memory streams", () => {
  it.each([0, 7, 42, 255])("streams stdout/stderr and returns remote code %i", async (exitCode) => {
    const remote = server({
      exec(channel, command) {
        channel.write(`ran: ${command}\n`);
        channel.stderr.write("FAKE stderr\n");
        channel.exit(exitCode);
        channel.end();
      },
    });
    const session = await connect(remote);
    const stdout = capture();
    const stderr = capture();
    expect(await session.exec("uname -a", { stdout: stdout.stream, stderr: stderr.stream })).toBe(
      exitCode,
    );
    expect(stdout.value()).toBe("ran: uname -a\n");
    expect(stderr.value()).toBe("FAKE stderr\n");
    expect(remote.authAttempts).toEqual(["password"]);
    expect(remote.users).toEqual(["alice"]);
    expect(await readFile(join(temp, "known_hosts"), "utf8")).toMatch(/^pi ecdsa-sha2-nistp256 /);
  });

  it("authenticates with a signed key before offering a password", async () => {
    const remote = server();
    const session = await connect(remote, {
      TS_SSH_KEY: userKey.private,
      TS_SSH_PASSWORD: password,
    });
    expect(await session.exec("true", { stdout: capture().stream, stderr: capture().stream })).toBe(
      0,
    );
    expect(remote.authAttempts).toEqual(["publickey", "publickey"]);
  });

  it("falls back to the password when the key is rejected", async () => {
    const remote = server({ acceptKey: false });
    await connect(remote, { TS_SSH_KEY: userKey.private, TS_SSH_PASSWORD: password });
    expect(remote.authAttempts).toEqual(["publickey", "password"]);
  });

  it("maps remote signals to shell exit codes and handles missing exit status", async () => {
    for (const signal of ["TERM", undefined]) {
      const remote = server({
        exec(channel) {
          if (signal) channel.exit(signal);
          channel.end();
        },
      });
      const session = await connect(remote);
      expect(await session.exec("FAKE command")).toBe(signal ? 143 : 1);
    }
  });

  it("times out a stalled handshake and destroys the injected transport", async () => {
    const sock = new PassThrough();
    sock.resume();
    await expect(
      openSsh({
        host: "pi",
        user: "alice",
        sock: () => sock,
        knownHostsFile: join(temp, "known_hosts"),
        env: { TS_SSH_PASSWORD: password },
        readyTimeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "SSH_CONNECTION_FAILED" });
    expect(sock.destroyed).toBe(true);
  });

  it("reports authentication failures with the secret variable names", async () => {
    const remote = server({ acceptPassword: false, acceptKey: false });
    await expect(connect(remote)).rejects.toMatchObject({
      code: "SSH_AUTH_FAILED",
      next: expect.stringContaining("TS_SSH_PASSWORD"),
    });
  });

  it("trusts the same key again and refuses a changed server key before authentication", async () => {
    const first = await connect(server());
    first.close();
    const second = await connect(server());
    second.close();
    const changed = server({ hostPrivateKey: changedHostKey.private });
    await expect(connect(changed)).rejects.toMatchObject({ code: "HOST_KEY_CHANGED" });
    expect(changed.authAttempts).toEqual([]);
  });

  it("masks passwords, tokens, UTF-8, and PEM blocks split across output chunks", async () => {
    const remote = server({
      exec(channel) {
        const output = Buffer.from(
          `π🙂 ${"x".repeat(150)} ${password}\n${hostKey.private.trim()}\ntskey-auth-FAKE-long-token\n`,
        );
        for (let index = 0; index < output.length; index += 3)
          channel.write(output.subarray(index, index + 3));
        const error = `warning ${password} tskey-auth-FAKE\n`;
        for (const character of error) channel.stderr.write(character);
        channel.exit(0);
        channel.end();
      },
    });
    const session = await connect(remote);
    const stdout = capture();
    const stderr = capture();
    await session.exec("echo FAKE", { stdout: stdout.stream, stderr: stderr.stream });
    expect(stdout.value()).toBe(`π🙂 ${"x".repeat(150)} [REDACTED]\n[REDACTED]\n[REDACTED]\n`);
    expect(stderr.value()).toBe("warning [REDACTED] [REDACTED]\n");
  });

  it.each([
    { name: "password", value: password, split: 4, secret: password },
    {
      name: "JSON-escaped literal",
      value: JSON.stringify('FAKE-"value"\\line\nend').slice(1, -1),
      split: 7,
      secret: 'FAKE-"value"\\line\nend',
    },
    { name: "overlapping literal", value: "FAKE!FAKE!FAKE", split: 10, secret: "FAKE!FAKE" },
    { name: "token marker", value: "tskey-auth-FAKE-long-token", split: 3 },
    { name: "open token", value: "tskey-auth-FAKE-long-token", split: 16 },
    { name: "PEM marker", value: hostKey.private.trim(), split: 3 },
    { name: "PEM header", value: hostKey.private.trim(), split: 13 },
    { name: "open PEM block", value: hostKey.private.trim(), split: 50 },
    { name: "failed literal prefix", value: "FAKE-ordinary text", split: 5, plain: true },
    { name: "failed token prefix", value: "tskind", split: 3, plain: true },
    { name: "failed PEM prefix", value: "-----BEGIN FAKE\nhello", split: 13, plain: true },
  ])(
    "releases prompts around a split $name before exit",
    async ({ value, split, secret, plain }) => {
      const remote = server({
        exec(channel) {
          channel.write(`pi$ ${value.slice(0, split)}`);
          channel.once("data", () => channel.write(`${value.slice(split)}\nnext> `));
          channel.once("end", () => {
            channel.exit(0);
            channel.end();
          });
        },
      });
      const session = await connect(remote, { TS_SSH_PASSWORD: password, TS_AUTHKEY: secret });
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const gotPrompt = once(stdout, "data");
      const result = session.exec("FAKE command", { stdin, stdout, stderr: capture().stream });
      expect(String((await gotPrompt)[0])).toBe("pi$ ");
      const gotRest = once(stdout, "data");
      stdin.write("FAKE input");
      expect(String((await gotRest)[0])).toBe(`${plain ? value : "[REDACTED]"}\nnext> `);
      stdin.end();
      expect(await result).toBe(0);
    },
  );

  it("streams output before the command exits and forwards stdin", async () => {
    const remote = server({
      exec(channel) {
        channel.on("data", () => {
          channel.write("x".repeat(300));
        });
        channel.on("end", () => {
          channel.exit(0);
          channel.end();
        });
      },
    });
    const session = await connect(remote);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const gotOutput = once(stdout, "data");
    const result = session.exec("cat", { stdin, stdout, stderr: capture().stream });
    stdin.write("FAKE input");
    expect(String((await gotOutput)[0])).toBe("x".repeat(300));
    stdin.end();
    expect(await result).toBe(0);
  });

  it("shows a shell prompt before stdin, forwards PTY window changes, and restores raw mode", async () => {
    let finish: (() => void) | undefined;
    let resolveShellReady = () => {};
    const shellReady = new Promise<void>((resolve) => {
      resolveShellReady = resolve;
    });
    const remote = server({
      shell(channel) {
        channel.write("pi$ ");
        channel.on("data", () => {
          finish = () => {
            channel.exit(0);
            channel.end("FAKE shell\n");
          };
          resolveShellReady();
        });
      },
    });
    const session = await connect(remote);
    const stdin = new PassThrough() as TerminalInput;
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.setRawMode = vi.fn((raw: boolean) => {
      stdin.isRaw = raw;
      return stdin;
    });
    const stdout = new PassThrough() as TerminalOutput;
    stdout.rows = 30;
    stdout.columns = 100;
    const gotPrompt = once(stdout, "data");
    const result = session.shell({ stdin, stdout, stderr: capture().stream, term: "xterm" });
    expect(String((await gotPrompt)[0])).toBe("pi$ ");
    stdin.write("FAKE shell input");
    await shellReady;
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(remote.windows[0]).toMatchObject({ rows: 30, cols: 100 });
    const windowChanged = new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (remote.windows.some((window) => window.cols === 120)) {
          clearInterval(poll);
          resolve();
        }
      }, 1);
    });
    stdout.columns = 120;
    stdout.emit("resize");
    await windowChanged;
    finish?.();
    expect(await result).toBe(0);
    expect(stdin.isRaw).toBe(false);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdout.listenerCount("resize")).toBe(0);
  });

  it("restores raw mode when the transport disconnects during a shell", async () => {
    const remote = server({
      shell(_channel, client) {
        setImmediate(() => client.end());
      },
    });
    const session = await connect(remote);
    const stdin = new PassThrough() as TerminalInput;
    stdin.isTTY = true;
    stdin.isRaw = true;
    stdin.setRawMode = vi.fn((raw: boolean) => {
      stdin.isRaw = raw;
      return stdin;
    });
    await expect(session.shell({ stdin, stdout: new PassThrough() })).rejects.toMatchObject({
      code: "SSH_CONNECTION_FAILED",
    });
    expect(stdin.isRaw).toBe(true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(true);
  });

  it("rejects a shell without a TTY and reports disconnects during exec", async () => {
    const session = await connect(
      server({
        exec(_channel, _command, client) {
          client.end();
        },
      }),
    );
    expect(() => session.shell({ stdin: new PassThrough() })).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    await expect(session.exec("FAKE command")).rejects.toMatchObject({
      code: "SSH_CONNECTION_FAILED",
    });
  });
});
