import type { Writable } from "node:stream";
import { Duplex, Writable as Output } from "node:stream";
import { CtError } from "../../core/errors.js";
import { mask, type Result } from "../../core/output.js";
import { resolveTarget } from "../../ssh/auth.js";
import type { SshPeer } from "../../ssh/config.js";
import {
  openSsh,
  type SshStreamFactory,
  type TerminalInput,
  type TerminalOutput,
} from "../../ssh/session.js";
import { ncSpawn, type TailscaleClient } from "../../tailscale/client.js";
import { ensureConnected } from "../../tailscale/connect.js";
import { createSshConfigCommand } from "./ssh-config.js";

export interface SshCommandDependencies {
  streamFactory?: SshStreamFactory;
  onlinePeers?: () => Promise<readonly SshPeer[]>;
  env?: NodeJS.ProcessEnv;
  ctsPath?: string;
  stdin?: TerminalInput;
  stdout?: TerminalOutput;
  stderr?: Writable;
}

export interface SshCommandContext {
  json?: boolean;
}

export interface SshCommandResult extends Result {
  exitCode: number;
}

function tailscaleStream(host: string, port: number, client: TailscaleClient): Duplex {
  const child = ncSpawn(host, port, client);
  const stderr: Buffer[] = [];
  let stderrSize = 0;
  let exited = false;
  let exitError: CtError | undefined;
  const failed = (cause?: unknown) => {
    const diagnostic = mask(Buffer.concat(stderr).toString("utf8")).trim();
    return new CtError(
      "SSH_CONNECTION_FAILED",
      `The Tailscale TCP stream to ${host}:${port} failed${diagnostic ? `: ${diagnostic}` : "."}`,
      "Check the peer name and online state with cloud-tailscale status, its SSH port, and tailnet ACLs; retry cloud-tailscale up if the daemon stopped.",
      { cause },
    );
  };
  // A broken pipe can precede nc's diagnostic and exit; wait for close to classify it.
  const written = (cause: Error | null | undefined, done: (error?: Error | null) => void) => {
    if (!cause) done();
    else if (exited) done(exitError ?? failed(cause));
    else child.once("close", () => done(exitError ?? failed(cause)));
  };
  const stream = new Duplex({
    read() {
      child.stdout.resume();
    },
    write(chunk, encoding, done) {
      child.stdin.write(chunk, encoding, (cause) => written(cause, done));
    },
    final(done) {
      child.stdin.end((cause?: Error | null) => written(cause, done));
    },
    destroy(error, done) {
      if (!exited) child.kill();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      done(error);
    },
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrSize < 65_536) {
      const part = Buffer.from(chunk).subarray(0, 65_536 - stderrSize);
      stderr.push(part);
      stderrSize += part.length;
    }
  });
  child.stdout.on("data", (chunk: Buffer) => {
    if (!stream.push(chunk)) child.stdout.pause();
  });
  child.stdout.on("error", (cause) => stream.destroy(failed(cause)));
  child.stdin.on("error", () => {});
  child.once("error", (cause) => stream.destroy(failed(cause)));
  // Do not expose stdout EOF before nc's exit code and stderr are available.
  child.once("close", (code) => {
    exited = true;
    if (code !== 0) {
      exitError = failed();
      stream.destroy(exitError);
    } else {
      stream.push(null);
    }
  });
  return stream;
}

function capture() {
  let text = "";
  return {
    stream: new Output({
      write(chunk, _encoding, done) {
        text += chunk.toString();
        done();
      },
    }),
    value: () => text,
  };
}

/** The command registration is the single injection point for the SSH transport. */
export function createSshCommands(dependencies: SshCommandDependencies = {}) {
  return {
    ssh: async (args: string[], context: SshCommandContext = {}): Promise<SshCommandResult> => {
      const separator = args.indexOf("--");
      if (
        args.length === 0 ||
        (separator !== -1 && separator !== 1) ||
        (separator === -1 && args.length !== 1) ||
        (separator === 1 && args.length === 2)
      ) {
        throw new CtError(
          "INVALID_ARGUMENT",
          "SSH needs one [user@]host and an optional command after --.",
          "Use cloud-tailscale ssh user@host -- command, or omit -- command for a terminal shell.",
        );
      }
      const env = dependencies.env ?? process.env;
      const { host, user } = resolveTarget(args[0], env);
      const stdin = dependencies.stdin ?? process.stdin;
      const stdout = dependencies.stdout ?? process.stdout;
      const stderr = dependencies.stderr ?? process.stderr;
      const command = separator === 1 ? args.slice(2).join(" ") : undefined;
      if (command === undefined && (!stdin.isTTY || !stdin.setRawMode || context.json)) {
        throw new CtError(
          "INVALID_ARGUMENT",
          "An interactive SSH shell needs a terminal and text output.",
          "Supply a remote command after -- when no terminal is available or when using --json.",
        );
      }
      let factory = dependencies.streamFactory;
      if (!factory) {
        const { client } = await ensureConnected({ env });
        factory = (host, port) => tailscaleStream(host, port, client);
      }
      const session = await openSsh({ host, user, sock: factory, env });
      const capturedOut = context.json ? capture() : undefined;
      const capturedErr = context.json ? capture() : undefined;
      try {
        const exitCode =
          command === undefined
            ? await session.shell({ stdin, stdout, stderr })
            : await session.exec(command, {
                stdin,
                stdout: capturedOut?.stream ?? stdout,
                stderr: capturedErr?.stream ?? stderr,
              });
        return {
          ok: exitCode === 0,
          message: `SSH ${user}@${host} exited with code ${exitCode}.`,
          data: {
            host,
            user,
            exitCode,
            ...(context.json ? { stdout: capturedOut?.value(), stderr: capturedErr?.value() } : {}),
          },
          exitCode,
        };
      } finally {
        session.close();
      }
    },
    "ssh-config": createSshConfigCommand(dependencies),
  };
}
