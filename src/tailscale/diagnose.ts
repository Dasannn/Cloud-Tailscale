import { open } from "node:fs/promises";
import { CtError } from "../core/errors.js";
import { mask } from "../core/output.js";
import type { TailscaleStatus } from "./client.js";

export async function readLogTail(path: string, startOffset = 0): Promise<string> {
  try {
    const file = await open(path, "r");
    try {
      const { size } = await file.stat();
      const buffer = Buffer.alloc(Math.max(0, Math.min(size - startOffset, 65_536)));
      const { bytesRead } = await file.read(
        buffer,
        0,
        buffer.length,
        Math.max(startOffset, size - buffer.length),
      );
      return mask(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await file.close();
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw cause;
  }
}

export function hasDerpWarning(status: TailscaleStatus): boolean {
  return status.Health?.some((warning) => /\b(?:derp|relay)\b/i.test(warning)) ?? false;
}

/** Return actionable errors without copying subprocess output or login URLs into logs. */
export function diagnose(text: string, status?: TailscaleStatus): CtError {
  if (
    /(?:invalid|expired|revoked|rejected|not valid)[^\n]*(?:auth.?key|key)|(?:auth.?key)[^\n]*(?:invalid|expired|revoked|rejected|not found)|To authenticate, visit:|Logged out\./i.test(
      text,
    )
  ) {
    return new CtError(
      "AUTH_KEY_REJECTED",
      "Tailscale rejected the auth key or requested an interactive login.",
      "Create a reusable, ephemeral, pre-approved, tagged auth key in the Tailscale admin console and replace TS_AUTHKEY (or TAILSCALE_AUTHKEY) in the environment's secrets. Allow login.tailscale.com and controlplane.tailscale.com.",
    );
  }
  if (status?.BackendState === "NeedsMachineAuth") {
    return new CtError(
      "AUTH_KEY_REJECTED",
      "The Tailscale node is waiting for device approval.",
      "Approve the device in the Tailscale admin console or use a pre-approved, ephemeral, tagged auth key from the environment's secrets.",
    );
  }
  // Match stage/destination within each line before a generic proxy/TLS error.
  // A DERP CONNECT failure says nothing about reachability of the control hosts.
  const failures = text
    .split(/\r?\n/)
    .filter((line) =>
      /failed|failure|timeout|timed out|deadline exceeded|refused|unreachable|error|denied|x509|unknown authority|bad certificate|does not look like a TLS handshake|server gave HTTP response to HTTPS client|no such host|\bEOF\b|not connected|could not connect|unable to connect/i.test(
        line,
      ),
    );
  if (
    (status && hasDerpWarning(status)) ||
    failures.some((line) => /\bderp(?:\b|http|\w*\.tailscale\.com)|\brelay\b/i.test(line))
  ) {
    return derpError();
  }
  if (
    failures.some((line) =>
      /\b(?:control|login|register|coord)\b|(?:controlplane|login|log)\.tailscale\.com/i.test(line),
    )
  ) {
    return controlError();
  }
  if (status?.BackendState === "Running" && !status.Self?.Relay) {
    return derpError();
  }
  if (
    /(?:control|login|register|coord|proxy|x509|certificate)[^\n]*(?:timeout|timed out|failed|refused|unreachable|error|denied|unknown authority)|(?:failed|error)[^\n]*(?:controlplane|login\.tailscale)|proxyconnect tcp|no such host/i.test(
      text,
    )
  ) {
    return controlError();
  }
  if (status?.BackendState === "Running" && status.Self?.Relay) {
    if (status.Self.Online !== false) return derpError();
    return new CtError(
      "CONTROL_UNREACHABLE",
      "Tailscale has a DERP region but has not confirmed its control connection.",
      "Allow controlplane.tailscale.com and login.tailscale.com through HTTPS_PROXY and retry up.",
    );
  }
  return new CtError(
    "CONTROL_UNREACHABLE",
    "Tailscale did not finish joining the tailnet before the connection timeout.",
    "Check the auth key, proxy and CA bundle, and allow HTTPS/POST to controlplane.tailscale.com, login.tailscale.com, log.tailscale.com and *.tailscale.com DERP hosts, then retry up.",
  );
}

function controlError(): CtError {
  return new CtError(
    "CONTROL_UNREACHABLE",
    "Tailscale could not reach its control plane through the environment's proxy.",
    "Allow HTTPS and POST to controlplane.tailscale.com, login.tailscale.com and log.tailscale.com in the network policy. Check HTTPS_PROXY and SSL_CERT_FILE (or NODE_EXTRA_CA_CERTS) for the proxy CA bundle.",
  );
}

function derpError(): CtError {
  return new CtError(
    "DERP_UNREACHABLE",
    "Tailscale could not establish a home DERP relay connection.",
    "Allow HTTPS to *.tailscale.com DERP hosts through the egress proxy and check its CA bundle. Direct UDP may be blocked in cloud containers; DERP must be reachable.",
  );
}
