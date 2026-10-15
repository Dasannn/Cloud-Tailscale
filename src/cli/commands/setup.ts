import { CtError, type ErrorCode } from "../../core/errors.js";
import { detectHost } from "../../core/host.js";
import type { Result } from "../../core/output.js";
import { getAuthKey } from "../../core/secrets.js";
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
): Promise<Result<{ steps: SetupStep[] }>> {
  if (args.length !== 0) {
    throw new CtError(
      "INVALID_ARGUMENT",
      "The setup command does not accept arguments.",
      "Run cloud-tailscale setup; set credentials only in the environment's secrets.",
    );
  }
  const env = dependencies.env ?? process.env;
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
  return {
    ok,
    message: [
      ok ? "Cloud-Tailscale setup completed." : "Cloud-Tailscale setup needs attention.",
      ...steps.map(
        (step) =>
          `${step.name}: ${step.status}${step.code ? ` (${step.code})` : ""} — ${step.message}${step.next ? ` Next: ${step.next}` : ""}`,
      ),
    ].join("\n"),
    data: { steps },
  };
}
