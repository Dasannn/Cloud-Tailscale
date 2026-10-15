import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CtError, type ErrorCode } from "../../core/errors.js";
import { detectHost } from "../../core/host.js";
import { mask, type Result } from "../../core/output.js";
import { ensurePaths, type RuntimePaths } from "../../core/paths.js";
import { getAuthKey, registerEnvironmentSecrets } from "../../core/secrets.js";
import { installSkill, type SkillInstallation } from "../../core/skill.js";
import { connect } from "../../tailscale/connect.js";
import { connectionData } from "./up.js";

export interface SetupStep {
  name: "up" | "skill";
  status: "completed" | "skipped" | "failed";
  message: string;
  code?: ErrorCode;
  next?: string;
  data?: unknown;
}

export interface SetupDependencies {
  env?: NodeJS.ProcessEnv;
  up?: () => Result<unknown> | Promise<Result<unknown>>;
  installSkill?: () => Promise<SkillInstallation>;
}

const secretVariables = [
  "TS_AUTHKEY",
  "TAILSCALE_AUTHKEY",
  "TS_SSH_KEY",
  "TS_SSH_KEY_FILE",
  "TS_SSH_PASSWORD",
  "TS_SSH_USER",
] as const;

async function writeSetupLog(paths: RuntimePaths, report: string): Promise<void> {
  let temporary: string | undefined;
  try {
    temporary = await mkdtemp(join(paths.home, ".setup-"));
    const file = join(temporary, "setup.log");
    await writeFile(file, mask(report), { mode: 0o600, flag: "wx" });
    // Replace the previous report without following a link or retaining old permissions.
    await rename(file, paths.setupLogFile);
  } catch (cause) {
    throw new CtError(
      "HOME_UNAVAILABLE",
      `Cannot write the setup report to ${paths.setupLogFile}.`,
      "Set CLOUD_TAILSCALE_HOME to a private writable directory outside the project, then retry cts setup.",
      { cause },
    );
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

async function defaultUp(env: NodeJS.ProcessEnv): Promise<Result> {
  const data = connectionData(await connect({ env }));
  return {
    ok: true,
    message: `${data.alreadyConnected ? "Already connected" : "Connected"} as ${data.name} (${data.ips.join(", ") || "IP pending"}) in ${data.mode} mode; DERP ${data.derp}.`,
    data,
  };
}

function failedStep(name: SetupStep["name"], cause: unknown): SetupStep {
  const error =
    cause instanceof CtError
      ? cause
      : new CtError(
          "INTERNAL_ERROR",
          cause instanceof Error ? cause.message : `The ${name} step failed.`,
          "Retry setup; if the failure persists, report the error with secrets removed.",
        );
  return {
    name,
    status: name === "up" && error.code === "AUTH_KEY_MISSING" ? "skipped" : "failed",
    message: error.message,
    code: error.code,
    next: error.next,
  };
}

export async function setupCommand(
  args: string[],
  dependencies: SetupDependencies = {},
): Promise<Result<{ steps: SetupStep[]; setupLogFile: string }>> {
  if (args.length !== 0) {
    throw new CtError(
      "INVALID_ARGUMENT",
      "The setup command does not accept arguments.",
      "Run cloud-tailscale setup; set credentials only in the environment's secrets.",
    );
  }
  const env = dependencies.env ?? process.env;
  registerEnvironmentSecrets(env);
  const timestamp = new Date().toISOString();
  const secretStatus = secretVariables.map((name) => `${name}: ${env[name] ? "SET" : "UNSET"}`);
  const steps: SetupStep[] = [];
  if (!getAuthKey(env)) {
    steps.push(
      failedStep(
        "up",
        new CtError(
          "AUTH_KEY_MISSING",
          "TS_AUTHKEY (or TAILSCALE_AUTHKEY) is missing; connection deferred.",
          "Create a reusable, ephemeral, pre-approved, tagged Tailscale auth key with restricted ACLs, add it to the environment's secrets as TS_AUTHKEY, then run cts up. Never paste the key into chat.",
        ),
      ),
    );
  } else {
    try {
      const result = await (dependencies.up ?? (() => defaultUp(env)))();
      steps.push({
        name: "up",
        status: result.ok ? "completed" : "failed",
        message: result.message,
        ...(!result.ok
          ? { next: "Resolve the reported connection failure, then run cts up." }
          : {}),
        data: result.data,
      });
    } catch (cause) {
      steps.push(failedStep("up", cause));
    }
  }

  if (detectHost(env) === "claude") {
    try {
      const installation = await (dependencies.installSkill ?? (() => installSkill(env)))();
      steps.push({
        name: "skill",
        status: "completed",
        message: `Cloud-Tailscale skill ${installation.action}: ${installation.path}.`,
        data: installation,
      });
    } catch (cause) {
      steps.push(failedStep("skill", cause));
    }
  } else {
    steps.push({
      name: "skill",
      status: "skipped",
      message:
        "This host is not Claude Code. Use cts skill --print for this session, or explicitly run cts skill --repo to add the Codex repository skill for review and commit.",
    });
  }

  const ok = steps.every((step) => step.status !== "failed");
  const paths = await ensurePaths(env);
  const message = [
    ok ? "Cloud-Tailscale setup completed." : "Cloud-Tailscale setup needs attention.",
    ...steps.map(
      (step) =>
        `${step.name}: ${step.status}${step.code ? ` (${step.code})` : ""} — ${step.message}${step.next ? ` Next: ${step.next}` : ""}`,
    ),
    `Setup log: ${paths.setupLogFile}.`,
  ].join("\n");
  await writeSetupLog(paths, [`UTC: ${timestamp}`, ...secretStatus, "", message, ""].join("\n"));
  return { ok, message, data: { steps, setupLogFile: paths.setupLogFile } };
}
