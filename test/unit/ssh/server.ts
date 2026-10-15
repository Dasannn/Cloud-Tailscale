import type { Socket } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { type Connection, Server, type ServerChannel, utils } from "ssh2";

// Disposable test keys are generated in memory; no credentials or key files are committed.
function testKey() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { private: privateKey.export({ type: "sec1", format: "pem" }).toString() };
}
export const hostKey = testKey();
export const changedHostKey = testKey();
export const userKey = testKey();
export const password = "FAKE-ssh-password";

export function memoryServer(
  options: {
    hostPrivateKey?: string;
    acceptPassword?: boolean;
    acceptKey?: boolean;
    exec?: (channel: ServerChannel, command: string, client: Connection) => void;
    shell?: (channel: ServerChannel, client: Connection) => void;
  } = {},
) {
  const authAttempts: string[] = [];
  const commands: string[] = [];
  const users: string[] = [];
  const windows: { rows: number; cols: number }[] = [];
  const errors: Error[] = [];
  const streams: Duplex[] = [];
  const clients: Connection[] = [];
  const server = new Server({ hostKeys: [options.hostPrivateKey ?? hostKey.private] });
  const publicKey = utils.parseKey(userKey.private);
  if (publicKey instanceof Error) throw publicKey;
  if (Array.isArray(publicKey)) throw new Error("Unexpected multiple test keys");
  server.on("connection", (client) => {
    clients.push(client);
    client.on("error", (error) => errors.push(error));
    client.on("authentication", (context) => {
      authAttempts.push(context.method);
      users.push(context.username);
      if (
        context.method === "password" &&
        options.acceptPassword !== false &&
        context.password === password
      ) {
        context.accept();
      } else if (
        context.method === "publickey" &&
        options.acceptKey !== false &&
        context.key.data.equals(publicKey.getPublicSSH()) &&
        (!context.signature ||
          publicKey.verify(context.blob, context.signature, context.hashAlgo) === true)
      ) {
        context.accept();
      } else {
        context.reject(["publickey", "password"]);
      }
    });
    client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty, _reject, window) => {
        windows.push(window);
        acceptPty?.();
      });
      session.on("window-change", (acceptWindow, _reject, window) => {
        windows.push(window);
        acceptWindow?.();
      });
      session.on("exec", (acceptExec, _reject, info) => {
        commands.push(info.command);
        const channel = acceptExec();
        if (options.exec) options.exec(channel, info.command, client);
        else {
          channel.write("FAKE stdout\n");
          channel.stderr.write("FAKE stderr\n");
          channel.exit(0);
          channel.end();
        }
      });
      session.on("shell", (acceptShell) => {
        const channel = acceptShell();
        if (options.shell) options.shell(channel, client);
        else {
          channel.exit(0);
          channel.end("FAKE shell\n");
        }
      });
    });
  });
  return {
    authAttempts,
    commands,
    users,
    windows,
    errors,
    factory: () => {
      const incoming = new PassThrough();
      const outgoing = new PassThrough();
      const client = Duplex.from({ readable: incoming, writable: outgoing });
      const remote = Duplex.from({ readable: outgoing, writable: incoming });
      streams.push(client, remote);
      server.injectSocket(remote as Socket);
      return client;
    },
    close: () => {
      for (const client of clients) client.end();
      for (const stream of streams) stream.destroy();
    },
  };
}

import { generateKeyPairSync } from "node:crypto";
