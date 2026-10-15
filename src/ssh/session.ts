import { constants as osConstants } from "node:os";
import type { Duplex, Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { type AnyAuthMethod, Client, type ClientChannel } from "ssh2";
import { CtError } from "../core/errors.js";
import { mask } from "../core/output.js";
import { ensurePaths } from "../core/paths.js";
import { registerEnvironmentSecrets } from "../core/secrets.js";
import { getSshAuth, SSH_AUTH_NEXT, validateHost } from "./auth.js";
import { verifyHostKey } from "./known-hosts.js";

export type SshStreamFactory = (host: string, port: number) => Duplex | Promise<Duplex>;

export interface TerminalInput extends Readable {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(enabled: boolean): this;
}

export interface TerminalOutput extends Writable {
  rows?: number;
  columns?: number;
}

export interface SshIo {
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
}

export interface ShellIo {
  stdin?: TerminalInput;
  stdout?: TerminalOutput;
  stderr?: Writable;
  term?: string;
}

export interface SshSession {
  exec(command: string, io?: SshIo): Promise<number>;
  shell(io?: ShellIo): Promise<number>;
  close(): void;
}

export interface OpenSshOptions {
  host: string;
  port?: number;
  user: string;
  sock: SshStreamFactory;
  env?: NodeJS.ProcessEnv;
  knownHostsFile?: string;
  readyTimeoutMs?: number;
}

function connectionError(cause?: unknown): CtError {
  if (cause instanceof CtError) return cause;
  if ((cause as { level?: string })?.level === "client-authentication") {
    return new CtError("SSH_AUTH_FAILED", "SSH authentication was rejected.", SSH_AUTH_NEXT, {
      cause,
    });
  }
  return new CtError(
    "SSH_CONNECTION_FAILED",
    "The SSH connection failed or closed before the remote command completed.",
    "Check the peer is online, its SSH server is listening, and tailnet ACLs allow access to its SSH port.",
    { cause },
  );
}

/** Buffer possible credential fragments, then use the shared masker for actual redaction. */
function maskedOutput(destination: Writable, literals: readonly string[]) {
  const decoder = new StringDecoder("utf8");
  const starts = [
    "tskey-",
    "-----BEGIN ",
    ...literals.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
  ];
  let pending = "";
  function flush(final: boolean) {
    let end = pending.length;
    if (!final) {
      // Retain only suffixes that could grow into a credential in the next chunk.
      for (const start of starts) {
        for (
          let size = Math.min(pending.length, start.length - 1);
          size > pending.length - end;
          size--
        ) {
          if (start.startsWith(pending.slice(-size))) {
            end = pending.length - size;
            break;
          }
        }
      }
      for (const pattern of [
        /tskey-[A-Za-z0-9_-]*$/,
        /-----BEGIN (?:(?:[A-Z0-9]+ )*[A-Z0-9]*|(?:[A-Z0-9]+ )*PRIVATE KEY-{1,4})$/,
      ]) {
        const match = pattern.exec(pending);
        if (match && match.index + match[0].length === pending.length)
          end = Math.min(end, match.index);
      }
      // An unclosed PEM block is sensitive through its eventual END marker.
      for (const match of pending.matchAll(
        /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:(-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----)|$)/g,
      )) {
        if (!match[1]) end = Math.min(end, match.index);
      }
    }
    const whole = mask(pending);
    while (end > 0) {
      // A decoded code point can still span two UTF-16 code units at the cut.
      const last = pending.charCodeAt(end - 1);
      if (!final && last >= 0xd800 && last <= 0xdbff) {
        end--;
        continue;
      }
      const prefix = mask(pending.slice(0, end));
      const suffix = pending.slice(end);
      // Keep overlapping matches together, using the shared masker's boundaries.
      if (!final && prefix + mask(suffix) !== whole) {
        end--;
        continue;
      }
      destination.write(prefix);
      pending = suffix;
      break;
    }
  }
  return {
    write(chunk: Buffer) {
      pending += decoder.write(chunk);
      flush(false);
    },
    end() {
      pending += decoder.end();
      flush(true);
    },
  };
}

function authLiterals(methods: readonly AnyAuthMethod[]): string[] {
  return methods.flatMap((method) => {
    if (method.type === "password") return [method.password];
    if (method.type === "publickey") return [method.key.toString()];
    return [];
  });
}

