import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupCommand } from "../../../src/cli/commands/setup.js";
import { commands, main } from "../../../src/cli/main.js";
import { CtError } from "../../../src/core/errors.js";
import { clearSecrets } from "../../../src/core/output.js";
import { installSkill } from "../../../src/core/skill.js";
import { connect } from "../../../src/tailscale/connect.js";

vi.mock("../../../src/tailscale/connect.js", () => ({
  connect: vi.fn(),
  ensureConnected: vi.fn(),
}));

vi.mock("../../../src/core/skill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/skill.js")>()),
  installSkill: vi.fn(),
}));

const installation = {
  path: "/tmp/FAKE-home/.claude/skills/cloud-tailscale/SKILL.md",
  action: "installed" as const,
};
const connected = {
  ok: true,
  message: "Connected as claude-cloud-FAKE.",
  data: { ip: "100.64.0.1" },
};
let temp: string;
let home: string;
let claudeEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  temp = await mkdtemp("/tmp/cts-setup-test-");
  home = join(temp, "home");
  claudeEnv = { CLOUD_TAILSCALE_HOME: home, CLAUDECODE: "1", TS_AUTHKEY: "tskey-auth-FAKE" };
  vi.stubEnv("CLOUD_TAILSCALE_HOME", home);
  vi.clearAllMocks();
  vi.mocked(connect).mockReset();
  vi.mocked(installSkill).mockResolvedValue(installation);
});

afterEach(async () => {
  clearSecrets();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(temp, { recursive: true, force: true });
});

