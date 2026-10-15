import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run, spawnDetached } from "../../../src/core/proc.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("run", () => {
  it("captures stdout and stderr, sends stdin, and merges the environment", async () => {
    const result = await run(
      process.execPath,
      [
        "-e",
        "process.stdin.setEncoding('utf8'); process.stdin.on('data', data => process.stdout.write(process.env.CTS_FAKE_TEST + ':' + data)); process.stderr.write('FAKE stderr');",
      ],
      {
        env: { CTS_FAKE_TEST: "FAKE-value" },
        input: "FAKE input",
        timeoutMs: 5000,
      },
    );
    expect(result).toEqual({
      stdout: "FAKE-value:FAKE input",
      stderr: "FAKE stderr",
      exitCode: 0,
      signal: null,
    });
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({
        shell: false,
        env: expect.objectContaining({ PATH: process.env.PATH, CTS_FAKE_TEST: "FAKE-value" }),
      }),
    );
    expect(vi.mocked(spawn).mock.calls[0][2]?.detached).toBe(true);
  });
  it("returns a nonzero exit for caller-specific diagnosis", async () => {
    expect(await run(process.execPath, ["-e", "process.exitCode = 7;"])).toMatchObject({
      exitCode: 7,
      stdout: "",
      stderr: "",
      signal: null,
    });
  });

  it("supports binary stdin and decodes UTF-8 split across stdout chunks", async () => {
    const result = await run(
      process.execPath,
      [
        "-e",
        "process.stdin.resume(); process.stdout.write(Buffer.from([0xe2])); process.stdout.write(Buffer.from([0x82, 0xac]));",
      ],
      { input: Buffer.from("FAKE input") },
    );
    expect(result.stdout).toBe("€");
    expect(result.exitCode).toBe(0);
  });
  it("reports spawn failures as CtError without echoing arguments", async () => {
    await expect(
      run("/FAKE-missing-executable", ["FAKE-sensitive-argument"]),
    ).rejects.toMatchObject({
      code: "PROCESS_FAILED",
      message: "Could not start /FAKE-missing-executable.",
    });
  });
  it("kills a timed-out child and rejects with a stable code", async () => {
    const result = run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 50 });
    const child = vi.mocked(spawn).mock.results.at(-1)?.value;
    const exited = once(child, "exit");
    await expect(result).rejects.toMatchObject({
      code: "PROCESS_TIMEOUT",
      next: expect.any(String),
    });
    expect(await exited).toEqual([null, "SIGKILL"]);
  });

  it("settles at the timeout deadline without waiting for close", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const rejected = vi.fn();
    const result = run("FAKE-tool", [], { timeoutMs: 100 }).catch(rejected);
    await vi.advanceTimersByTimeAsync(99);
    expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rejected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        code: "PROCESS_TIMEOUT",
        message: "FAKE-tool timed out after 100 ms.",
      }),
    );
    expect(kill).toHaveBeenCalledExactlyOnceWith(-12345, "SIGKILL");
    expect(child.stdin.destroyed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
    await result;
  });

  it("times out an exited parent whose descendant holds stdout and stderr open", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const kill = vi.spyOn(process, "kill");
    const descendant =
      "process.stdout.write(String(process.pid)); process.stderr.write('FAKE inherited stderr'); setTimeout(() => {}, 5000);";
    const result = run(
      process.execPath,
      [
        "-e",
        `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();`,
      ],
      { timeoutMs: 100 },
    );
    const rejected = vi.fn();
    void result.catch(rejected);
    const child = vi.mocked(spawn).mock.results.at(-1)?.value;
    const closed = once(child, "close");
    let descendantPid: number | undefined;
    try {
      const [[pid]] = await Promise.all([
        once(child.stdout, "data"),
        once(child.stderr, "data"),
        once(child, "exit"),
      ]);
      descendantPid = Number(String(pid));
      expect(descendantPid).toBeGreaterThan(0);
      expect(child.exitCode).toBe(0);
      expect(child.stdout.destroyed).toBe(false);
      expect(child.stderr.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(rejected).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: "PROCESS_TIMEOUT" }),
      );
      expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
      await closed;
    } finally {
      // Also clean up when testing a broken implementation that misses the descendant.
      for (const pid of [-child.pid, descendantPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The process or group has already exited.
        }
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });
  it("returns termination signals and does not invoke a shell", async () => {
    expect(
      await run(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"]),
    ).toMatchObject({ exitCode: 1, signal: "SIGTERM" });
    const input = "$(FAKE-command); echo FAKE";
    const result = await run(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1])",
      input,
    ]);
    expect(result.stdout).toBe(input);
  });
});

describe("spawnDetached", () => {
  it("returns the pid only after spawn, unreferences the child, and uses a 0600 log", async () => {
    const temp = await mkdtemp("/tmp/cloud-tailscale-proc-test-");
    try {
      const logFile = join(temp, "daemon.log");
      await writeFile(logFile, "FAKE log", { mode: 0o644 });
      const child = Object.assign(new EventEmitter(), { pid: 12345, unref: vi.fn() });
      vi.mocked(spawn).mockImplementationOnce(() => {
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as ReturnType<typeof spawn>;
      });
      expect(
        await spawnDetached("FAKE-daemon", ["--fake"], { logFile, env: { CTS_FAKE_TEST: "FAKE" } }),
      ).toBe(12345);
      expect(child.unref).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledWith(
        "FAKE-daemon",
        ["--fake"],
        expect.objectContaining({
          detached: true,
          shell: false,
          stdio: ["ignore", expect.any(Number), expect.any(Number)],
          env: expect.objectContaining({ CTS_FAKE_TEST: "FAKE" }),
        }),
      );
      expect((await stat(logFile)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
  it("rejects a detached spawn failure instead of returning a pid", async () => {
    const temp = await mkdtemp("/tmp/cloud-tailscale-proc-test-");
    try {
      const child = new EventEmitter();
      vi.mocked(spawn).mockImplementationOnce(() => {
        queueMicrotask(() => child.emit("error", new Error("FAKE spawn failure")));
        return child as unknown as ReturnType<typeof spawn>;
      });
      await expect(
        spawnDetached("FAKE-daemon", [], { logFile: join(temp, "daemon.log") }),
      ).rejects.toMatchObject({ code: "PROCESS_FAILED" });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