export async function openSsh(options: OpenSshOptions): Promise<SshSession> {
  const { host, user, sock: factory, env = process.env, port = 22 } = options;
  validateHost(host);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CtError("INVALID_ARGUMENT", "Invalid SSH port.", "Use an SSH port from 1 to 65535.");
  }
  registerEnvironmentSecrets(env);
  const methods = await getSshAuth(user, env);
  const file = options.knownHostsFile ?? (await ensurePaths(env)).knownHostsFile;
  let sock: Duplex;
  try {
    sock = await factory(host, port);
  } catch (cause) {
    throw connectionError(cause);
  }
  const client = new Client();
  let failure: CtError | undefined;
  let closed = false;
  const listeners = new Set<(error: CtError) => void>();
  const fail = (cause?: unknown) => {
    failure ??= connectionError(cause);
    for (const listener of listeners) listener(failure);
  };
  client.on("error", fail);
  client.on("close", () => {
    closed = true;
    fail();
  });
  const close = () => {
    client.destroy();
    sock.destroy();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const rejected = (error: CtError) => reject(error);
      listeners.add(rejected);
      client.once("ready", () => {
        listeners.delete(rejected);
        resolve();
      });
      client.connect({
        host,
        port,
        username: user,
        sock,
        authHandler: methods,
        readyTimeout: options.readyTimeoutMs ?? 20_000,
        hostVerifier: (key: Buffer, verified: (valid: boolean) => void) => {
          void verifyHostKey({ host, port, key, file }).then(
            () => verified(true),
            (cause: unknown) => {
              failure = connectionError(cause);
              verified(false);
            },
          );
        },
      });
    });
  } catch (cause) {
    close();
    throw failure ?? connectionError(cause);
  }

  const literals = [
    ...authLiterals(methods),
    ...["TS_AUTHKEY", "TAILSCALE_AUTHKEY", "TS_SSH_KEY", "TS_SSH_KEY_FILE", "TS_SSH_PASSWORD"]
      .map((name) => env[name])
      .filter((value): value is string => !!value),
  ];

  function runChannel(
    start: (callback: (error: Error | undefined, channel: ClientChannel) => void) => void,
    io: SshIo,
    terminal?: { stdin: TerminalInput; stdout: TerminalOutput },
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      if (failure || closed) {
        reject(failure ?? connectionError());
        return;
      }
      let channel: ClientChannel | undefined;
      let finished = false;
      let exitCode = 1;
      const out = maskedOutput(io.stdout ?? process.stdout, literals);
      const err = maskedOutput(io.stderr ?? process.stderr, literals);
      const inputWasPaused = io.stdin?.isPaused();
      const wasRaw = terminal?.stdin.isRaw ?? false;
      const resize = () => {
        channel?.setWindow(terminal?.stdout.rows ?? 24, terminal?.stdout.columns ?? 80, 0, 0);
      };
      const done = (error?: unknown) => {
        if (finished) return;
        finished = true;
        listeners.delete(disconnected);
        if (channel) io.stdin?.unpipe(channel);
        if (inputWasPaused !== false) io.stdin?.pause();
        if (terminal) {
          terminal.stdout.off("resize", resize);
          terminal.stdin.setRawMode?.(wasRaw);
        }
        out.end();
        err.end();
        if (error) reject(connectionError(error));
        else resolve(exitCode);
      };
      const disconnected = (error: CtError) => done(error);
      listeners.add(disconnected);
      try {
        start((error, stream) => {
          if (finished) {
            stream?.destroy();
            return;
          }
          if (error) {
            done(error);
            return;
          }
          channel = stream;
          stream.on("data", (chunk: Buffer) => {
            if (!finished) out.write(chunk);
          });
          stream.stderr.on("data", (chunk: Buffer) => {
            if (!finished) err.write(chunk);
          });
          stream.once("error", done);
          stream.once("exit", (code: number | null, signal?: string) => {
            exitCode =
              code ?? (signal ? 128 + (osConstants.signals[signal as NodeJS.Signals] ?? 0) : 1);
          });
          stream.once("close", () => done());
          if (terminal) {
            terminal.stdin.setRawMode?.(true);
            terminal.stdout.on("resize", resize);
            resize();
          }
          if (io.stdin) io.stdin.pipe(stream);
          else stream.end();
        });
      } catch (cause) {
        done(cause);
      }
    });
  }

  return {
    exec(command, io = {}) {
      return runChannel((callback) => client.exec(command, callback), io);
    },
    shell(io = {}) {
      const stdin = io.stdin ?? process.stdin;
      const stdout = io.stdout ?? process.stdout;
      if (!stdin.isTTY || !stdin.setRawMode) {
        throw new CtError(
          "INVALID_ARGUMENT",
          "An interactive SSH shell needs a terminal.",
          "Run cloud-tailscale ssh user@host -- command when no terminal is available.",
        );
      }
      return runChannel(
        (callback) =>
          client.shell(
            {
              term: io.term ?? env.TERM ?? "xterm",
              rows: stdout.rows ?? 24,
              cols: stdout.columns ?? 80,
            },
            callback,
          ),
        { stdin, stdout, stderr: io.stderr },
        { stdin, stdout },
      );
    },
    close,
  };
}
