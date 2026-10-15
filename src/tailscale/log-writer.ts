import { spawn } from "node:child_process";
import { closeSync, constants, fchmodSync, openSync, writeFileSync } from "node:fs";
import { registerSecret } from "../core/output.js";
import { type LogWriterInput, writeMaskedLines } from "./log.js";

// This process has no inherited terminal or log fd. It exits when tailscaled closes its pipes.
async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const config: LogWriterInput = JSON.parse(input);
  for (const secret of config.secrets) {
    registerSecret(secret);
    // A multiline secret must stay masked even when its lines arrive separately.
    for (const line of secret.split(/\r?\n/)) registerSecret(line);
  }
  const log = openSync(
    config.logFile,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(log, 0o600);
    const daemon = spawn(config.command, config.args, {
      env: process.env,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.once("spawn", () => {
      process.send?.({ pid: daemon.pid }, () => process.disconnect?.());
    });
    const exited = new Promise<void>((resolve, reject) => {
      daemon.once("error", reject);
      daemon.once("close", () => resolve());
    });
    const write = (line: string) => writeFileSync(log, line);
    try {
      await Promise.all([
        writeMaskedLines(daemon.stdout, write),
        writeMaskedLines(daemon.stderr, write),
        exited,
      ]);
    } catch (cause) {
      daemon.kill("SIGTERM");
      daemon.stdout.destroy();
      daemon.stderr.destroy();
      throw cause;
    }
  } finally {
    closeSync(log);
  }
}

void main().catch(() => {
  // Raw exception details could contain credentials. Only signal a generic startup failure.
  if (process.connected) process.send?.({ error: true }, () => process.disconnect?.());
  process.exitCode = 1;
});
