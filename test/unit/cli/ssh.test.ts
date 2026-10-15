import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSshCommands } from "../../../src/cli/commands/ssh.js";
import { commands, main } from "../../../src/cli/main.js";
import { clearSecrets } from "../../../src/core/output.js";
import * as proc from "../../../src/core/proc.js";
import type { TerminalInput } from "../../../src/ssh/session.js";
import { memoryServer, password } from "../ssh/server.js";

let temp: string;
const servers: ReturnType<typeof memoryServer>[] = [];
beforeEach(async () => {
  temp = await mkdtemp("/tmp/cts-ssh-command-");
});
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearSecrets();
  await rm(temp, { recursive: true, force: true });
});

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

function testCommands(exitCode = 0) {
  const server = memoryServer({
    exec(channel, command) {
      channel.write(`ran: ${command}\n`);
      channel.stderr.write(`FAKE warning ${password}\n`);
      channel.exit(exitCode);
      channel.end();
    },
  });
  servers.push(server);
  const stdin = new PassThrough();
  stdin.end();
  const stdout = capture();
  const stderr = capture();
  const streamFactory = vi.fn(server.factory);
  const registered = createSshCommands({
    env: {
      CLOUD_TAILSCALE_HOME: join(temp, "cts-home"),
      TS_SSH_PASSWORD: password,
      TS_SSH_USER: "alice",
      HOME: temp,
    },
    streamFactory,
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
    onlinePeers: async () => [
      { name: "pi", ip: "100.64.0.1", online: true },
      { name: "offline", ip: "100.64.0.2", online: false },
    ],
    ctsPath: "/opt/cts",
  });
  return { registered, server, streamFactory, stdout, stderr };
}

describe("SSH commands", () => {
  it("uses the one injected stream factory and preserves remote shell arguments", async () => {
    const { registered, streamFactory, stdout, stderr, server } = testCommands(42);
    const result = await registered.ssh(["bob@pi", "--", "printf", "'%s'", "--json", "--help"]);
    expect(streamFactory).toHaveBeenCalledExactlyOnceWith("pi", 22);
    expect(server.commands).toEqual(["printf '%s' --json --help"]);
    expect(server.users).toEqual(["bob"]);
    expect(result).toMatchObject({ ok: false, exitCode: 42, data: { exitCode: 42 } });
    expect(stdout.value()).toBe("ran: printf '%s' --json --help\n");
    expect(stderr.value()).toBe("FAKE warning [REDACTED]\n");
  });

  it("captures masked remote output in JSON mode", async () => {
    const { registered, stdout, stderr } = testCommands();
    const result = await registered.ssh(["pi", "--", "uname", "-a"], { json: true });
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      data: {
        user: "alice",
        stdout: "ran: uname -a\n",
        stderr: "FAKE warning [REDACTED]\n",
      },
    });
    expect(stdout.value()).toBe("");
    expect(stderr.value()).toBe("");
  });

  it.each([[], ["pi", "unexpected"], ["pi", "--"], ["--", "pi"], ["--password", "FAKE"]])(
    "rejects invalid syntax %j",
    async (...args) => {
      const { registered, streamFactory } = testCommands();
      await expect(registered.ssh(args as string[])).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      expect(streamFactory).not.toHaveBeenCalled();
    },
  );

  it("rejects a shell without a TTY before opening a transport", async () => {
    const { registered, streamFactory } = testCommands();
    await expect(registered.ssh(["pi"])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(streamFactory).not.toHaveBeenCalled();
  });

  it("opens an interactive shell with a terminal", async () => {
    const remote = memoryServer();
    servers.push(remote);
    const stdin = new PassThrough() as TerminalInput;
    stdin.isTTY = true;
    stdin.setRawMode = vi.fn(() => stdin);
    const stdout = capture();
    const registered = createSshCommands({
      streamFactory: remote.factory,
      env: { CLOUD_TAILSCALE_HOME: join(temp, "cts-home"), TS_SSH_PASSWORD: password },
      stdin,
      stdout: stdout.stream,
      stderr: capture().stream,
    });
    expect(await registered.ssh(["alice@pi"])).toMatchObject({ ok: true, exitCode: 0 });
    expect(stdout.value()).toBe("FAKE shell\n");
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("keeps default providers explicitly unimplemented until Phase 2", async () => {
    const registered = createSshCommands({
      env: { CLOUD_TAILSCALE_HOME: join(temp, "cts-home"), TS_SSH_PASSWORD: password },
    });
    await expect(registered.ssh(["pi", "--", "true"])).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
      message: expect.stringContaining("Phase 2"),
    });
    await expect(registered["ssh-config"]([])).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });

  it("updates the user's OpenSSH config for online peers", async () => {
    vi.spyOn(proc, "run").mockResolvedValue({
      stdout: "",
      stderr: "OpenSSH_FAKE",
      exitCode: 0,
      signal: null,
    });
    const { registered } = testCommands();
    const result = await registered["ssh-config"]([]);
    expect(result).toMatchObject({ ok: true, data: { peers: 1 } });
    expect(proc.run).toHaveBeenCalledWith("ssh", ["-V"], { timeoutMs: 5_000 });
    const file = join(temp, ".ssh", "config");
    const saved = await readFile(file, "utf8");
    await registered["ssh-config"]([]);
    expect(await readFile(file, "utf8")).toBe(saved);
    expect(saved).toContain("Host pi\n");
    expect(saved).not.toContain("offline");
    expect(saved).not.toContain(password);
  });

  it("explains missing OpenSSH and rejects unsupported config arguments", async () => {
    vi.spyOn(proc, "run").mockRejectedValue(new Error("FAKE missing ssh"));
    const { registered } = testCommands();
    await expect(registered["ssh-config"]([])).rejects.toMatchObject({
      code: "SSH_CONFIG_FAILED",
      next: expect.stringContaining("cloud-tailscale ssh"),
    });
    await expect(registered["ssh-config"](["--password", "FAKE"])).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it.each([
    { json: false, exitCode: 0 },
    { json: true, exitCode: 0 },
    { json: false, exitCode: 42 },
    { json: true, exitCode: 42 },
  ])(
    "dispatches SSH and returns remote exit code $exitCode (json=$json)",
    async ({ json, exitCode }) => {
      const { registered, stdout: remoteOut, stderr: remoteErr } = testCommands(exitCode);
      vi.spyOn(commands, "ssh").mockImplementation(registered.ssh);
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      expect(await main(["ssh", "pi", ...(json ? ["--json"] : []), "--", "true"])).toBe(exitCode);
      const output = exitCode === 0 ? stdout : stderr;
      const message = `SSH alice@pi exited with code ${exitCode}.`;
      expect(exitCode === 0 ? stderr : stdout).not.toHaveBeenCalled();
      expect(output).toHaveBeenCalledOnce();
      if (json) {
        expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual({
          ok: exitCode === 0,
          message,
          data: {
            host: "pi",
            user: "alice",
            exitCode,
            stdout: "ran: true\n",
            stderr: "FAKE warning [REDACTED]\n",
          },
        });
        expect(remoteOut.value()).toBe("");
        expect(remoteErr.value()).toBe("");
      } else {
        expect(output).toHaveBeenCalledWith(`${message}\n`);
        expect(remoteOut.value()).toBe("ran: true\n");
        expect(remoteErr.value()).toBe("FAKE warning [REDACTED]\n");
      }
    },
  );
});
