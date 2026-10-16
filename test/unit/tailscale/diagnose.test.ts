import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TailscaleStatus } from "../../../src/tailscale/client.js";
import { diagnose, readLogTail } from "../../../src/tailscale/diagnose.js";

const fixture = (name: string) =>
  readFile(new URL(`../../fixtures/tailscale/${name}`, import.meta.url), "utf8");

const weakLoginSignals = ["Logged out.", "To authenticate, visit:"];
const startupMessages = [
  "Switching ipn state Starting -> NeedsLogin",
  "control: LoginInteractive -> regen=true",
  "control: doLogin(regen=true, hasUrl=false)",
  "control: Generating a new nodekey.",
];
const loginMessages = [...weakLoginSignals, ...startupMessages];
const mixedWindows = (first: string, second: string) => [
  `${first}\n${second}`,
  `${second}\n${first}`,
];

describe("connection diagnostics", () => {
  it.each([
    ["auth-rejected.log", "AUTH_KEY_REJECTED", "TS_AUTHKEY"],
    ["control-unreachable.log", "CONTROL_UNREACHABLE", "controlplane.tailscale.com"],
    ["derp-unreachable.log", "DERP_UNREACHABLE", "*.tailscale.com"],
    ["login-required.txt", "AUTH_KEY_REJECTED", "ephemeral"],
    ["status-logged-out.txt", "AUTH_KEY_REJECTED", "tagged"],
  ])("classifies %s with an actionable next step", async (name, code, next) => {
    const error = diagnose(await fixture(name));
    expect(error.code).toBe(code);
    expect(error.next).toContain(next);
    expect(error.message).not.toContain("https://login.tailscale.com/a/");
  });
  it.each(["", ...loginMessages])(
    "prioritizes the observed control upgrade rejection over a login prompt: %s",
    async (loginText) => {
      for (const text of mixedWindows(await fixture("control-upgrade-rejected.log"), loginText)) {
        const error = diagnose(text);
        expect(error).toMatchObject({
          code: "CONTROL_UNREACHABLE",
          message: expect.stringContaining("HTTP 403"),
          next: expect.stringContaining("controlplane.tailscale.com"),
        });
        expect(error.message).toContain("after CONNECT");
        expect(error.next).toContain("upgrades");
        expect(error.next).toContain("/ts2021");
        expect(error.next).toContain("docs/guides/troubleshooting.md");
      }
    },
  );
  it.each([
    "invalid key: unable to validate API key",
    "invalid key: unable to validate API key: key expired",
    "invalid key: API key does not exist",
    "invalid key: API key FAKE not valid",
    "health(warnable=login-state): error: invalid key: API key does not exist",
    "RegisterReq: auth key expired",
    "RegisterReq: auth key revoked",
    "RegisterReq: auth key rejected",
    "RegisterReq: auth key not valid",
    "RegisterReq: auth key not found",
    "RegisterReq: auth-key revoked",
    "RegisterReq: authkey invalid",
    "RegisterReq: expired auth-key",
    "RegisterReq: authkey not found",
    "RegisterReq: not valid auth key",
  ])("prioritizes explicit key rejections over transport errors: %s", async (authText) => {
    const failures = [
      await fixture("control-upgrade-rejected.log"),
      "control: all connection attempts failed",
      "control: x509: certificate signed by unknown authority",
      "proxy CONNECT controlplane.tailscale.com:443 failed: 407 Proxy Authentication Required",
      "derphttp: unexpected HTTP response: 403 Forbidden",
    ];
    for (const status of [
      undefined,
      { BackendState: "NeedsLogin" },
      { BackendState: "NeedsMachineAuth" },
    ]) {
      expect(diagnose(authText, status)).toMatchObject({
        code: "AUTH_KEY_REJECTED",
        next: expect.stringContaining("TS_AUTHKEY"),
      });
      for (const failure of failures) {
        for (const text of mixedWindows(failure, authText)) {
          expect(diagnose(text, status)).toMatchObject({
            code: "AUTH_KEY_REJECTED",
            next: expect.stringContaining("TS_AUTHKEY"),
          });
        }
      }
    }
  });
  it("does not treat the login-state health wrapper as a control destination", () => {
    const health = "health(warnable=login-state): error: not logged in";
    expect(diagnose(health, { BackendState: "NeedsLogin" }).code).toBe("AUTH_KEY_REJECTED");
    for (const text of mixedWindows(health, "Logged out.")) {
      expect(diagnose(text).code).toBe("AUTH_KEY_REJECTED");
    }
  });
  it.each([403, 405, 407])("explains control proxy policy rejections (HTTP %s)", (code) => {
    const connect = "proxy CONNECT controlplane.tailscale.com:443: 200 Connection established";
    for (const separator of ["\n", "; "]) {
      const failure = `${connect}${separator}control: unexpected HTTP response: ${code}`;
      for (const text of mixedWindows(failure, "Logged out.")) {
        const error = diagnose(text, { BackendState: "NeedsMachineAuth" });
        expect(error.code).toBe("CONTROL_UNREACHABLE");
        expect(error.message).toContain(`HTTP ${code}`);
        expect(error.message).toContain("after CONNECT");
        expect(error.next).toContain("network policy");
        expect(error.next).toContain("/ts2021");
      }
    }
  });
  it.each([
    "register request: unexpected HTTP response: 401 Unauthorized",
    "Get https://login.tailscale.com: unexpected HTTP response: 503 Service Unavailable",
    "Post https://controlplane.tailscale.com/machine/register: all connection attempts failed",
    "control: proxyconnect tcp: connection refused",
    "proxy CONNECT to controlplane.tailscale.com:443 failed: connection refused",
    "Post https://controlplane.tailscale.com/machine/register: x509: certificate signed by unknown authority",
    "Get https://login.tailscale.com: no such host",
    "control: dial tcp: i/o timeout",
    "Get https://login.tailscale.com: context deadline exceeded",
    "control: tls: bad certificate",
  ])("prioritizes other control transport failures with generic guidance: %s", (text) => {
    for (const loginText of loginMessages) {
      for (const window of mixedWindows(text, loginText)) {
        for (const BackendState of ["NeedsLogin", "NeedsMachineAuth"]) {
          expect(diagnose(window, { BackendState })).toMatchObject({
            code: "CONTROL_UNREACHABLE",
            message: "Tailscale could not reach its control plane through the environment's proxy.",
            next: expect.stringContaining("CA bundle"),
          });
        }
      }
    }
  });
  it.each([
    "control: fetch control key: 404 Not Found",
    'control: fetch control key: Get "https://controlplane.tailscale.com/key": tls: failed to verify certificate: x509: certificate has expired or is not yet valid',
  ])("classifies control public-key fetch failures as transport failures: %s", (failure) => {
    for (const loginText of ["", ...loginMessages]) {
      for (const text of mixedWindows(failure, loginText)) {
        for (const status of [
          undefined,
          { BackendState: "NeedsLogin" },
          { BackendState: "NeedsMachineAuth" },
          { BackendState: "Running" },
        ]) {
          expect(diagnose(text, status)).toMatchObject({
            code: "CONTROL_UNREACHABLE",
            next: expect.stringContaining("CA bundle"),
          });
        }
      }
    }
  });
  it.each([
    "control: node key expired; renewing",
    "control: expired node key; renewing",
    "control: nodekey expired; regenerating",
    "control: node-key not valid; renewing",
    "control: RegisterReq: key revoked",
  ])("keeps node-key renewal below transport failures: %s", (renewal) => {
    for (const [failure, code] of [
      ["control: unexpected HTTP response: 403 Forbidden", "CONTROL_UNREACHABLE"],
      ["derphttp: unexpected HTTP response: 403 Forbidden", "DERP_UNREACHABLE"],
    ]) {
      for (const text of mixedWindows(failure, renewal)) {
        expect(diagnose(`${text}\nLogged out.`, { BackendState: "NeedsLogin" }).code).toBe(code);
      }
    }
  });
  describe.each([
    ["controlplane.tailscale.com", "CONTROL_UNREACHABLE", "controlplane.tailscale.com"],
    ["derp1b.tailscale.com", "DERP_UNREACHABLE", "*.tailscale.com DERP hosts"],
  ])("CONNECT rejections to %s", (host, expectedCode, allowedHosts) => {
    it.each([
      [403, "Forbidden"],
      [405, "Method Not Allowed"],
      [407, "Proxy Authentication Required"],
    ])("explains tunnel establishment failures (HTTP %s)", (code, reason) => {
      for (const failure of [
        `proxy CONNECT ${host}:443 failed: ${code} ${reason}`,
        `Get https://${host}: proxyconnect tcp: ${code} ${reason}`,
      ]) {
        for (const loginText of loginMessages) {
          for (const text of mixedWindows(failure, loginText)) {
            const error = diagnose(text);
            expect(error.code).toBe(expectedCode);
            expect(error.message).toContain(`HTTP ${code}`);
            expect(error.message).toContain("CONNECT tunnel");
            expect(error.message).not.toContain("after CONNECT");
            expect(error.next).not.toContain("upgrades");
            expect(error.next).not.toContain("/ts2021");
            if (code === 407) {
              expect(error.next).toContain("HTTPS_PROXY");
              expect(error.next).toContain("credentials");
            } else {
              expect(error.message).toContain("refused");
              expect(error.next).toContain("network policy");
              expect(error.next).toContain(allowedHosts);
            }
          }
        }
      }
    });
  });
  it.each([403, 405, 407, 500])(
    "prioritizes DERP HTTP rejections over auth text (HTTP %s)",
    (code) => {
      const failure =
        "proxy CONNECT derp1b.tailscale.com:443: 200 Connection established\n" +
        `Get https://derp1b.tailscale.com/derp: unexpected HTTP response: ${code}`;
      for (const text of mixedWindows(failure, "Logged out.")) {
        const error = diagnose(text);
        expect(error.code).toBe("DERP_UNREACHABLE");
        expect(error.next).toContain("*.tailscale.com DERP hosts");
        expect(error.next).toContain("upgrades");
        if (code !== 500) expect(error.message).toContain(`HTTP ${code}`);
      }
    },
  );
  it.each([
    "invalid key: unable to validate API key",
    "auth key expired",
    "control: failed to connect: invalid key: unable to validate API key",
    ...weakLoginSignals,
  ])("preserves auth failures without a transport rejection: %s", (text) => {
    expect(diagnose(text).code).toBe("AUTH_KEY_REJECTED");
  });
  it("treats NeedsLogin status as a weak login signal", () => {
    expect(diagnose("", { BackendState: "NeedsLogin" }).code).toBe("AUTH_KEY_REJECTED");
  });
  it.each(startupMessages)("ignores routine login startup messages: %s", (text) => {
    expect(diagnose(text).code).toBe("CONTROL_UNREACHABLE");
  });
  it.each(loginMessages)(
    "prioritizes current Running control status over login logs: %s",
    async (text) => {
      const status: TailscaleStatus = JSON.parse(await fixture("status-running.json"));
      status.Self = { ...status.Self, Online: false };
      expect(diagnose(text, status)).toMatchObject({
        code: "CONTROL_UNREACHABLE",
        message: expect.stringContaining("has not confirmed its control connection"),
      });
    },
  );
  it.each(loginMessages)("prioritizes current DERP health over login logs: %s", async (text) => {
    const status: TailscaleStatus = JSON.parse(await fixture("status-running.json"));
    status.Self = { ...status.Self, Online: false };
    status.Health = ["Tailscale could not connect to the 'New York City' relay server."];
    expect(diagnose(text, status).code).toBe("DERP_UNREACHABLE");
  });
  it.each(loginMessages)("prioritizes device approval over a login prompt: %s", (text) => {
    expect(diagnose(text, { BackendState: "NeedsMachineAuth" })).toMatchObject({
      code: "AUTH_KEY_REJECTED",
      next: expect.stringContaining("Approve the device"),
    });
  });
  it("keeps generic transport errors below weak login signals", () => {
    for (const text of mixedWindows(
      "x509: certificate signed by unknown authority",
      "Logged out.",
    )) {
      expect(diagnose(text).code).toBe("AUTH_KEY_REJECTED");
    }
  });
  it.each([
    "derphttp: x509: certificate signed by unknown authority",
    "derphttp: unexpected HTTP response: 403 Forbidden",
  ])("prioritizes DERP transport failures over control transport failures: %s", (failure) => {
    for (const text of mixedWindows(failure, "control: unexpected HTTP response: 403 Forbidden")) {
      expect(diagnose(`${text}\nLogged out.`, { BackendState: "NeedsMachineAuth" }).code).toBe(
        "DERP_UNREACHABLE",
      );
    }
  });
  it("keeps status health warnings below destination-specific control failures", () => {
    expect(
      diagnose("control: x509: certificate signed by unknown authority", {
        Health: ["not connected to home DERP region 1"],
      }).code,
    ).toBe("CONTROL_UNREACHABLE");
  });
  it("keeps an explicit auth rejection after a successful CONNECT classified as auth", () => {
    expect(
      diagnose(
        "proxy CONNECT controlplane.tailscale.com:443: 200 Connection established\n" +
          "control: RegisterReq: invalid key: unable to validate API key\n" +
          "To authenticate, visit:\nLogged out.",
      ).code,
    ).toBe("AUTH_KEY_REJECTED");
  });
  it("does not associate an unrelated HTTP rejection with a successful control or DERP line", () => {
    expect(
      diagnose(
        "proxy CONNECT controlplane.tailscale.com:443: 200 Connection established\n" +
          "magicsock: derp-1 connected; connGen=1\n" +
          "Get https://example.com: unexpected HTTP response: 403 Forbidden\nLogged out.",
      ).code,
    ).toBe("AUTH_KEY_REJECTED");
  });
  it("distinguishes no DERP home from a control-plane join timeout", () => {
    expect(diagnose("", { BackendState: "Running", Self: { Relay: "" } }).code).toBe(
      "DERP_UNREACHABLE",
    );
    expect(diagnose("", { BackendState: "Starting" }).code).toBe("CONTROL_UNREACHABLE");
    expect(diagnose("", { BackendState: "NeedsMachineAuth" })).toMatchObject({
      code: "AUTH_KEY_REJECTED",
      next: expect.stringContaining("Approve"),
    });
    expect(diagnose("x509: certificate signed by unknown authority").next).toContain("CA bundle");
  });
  it("does not treat proxy use or blocked UDP as a failure", async () => {
    const text = `${await fixture("proxy.log")}\nUDP blocked`;
    expect(
      diagnose(text, { BackendState: "Running", Self: { Relay: "nyc", Online: false } }).code,
    ).toBe("CONTROL_UNREACHABLE");
    expect(diagnose(text).code).toBe("CONTROL_UNREACHABLE");
  });
  it.each([
    "magicsock: [FAKE] derp.Recv(derp-1): derphttp.Client.Recv connect to region 1 (nyc): proxyconnect tcp: connection refused",
    "derphttp.Client.Recv: dial tcp: connection refused",
    "Get https://derp1b.tailscale.com/derp: proxyconnect tcp: connection refused",
    "derp.Recv(derp-1): tls: failed to verify certificate: x509: certificate signed by unknown authority",
    "tls: handshake failure connecting to derp1.tailscale.com",
    "derp.Recv(derp-1): remote error: tls: bad certificate",
    "derp.Recv(derp-1): tls: bad certificate",
    "derphttp.Client.Recv: tls: first record does not look like a TLS handshake",
    "Get https://derp1b.tailscale.com/derp: no such host",
    "derphttp.Client.Recv: context deadline exceeded",
    "derphttp.Client.Recv: dial tcp: i/o timeout",
  ])("classifies DERP-stage proxy and TLS errors with an assigned relay: %s", (text) => {
    expect(diagnose(text).code).toBe("DERP_UNREACHABLE");
    expect(diagnose(text, { BackendState: "Running", Self: { Relay: "nyc" } })).toMatchObject({
      code: "DERP_UNREACHABLE",
      next: expect.stringContaining("*.tailscale.com DERP hosts"),
    });
    for (const loginText of loginMessages) {
      for (const window of mixedWindows(text, loginText)) {
        for (const BackendState of ["NeedsLogin", "NeedsMachineAuth"]) {
          expect(diagnose(window, { BackendState }).code).toBe("DERP_UNREACHABLE");
        }
      }
    }
  });
  it("does not associate an unrelated successful DERP line with a control proxy error", () => {
    expect(
      diagnose(
        "magicsock: derp-1 connected; connGen=1\ncontrol: proxyconnect tcp: connection refused",
      ).code,
    ).toBe("CONTROL_UNREACHABLE");
  });
  it.each([
    "control: proxyconnect tcp: connection refused",
    "Post https://controlplane.tailscale.com/machine/register: x509: certificate signed by unknown authority",
    "Get https://login.tailscale.com: no such host",
  ])("keeps control-stage failures directed at control hosts: %s", (text) => {
    expect(diagnose(text, { BackendState: "Running", Self: { Relay: "nyc" } })).toMatchObject({
      code: "CONTROL_UNREACHABLE",
      next: expect.stringContaining("controlplane.tailscale.com"),
    });
  });
  it("classifies status health warnings without log output", () => {
    expect(
      diagnose("", {
        BackendState: "Running",
        Self: { Relay: "nyc" },
        Health: ["not connected to home DERP region 1"],
      }).code,
    ).toBe("DERP_UNREACHABLE");
    expect(
      diagnose("", {
        BackendState: "Running",
        Self: { Relay: "nyc" },
        Health: ["Tailscale could not connect to the 'New York City' relay server."],
      }).code,
    ).toBe("DERP_UNREACHABLE");
  });
  it("masks credentials even when reading a legacy log", async () => {
    const temp = await mkdtemp("/tmp/cts-diagnose-test-");
    try {
      const path = join(temp, "tailscaled.log");
      await writeFile(path, "tskey-auth-FAKE-legacy http://FAKE-user:FAKE-password@proxy.example");
      expect(await readLogTail(path)).toBe("[REDACTED] http://[REDACTED]@proxy.example");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
  it("reads only a bounded log tail and tolerates an absent log", async () => {
    const temp = await mkdtemp("/tmp/cts-diagnose-test-");
    try {
      const path = join(temp, "tailscaled.log");
      expect(await readLogTail(path)).toBe("");
      await writeFile(path, `${"x".repeat(100_000)}\nFAKE tail`);
      const tail = await readLogTail(path);
      expect(Buffer.byteLength(tail)).toBe(65_536);
      expect(tail.endsWith("FAKE tail")).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
  it("reads only bytes written since the current attempt started", async () => {
    const temp = await mkdtemp("/tmp/cts-diagnose-test-");
    try {
      const path = join(temp, "tailscaled.log");
      const previous = "control: auth key rejected €\n";
      await writeFile(path, previous);
      const offset = Buffer.byteLength(previous);
      expect(await readLogTail(path, offset)).toBe("");
      const current = "derp.Recv(derp-1): proxyconnect tcp: connection refused\n";
      await appendFile(path, current);
      expect(await readLogTail(path, offset)).toBe(current);
      expect(await readLogTail(path, offset + Buffer.byteLength(current) + 1)).toBe("");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
