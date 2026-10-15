import type { Readable, Writable } from "node:stream";
import { CtError } from "../../core/errors.js";
import { mask, type Result } from "../../core/output.js";
import { validateDestination } from "../../tailscale/client.js";
import { ensureConnected } from "../../tailscale/connect.js";

/** stdout is a binary transport: no status messages, newline, or JSON may be added. */
export async function ncCommand(
  args: string[] = [],
  streams: { stdin: Readable; stdout: Writable; stderr: Writable } = process,
): Promise<Result> {
  if (args.length !== 2 || !/^\d+$/.test(args[1])) {
    throw new CtError(
      "INVALID_ARGUMENT",
      "nc requires a host and TCP port.",
      "Run cloud-tailscale nc <host> <port>.",
    );
  }
  const [host, portText] = args;
  const port = Number(portText);
  validateDestination(host, port);
  const { client } = await ensureConnected();
  const child = client.ncSpawn(host, port);
  const stderr: Buffer[] = [];
  let stderrSize = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    // Retain a bounded diagnostic and mask it as a whole, including split tokens.
    if (stderrSize < 65_536) {
      const part = Buffer.from(chunk).subarray(0, 65_536 - stderrSize);
      stderr.push(part);
      stderrSize += part.length;
    }
  });
  child.stdin.on("error", () => {});
  streams.stdin.pipe(child.stdin);
  child.stdout.pipe(streams.stdout, { end: false });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", (cause) =>
        reject(
          new CtError(
            "PROCESS_FAILED",
            "Could not start the Tailscale TCP stream.",
            "Run cloud-tailscale up and check that its installed client is executable.",
            { cause },
          ),
        ),
      );
      child.once("close", (code) => {
        const diagnostic = mask(Buffer.concat(stderr).toString("utf8"));
        if (diagnostic) streams.stderr.write(diagnostic);
        if (code === 0) resolve();
        else
          reject(
            new CtError(
              "PROCESS_FAILED",
              "The Tailscale TCP stream failed.",
              "Check the peer's online state, TCP port and tailnet ACLs with cloud-tailscale status.",
            ),
          );
      });
    });
  } finally {
    streams.stdin.unpipe(child.stdin);
    streams.stdin.pause();
    child.stdout.unpipe(streams.stdout);
  }
  return { ok: true, message: "", data: { streamed: true } };
}

/** End the transport CLI after flushing, before the result dispatcher can append text. */
export async function ncCliCommand(args: string[]): Promise<never> {
  await ncCommand(args);
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve, reject) => {
          stream.write("", (error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  process.exit(0);
}