describe("setup steps", () => {
  it("calls the injected up before installing the Claude skill and reports both steps", async () => {
    const calls: string[] = [];
    const result = await setupCommand([], {
      env: claudeEnv,
      up: async () => {
        calls.push("up");
        return connected;
      },
      installSkill: async () => {
        calls.push("skill");
        return installation;
      },
    });
    expect(calls).toEqual(["up", "skill"]);
    expect(result).toMatchObject({
      ok: true,
      data: {
        steps: [
          { name: "up", status: "completed", data: connected.data },
          { name: "skill", status: "completed", data: installation },
        ],
      },
    });
    expect(result.message).toContain("Connected as claude-cloud-FAKE");
    expect(result.message).toContain(installation.path);
  });

  it("skips a missing key without failing setup or skipping skill installation", async () => {
    const up = vi.fn();
    const env = { ...claudeEnv, TS_AUTHKEY: "" };
    const result = await setupCommand([], { env, up });
    expect(up).not.toHaveBeenCalled();
    expect(installSkill).toHaveBeenCalledExactlyOnceWith(env);
    expect(result).toMatchObject({
      ok: true,
      data: {
        steps: [
          {
            name: "up",
            status: "skipped",
            code: "AUTH_KEY_MISSING",
            next: expect.stringContaining("cts up"),
          },
          { name: "skill", status: "completed" },
        ],
      },
    });
    expect(result.message).toContain("TS_AUTHKEY");
  });

  it("accepts the fallback auth key without passing it as an up argument", async () => {
    const up = vi.fn().mockResolvedValue(connected);
    const result = await setupCommand([], {
      env: {
        CLOUD_TAILSCALE_HOME: home,
        CLAUDE_CODE_ENTRYPOINT: "FAKE",
        TAILSCALE_AUTHKEY: "tskey-auth-FAKE",
      },
      up,
    });
    expect(result.ok).toBe(true);
    expect(up).toHaveBeenCalledExactlyOnceWith();
    expect(installSkill).toHaveBeenCalledOnce();
  });

  it("treats an AUTH_KEY_MISSING error from up as nonfatal too", async () => {
    const up = vi
      .fn()
      .mockRejectedValue(
        new CtError("AUTH_KEY_MISSING", "FAKE key missing", "Configure TS_AUTHKEY."),
      );
    const result = await setupCommand([], { env: claudeEnv, up });
    expect(result.ok).toBe(true);
    expect(result.data.steps[0]).toMatchObject({ status: "skipped", code: "AUTH_KEY_MISSING" });
    expect(installSkill).toHaveBeenCalledOnce();
  });

  it("uses the real connection provider by default and reports the connected node", async () => {
    vi.mocked(connect).mockResolvedValue({
      config: { hostname: "claude-cloud-FAKE", mode: "userspace", proxyPort: 1055 },
      status: {
        BackendState: "Running",
        TailscaleIPs: ["100.64.0.10"],
        Self: { HostName: "claude-cloud-FAKE", Relay: "nyc" },
      },
      alreadyConnected: false,
    } as never);
    const result = await setupCommand([], { env: claudeEnv });
    expect(connect).toHaveBeenCalledExactlyOnceWith({ env: claudeEnv });
    expect(result.ok).toBe(true);
    expect(result.data.steps).toMatchObject([
      {
        name: "up",
        status: "completed",
        message: expect.stringContaining("Connected as claude-cloud-FAKE (100.64.0.10)"),
        data: { mode: "userspace", derp: "nyc" },
      },
      { name: "skill", status: "completed" },
    ]);
    expect(vi.mocked(connect).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(installSkill).mock.invocationCallOrder[0],
    );
  });

  it("reports a real connection failure while still installing the Claude skill", async () => {
    vi.mocked(connect).mockRejectedValue(
      new CtError("AUTH_KEY_REJECTED", "FAKE key expired.", "Replace TS_AUTHKEY in secrets."),
    );
    const result = await setupCommand([], { env: claudeEnv });
    expect(result).toMatchObject({
      ok: false,
      data: {
        steps: [
          { name: "up", status: "failed", code: "AUTH_KEY_REJECTED" },
          { name: "skill", status: "completed" },
        ],
      },
    });
    expect(result.message).toContain("Replace TS_AUTHKEY in secrets.");
  });

  it.each(["AUTH_KEY_REJECTED", "CONTROL_UNREACHABLE", "DERP_UNREACHABLE"] as const)(
    "does not suppress %s or prevent skill installation",
    async (code) => {
      const result = await setupCommand([], {
        env: claudeEnv,
        up: () => {
          throw new CtError(code, "FAKE connection failure", "FAKE next step");
        },
      });
      expect(result.ok).toBe(false);
      expect(result.message).toContain(code);
      expect(result.message).toContain("FAKE next step");
      expect(result.data.steps[0]).toMatchObject({ status: "failed", code });
      expect(installSkill).toHaveBeenCalledOnce();
    },
  );

  it("preserves unsuccessful up result details", async () => {
    const result = await setupCommand([], {
      env: claudeEnv,
      up: () => ({ ok: false, message: "FAKE rejected", data: { code: "AUTH_KEY_REJECTED" } }),
    });
    expect(result.ok).toBe(false);
    expect(result.data.steps[0]).toMatchObject({
      status: "failed",
      message: "FAKE rejected",
      data: { code: "AUTH_KEY_REJECTED" },
    });
    expect(installSkill).toHaveBeenCalledOnce();
  });

  it("reports installation failure even if up succeeded", async () => {
    vi.mocked(installSkill).mockRejectedValue(
      new CtError("SKILL_CONFLICT", "FAKE foreign file", "Review the file."),
    );
    const result = await setupCommand([], { env: claudeEnv, up: () => connected });
    expect(result).toMatchObject({
      ok: false,
      data: {
        steps: [
          { name: "up", status: "completed" },
          { name: "skill", status: "failed", code: "SKILL_CONFLICT" },
        ],
      },
    });
    expect(result.message).toContain("Review the file.");
  });

  it("does not suppress a skill error when the auth key is missing", async () => {
    vi.mocked(installSkill).mockRejectedValue(
      new CtError("SKILL_INSTALL_FAILED", "FAKE read-only", "Print the skill."),
    );
    const result = await setupCommand([], { env: { ...claudeEnv, TS_AUTHKEY: "" } });
    expect(result.ok).toBe(false);
    expect(result.data.steps.map((step) => step.status)).toEqual(["skipped", "failed"]);
  });

  it.each([{ CODEX_THREAD_ID: "FAKE" }, {}])(
    "does not write a skill on other hosts: %s",
    async (host) => {
      const result = await setupCommand([], {
        env: { ...host, CLOUD_TAILSCALE_HOME: home, TS_AUTHKEY: "tskey-auth-FAKE" },
        up: () => connected,
      });
      expect(result.ok).toBe(true);
      expect(result.data.steps[1]).toMatchObject({ name: "skill", status: "skipped" });
      expect(installSkill).not.toHaveBeenCalled();
    },
  );

  it.each(["up", "skill"] as const)(
    "reports unexpected %s errors with a next step",
    async (step) => {
      const fail = () => {
        throw new Error("FAKE unexpected error");
      };
      if (step === "skill") vi.mocked(installSkill).mockImplementation(fail);
      const result = await setupCommand([], {
        env: claudeEnv,
        up: step === "up" ? fail : () => connected,
      });
      expect(result.ok).toBe(false);
      expect(result.data.steps.find((value) => value.name === step)).toMatchObject({
        status: "failed",
        code: "INTERNAL_ERROR",
        message: "FAKE unexpected error",
        next: expect.any(String),
      });
    },
  );

  it("rejects arguments before up or skill installation", async () => {
    const up = vi.fn();
    await expect(
      setupCommand(["--auth-key", "tskey-auth-FAKE"], { env: claudeEnv, up }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(up).not.toHaveBeenCalled();
    expect(installSkill).not.toHaveBeenCalled();
  });
});

describe("setup log", () => {
  it("writes the plain-text step report, UTC timestamp and secret presence privately", async () => {
    const start = Date.now();
    const result = await setupCommand([], {
      env: { ...claudeEnv, TS_SSH_USER: "FAKE-user", TS_SSH_PASSWORD: "" },
      up: () => connected,
    });
    expect(result.data.setupLogFile).toBe(join(home, "setup.log"));
    const log = await readFile(result.data.setupLogFile, "utf8");
    const timestamp = log.match(/^UTC: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\n/)?.[1];
    expect(timestamp).toBeDefined();
    expect(Date.parse(timestamp ?? "")).toBeGreaterThanOrEqual(start);
    expect(Date.parse(timestamp ?? "")).toBeLessThanOrEqual(Date.now());
    expect(log).toContain(
      "TS_AUTHKEY: SET\nTAILSCALE_AUTHKEY: UNSET\nTS_SSH_KEY: UNSET\nTS_SSH_KEY_FILE: UNSET\nTS_SSH_PASSWORD: UNSET\nTS_SSH_USER: SET\n",
    );
    expect(log).toContain(`${result.message}\n`);
    expect(log).toContain("up: completed");
    expect(log).toContain("skill: completed");
    expect(log).not.toContain("tskey-auth-FAKE");
    expect(log).not.toContain("FAKE-user");
    expect((await stat(result.data.setupLogFile)).mode & 0o777).toBe(0o600);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it("masks credentials in messages and next steps even without the dispatcher", async () => {
    const secrets = {
      TS_AUTHKEY: "FAKE-auth-key",
      TAILSCALE_AUTHKEY: "FAKE-fallback-key",
      TS_SSH_KEY: "-----BEGIN PRIVATE KEY-----\nFAKE-key-body\n-----END PRIVATE KEY-----",
      TS_SSH_KEY_FILE: "/FAKE/private-key",
      TS_SSH_PASSWORD: "FAKE-password",
    };
    const result = await setupCommand([], {
      env: { ...claudeEnv, ...secrets },
      up: () => {
        throw new CtError(
          "AUTH_KEY_REJECTED",
          `Rejected ${Object.values(secrets).join("; ")}; tskey-unregistered-FAKE`,
          "Check https://FAKE-proxy-user:FAKE-proxy-password@proxy.example.",
        );
      },
    });
    const log = await readFile(result.data.setupLogFile, "utf8");
    for (const [name, value] of Object.entries(secrets)) {
      expect(log).toContain(`${name}: SET`);
      expect(log).not.toContain(value);
    }
    expect(log).not.toContain("FAKE-key-body");
    expect(log).not.toContain("tskey-unregistered-FAKE");
    expect(log).not.toContain("FAKE-proxy-user");
    expect(log).not.toContain("FAKE-proxy-password");
    expect(log).toContain("[REDACTED]");
    expect(log).toContain("up: failed (AUTH_KEY_REJECTED)");
    expect(log).toContain("Next: Check https://[REDACTED]@proxy.example.");
    expect(log).toContain("skill: completed");
  });

  it("records a deferred connection and a failed skill installation", async () => {
    vi.mocked(installSkill).mockRejectedValue(
      new CtError("SKILL_INSTALL_FAILED", "FAKE read-only", "Print the skill."),
    );
    const result = await setupCommand([], { env: { ...claudeEnv, TS_AUTHKEY: undefined } });
    const log = await readFile(result.data.setupLogFile, "utf8");
    expect(result.ok).toBe(false);
    expect(log).toContain("Cloud-Tailscale setup needs attention.");
    expect(log).toContain("TS_AUTHKEY: UNSET");
    expect(log).toContain("up: skipped (AUTH_KEY_MISSING)");
    expect(log).toContain("skill: failed (SKILL_INSTALL_FAILED)");
    expect(log).toContain("Next: Print the skill.");
  });

  it("replaces an older report and its permissions on every run", async () => {
    const first = await setupCommand([], {
      env: claudeEnv,
      up: () => ({ ...connected, message: "FAKE older report".repeat(100) }),
    });
    await chmod(first.data.setupLogFile, 0o644);
    const second = await setupCommand([], { env: { ...claudeEnv, TS_AUTHKEY: "" } });
    const log = await readFile(second.data.setupLogFile, "utf8");
    expect(log).not.toContain("FAKE older report");
    expect(log).toContain("up: skipped (AUTH_KEY_MISSING)");
    expect((await stat(second.data.setupLogFile)).mode & 0o777).toBe(0o600);
    expect((await readdir(home)).sort()).toEqual(["bin", "run", "setup.log"]);
  });

  it("replaces a linked report without writing to its target", async () => {
    await mkdir(home);
    const target = join(temp, "FAKE-user-file");
    await writeFile(target, "FAKE existing content", { mode: 0o640 });
    await symlink(target, join(home, "setup.log"));
    const result = await setupCommand([], { env: claudeEnv, up: () => connected });
    expect(await readFile(target, "utf8")).toBe("FAKE existing content");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    expect(await readFile(result.data.setupLogFile, "utf8")).toContain("up: completed");
    expect((await stat(result.data.setupLogFile)).mode & 0o777).toBe(0o600);
  });

  it("reports a log write failure with an actionable error and removes temporary files", async () => {
    await mkdir(home);
    await mkdir(join(home, "setup.log"));
    await expect(setupCommand([], { env: claudeEnv, up: () => connected })).rejects.toMatchObject({
      code: "HOME_UNAVAILABLE",
      message: expect.stringContaining(join(home, "setup.log")),
      next: expect.stringContaining("CLOUD_TAILSCALE_HOME"),
    });
    expect((await readdir(home)).sort()).toEqual(["bin", "run", "setup.log"]);
  });
});

describe("setup output through the dispatcher", () => {
  it("succeeds without a key and emits one JSON result with both steps", async () => {
    vi.stubEnv("TS_AUTHKEY", "");
    vi.stubEnv("TAILSCALE_AUTHKEY", "");
    vi.stubEnv("CLAUDECODE", "1");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await main(["setup", "--json"])).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({
      ok: true,
      data: { steps: [{ code: "AUTH_KEY_MISSING" }, { status: "completed" }] },
    });
  });

  it.each([false, true])(
    "masks all step data and reports failure on stderr (json=%s)",
    async (json) => {
      vi.stubEnv("TS_AUTHKEY", "tskey-auth-FAKE");
      vi.stubEnv("TS_SSH_PASSWORD", "FAKE-password");
      vi.spyOn(commands, "setup").mockImplementation((args) =>
        setupCommand(args, {
          env: claudeEnv,
          up: () => {
            throw new CtError(
              "AUTH_KEY_REJECTED",
              "Rejected tskey-auth-FAKE",
              "Replace FAKE-password in secrets.",
            );
          },
        }),
      );
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      expect(await main(["setup", ...(json ? ["--json"] : [])])).toBe(1);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledOnce();
      const output = String(stderr.mock.calls[0][0]);
      expect(output).not.toContain("tskey-auth-FAKE");
      expect(output).not.toContain("FAKE-password");
      expect(output).toContain("[REDACTED]");
      if (json) {
        expect(JSON.parse(output)).toMatchObject({
          ok: false,
          data: { steps: [{ code: "AUTH_KEY_REJECTED" }, { status: "completed" }] },
        });
      }
    },
  );
});
