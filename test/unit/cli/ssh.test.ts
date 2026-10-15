import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSshCommands } from "../../../src/cli/commands/ssh.js";
import { commands, main } from "../../../src/cli/main.js";
import { CtError } from "../../../src/core/errors.js";
import { clearSecrets } from "../../../src/core/output.js";
import * as proc from "../../../src/core/proc.js";
import type { TerminalInput } from "../../../src/ssh/session.js";
import { ensureConnected } from "../../../src/tailscale/connect.js";
import { memoryServer, password } from "../ssh/server.js";

vi.mock("../../../src/tailscale/connect.js", () => ({
  ensureConnected: vi.fn(),
  connect: vi.fn(),
}));

let temp: string;
const servers: ReturnType<typeof memoryServer>[] = [];
beforeEach(async () => {
  vi.mocked(ensureConnected).mockReset();
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

function defaultCommands(server?: ReturnType<typeof memoryServer>) {
  const remote = server?.factory();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      remote?.destroy();
      return true;
    }),
  });
  if (remote) {
    remote.on("error", () => {});
    child.stdin.pipe(remote);
    remote.pipe(child.stdout);
  }
  const ncSpawn = vi.fn(() => child);
  vi.mocked(ensureConnected).mockResolvedValue({ client: { ncSpawn } } as never);
  const env = {
    CLOUD_TAILSCALE_HOME: join(temp, "cts-home"),
    TS_SSH_PASSWORD: password,
    TS_AUTHKEY: "tskey-auth-FAKE",
    HOME: temp,
  };
  const stdin = new PassThrough();
  stdin.end();
  const registered = createSshCommands({ env, stdin, ctsPath: "/opt/cts" });
  return { registered, child, ncSpawn, env };
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

  it("auto-connects and runs SSH over the real nc provider, then stops the child", async () => {
    const server = memoryServer({
      exec(channel, command) {
        channel.write(`ran: ${command}\n`);
        channel.exit(37);
        channel.end();
      },
    });
    servers.push(server);
    const { registered, child, ncSpawn, env } = defaultCommands(server);
    const result = await registered.ssh(["alice@pi", "--", "uname", "-a"], { json: true });
    expect(ensureConnected).toHaveBeenCalledExactlyOnceWith({ env });
    expect(ncSpawn).toHaveBeenCalledExactlyOnceWith("pi", 22);
    expect(result).toMatchObject({
      ok: false,
      exitCode: 37,
      data: { stdout: "ran: uname -a\n", stderr: "" },
    });
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledOnce());
  });

  it.each(["unknown peer name", "peer is offline"])(
    "reports nc failure (%s) after stdout closes and masks chunked diagnostics",
    async (diagnostic) => {
      const { registered, child, ncSpawn } = defaultCommands();
      const result = registered.ssh(["alice@pi", "--", "true"], { json: true });
      const check = expect(result).rejects.toMatchObject({
        code: "SSH_CONNECTION_FAILED",
        message: expect.stringContaining(`${diagnostic}: [REDACTED]`),
        next: expect.stringMatching(/peer name.*online state.*ACLs/),
      });
      await vi.waitFor(() => expect(ncSpawn).toHaveBeenCalled());
      child.stdout.end();
      child.stderr.write(`${diagnostic}: tskey-au`);
      child.stderr.end("th-FAKE");
      child.emit("close", 1);
      await check;
    },
  );

  it("preserves nc diagnostics when its input pipe fails before process close", async () => {
    const { registered, child, ncSpawn } = defaultCommands();
    const result = registered.ssh(["alice@pi", "--", "true"], { json: true });
    const check = expect(result).rejects.toMatchObject({
      code: "SSH_CONNECTION_FAILED",
      message: expect.stringContaining("unknown name"),
    });
    // SSH writes its client banner immediately, before nc has necessarily connected.
    child.stdin._write = (_chunk, _encoding, done) => {
      done(Object.assign(new Error("FAKE broken pipe"), { code: "EPIPE" }));
    };
    await vi.waitFor(() => expect(ncSpawn).toHaveBeenCalled());
    child.stderr.end("unknown name");
    child.emit("close", 1);
    await check;
  });

  it("reports subprocess spawn errors and stops the transport", async () => {
    const { registered, child, ncSpawn } = defaultCommands();
    const result = registered.ssh(["alice@pi", "--", "true"], { json: true });
    const check = expect(result).rejects.toMatchObject({
      code: "SSH_CONNECTION_FAILED",
      message: expect.stringContaining("pi:22"),
    });
    await vi.waitFor(() => expect(ncSpawn).toHaveBeenCalled());
    child.emit("error", new Error("FAKE spawn error"));
    await check;
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("propagates nc failure during a running SSH command", async () => {
    const server = memoryServer({ exec() {} });
    servers.push(server);
    const { registered, child } = defaultCommands(server);
    const result = registered.ssh(["alice@pi", "--", "sleep", "60"], { json: true });
    const check = expect(result).rejects.toMatchObject({
      code: "SSH_CONNECTION_FAILED",
      message: expect.stringContaining("FAKE peer disconnected"),
    });
    await vi.waitFor(() => expect(server.commands).toEqual(["sleep 60"]));
    child.stderr.end("FAKE peer disconnected");
    child.emit("close", 1);
    await check;
  });

  it("checks the tailnet connection before requiring SSH credentials", async () => {
    vi.mocked(ensureConnected).mockRejectedValue(
      new CtError("AUTH_KEY_MISSING", "No key configured.", "Set TS_AUTHKEY in secrets."),
    );
    const registered = createSshCommands({ env: {} });
    await expect(registered.ssh(["alice@pi", "--", "true"])).rejects.toMatchObject({
      code: "AUTH_KEY_MISSING",
    });
    expect(ensureConnected).toHaveBeenCalledExactlyOnceWith({ env: {} });
  });

  it.each(["ssh", "ssh-config"] as const)(
    "%s propagates a missing auth key before opening a transport or writing config",
    async (command) => {
      const { registered, ncSpawn } = defaultCommands();
      vi.mocked(ensureConnected).mockRejectedValue(
        new CtError("AUTH_KEY_MISSING", "No key configured.", "Set TS_AUTHKEY in secrets."),
      );
      await expect(
        registered[command](command === "ssh" ? ["alice@pi", "--", "true"] : []),
      ).rejects.toMatchObject({ code: "AUTH_KEY_MISSING" });
      expect(ncSpawn).not.toHaveBeenCalled();
      await expect(readFile(join(temp, ".ssh", "config"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("gets online peers from status JSON through the default connection provider", async () => {
    vi.spyOn(proc, "run").mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, signal: null });
    const { registered, env } = defaultCommands();
    const status = JSON.parse(
      await readFile(
        new URL("../../fixtures/tailscale/status-running.json", import.meta.url),
        "utf8",
      ),
    );
    status.Peer["FAKE-dns-only"] = {
      DNSName: "dns-peer.example.ts.net.",
      TailscaleIPs: ["fd7a:115c:a1e0::20"],
      Online: true,
    };
    status.Peer["FAKE-no-address"] = { HostName: "no-address", Online: true };
    vi.mocked(ensureConnected).mockResolvedValue({ status } as never);
    expect(await registered["ssh-config"]([])).toMatchObject({ ok: true, data: { peers: 2 } });
    expect(ensureConnected).toHaveBeenCalledExactlyOnceWith({ env });
    const saved = await readFile(join(temp, ".ssh", "config"), "utf8");
    expect(saved).toContain("Host raspberry5\n  HostName 100.64.0.20");
    expect(saved).toContain("Host dns-peer.example.ts.net\n  HostName fd7a:115c:a1e0::20");
    expect(saved).toContain("ProxyCommand '/opt/cts' nc %h %p");
    expect(saved).not.toContain("offline-peer");
    expect(saved).not.toContain("no-address");
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
