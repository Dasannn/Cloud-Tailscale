import { CtError } from "../core/errors.js";
import { clearSecrets, printError, printResult, type Result } from "../core/output.js";
import { registerEnvironmentSecrets } from "../core/secrets.js";
import { createSshCommands } from "./commands/ssh.js";

export interface CommandResult extends Result<unknown> {
  exitCode?: number;
}

export type Command = (
  args: string[],
  context?: { json: boolean },
) => CommandResult | Promise<CommandResult>;

const commandNames = ["up", "status", "down", "nc", "env", "ssh", "ssh-config", "skill", "setup"];

export const commands: Readonly<Record<string, Command>> = Object.fromEntries(
  commandNames.map((name) => [
    name,
    () => {
      throw new CtError(
        "NOT_IMPLEMENTED",
        `The ${name} command is not implemented yet.`,
        "Use a Cloud-Tailscale release that includes this command.",
      );
    },
  ]),
);

Object.assign(commands, createSshCommands());

function help(): Result {
  return {
    ok: true,
    message: [
      "Usage: cloud-tailscale <command> [args] [--json] [--help]",
      "Alias: cts",
      "",
      `Commands: ${commandNames.join(", ")}`,
      "",
      "Options:",
      "  --json  Print a machine-readable result.",
      "  --help  Show this help.",
    ].join("\n"),
    data: { commands: commandNames },
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  registerEnvironmentSecrets();
  let json = false;
  let showHelp = false;
  const args: string[] = [];
  let passthrough = false;
  for (const arg of argv) {
    if (!passthrough && arg === "--") {
      passthrough = true;
      args.push(arg);
    } else if (!passthrough && arg === "--json") {
      json = true;
    } else if (!passthrough && arg === "--help") {
      showHelp = true;
    } else {
      args.push(arg);
    }
  }

  try {
    const name = args.shift();
    if (showHelp || name === undefined) {
      printResult(help(), json);
      return 0;
    }
    const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
    if (!command) {
      throw new CtError(
        "INVALID_ARGUMENT",
        `Unknown command: ${name}.`,
        "Run cloud-tailscale --help to list commands.",
      );
    }
    const result = await command(args, { json });
    printResult(result, json);
    return result.exitCode ?? (result.ok ? 0 : 1);
  } catch (cause) {
    const error =
      cause instanceof CtError
        ? cause
        : new CtError(
            "INTERNAL_ERROR",
            cause instanceof Error ? cause.message : "An unexpected error occurred.",
            "Retry the command; if it persists, report the error with secrets removed.",
          );
    printError(error, json);
    return 1;
  } finally {
    clearSecrets();
  }
}
