import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ncCliCommand, ncCommand } from "../../../../src/cli/commands/nc.js";
import { ensureConnected } from "../../../../src/tailscale/connect.js";

vi.mock("../../../../src/tailscale/connect.js", () => ({ ensureConnected: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
});
function transport() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const ncSpawn = vi.fn(() => child);
  const streams = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  };
  vi.mocked(ensureConnected).mockResolvedValue({ client: { ncSpawn } } as never);
  return { child, ncSpawn, streams };
}

describe("nc command", () => {
  it("auto-connects and pipes binary stdio without adding transport bytes", async () => {
    const { child, ncSpawn, streams } = transport();
    const output: Buffer[] = [];
    const input: Buffer[] = [];
    child.stdin.on("data", (chunk) => input.push(Buffer.from(chunk)));
    streams.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
    const done = ncCommand(["raspberry5", "22"], streams);
    await vi.waitFor(() => expect(ncSpawn).toHaveBeenCalledWith("raspberry5", 22));
    const bytes = Buffer.from([0, 0xff, 0x53, 0x53, 0x48, 0x0d, 0x0a]);
    streams.stdin.write(bytes);
    child.stdout.write(bytes);
    child.emit("close", 0);
    expect(await done).toMatchObject({ ok: true, message: "", data: { streamed: true } });
    expect(Buffer.concat(output)).toEqual(bytes);
    expect(Buffer.concat(input)).toEqual(bytes);
  });
  it("masks stderr even when a credential spans subprocess chunks", async () => {
    const { child, ncSpawn, streams } = transport();
    let diagnostic = "";
    streams.stderr.on("data", (chunk) => {
      diagnostic += chunk;
    });
    const done = ncCommand(["raspberry5", "22"], streams);
    await vi.waitFor(() => expect(ncSpawn).toHaveBeenCalled());
    child.stderr.write("failed with tskey-au");
    child.stderr.write("th-FAKE\n");
    child.emit("close", 0);
    await done;
    expect(diagnostic).toBe("failed with [REDACTED]\n");
  });
  it("reports a failed TCP stream with an actionable error", async () => {
    const { child, ncSpawn, streams } = transport();
    const done = ncCommand(["raspberry5", "22"], streams);
    const check = expect(done).rejects.toMatchObject({
      code: "PROCESS_FAILED",
      next: expect.stringContaining("ACLs"),
    });
    await vi.waitFor(() => expect(ncSpawn).toHaveBeenCalled());
    child.emit("close", 1);
    await check;
    expect(streams.stdin.isPaused()).toBe(true);
  });
  it("handles subprocess spawn failure", async () => {
    const { child, ncSpawn, streams } = transport();
    const done = ncCommand(["raspberry5", "22"], streams);
    const check = expect(done).rejects.toMatchObject({
      code: "PROCESS_FAILED",
      message: expect.stringContaining("Could not start"),
    });
    await vi.waitFor(() => expect(ncSpawn).toHaveBeenCalled());
    child.emit("error", new Error("FAKE spawn failure"));
    await check;
  });
  it.each(
    [[], ["host"], ["host", "22", "extra"], ["host", "abc"], ["host", "0"], ["--help", "22"]].map(
      (args) => ({ args }),
    ),
  )("rejects invalid arguments $args", async ({ args }) => {
    await expect(ncCommand(args)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(ensureConnected).not.toHaveBeenCalled();
  });
  it("flushes a completed CLI stream and exits before the dispatcher prints a result", async () => {
    const { child, ncSpawn } = transport();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((_chunk, callback) => {
      if (typeof callback === "function") callback();
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((_chunk, callback) => {
      if (typeof callback === "function") callback();
      return true;
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("FAKE exit");
    });
    try {
      const done = ncCliCommand(["raspberry5", "22"]);
      const check = expect(done).rejects.toThrow("FAKE exit");
      await vi.waitFor(() => expect(ncSpawn).toHaveBeenCalled());
      child.emit("close", 0);
      await check;
      expect(stdout).toHaveBeenCalledWith("", expect.any(Function));
      expect(stderr).toHaveBeenCalledWith("", expect.any(Function));
      expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
