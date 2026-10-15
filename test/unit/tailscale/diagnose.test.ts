import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose, readLogTail } from "../../../src/tailscale/diagnose.js";

const fixture = (name: string) =>
  readFile(new URL(`../../fixtures/tailscale/${name}`, import.meta.url), "utf8");

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
  ])("classifies DERP-stage proxy and TLS errors with an assigned relay: %s", (text) => {
    expect(diagnose(text).code).toBe("DERP_UNREACHABLE");
    expect(diagnose(text, { BackendState: "Running", Self: { Relay: "nyc" } })).toMatchObject({
      code: "DERP_UNREACHABLE",
      next: expect.stringContaining("*.tailscale.com DERP hosts"),
    });
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
