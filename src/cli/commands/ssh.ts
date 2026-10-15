import type { Writable } from "node:stream";
import { Writable as Output } from "node:stream";
import { CtError } from "../../core/errors.js";
import type { Result } from "../../core/output.js";
import { resolveTarget } from "../../ssh/auth.js";
import type { SshPeer } from "../../ssh/config.js";
import {
  openSsh,
  type SshStreamFactory,
  type TerminalInput,
  type TerminalOutput,
} from "../../ssh/session.js";
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

function notConnected(): never {
  throw new CtError(
    "NOT_IMPLEMENTED",
    "SSH connection wiring lands in Phase 2.",
    "Use a Cloud-Tailscale release with the Tailscale stream and online peer providers connected.",
  );
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

/** The command registration is the single injection point for the Phase 2 transport. */
export function createSshCommands(dependencies: SshCommandDependencies = {}) {
  const factory = dependencies.streamFactory ?? notConnected;
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
    "ssh-config": createSshConfigCommand({
      ...dependencies,
      onlinePeers: dependencies.onlinePeers ?? notConnected,
    }),
  };
}
