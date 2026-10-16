import { open } from "node:fs/promises";
import { CtError } from "../core/errors.js";
import { mask } from "../core/output.js";
import type { TailscaleStatus } from "./client.js";

const derpDestination = /\bderp(?:\b|http|\w*\.tailscale\.com)|\brelay\b/i;
const controlDestination =
  /\b(?:control|login|register|coord)\b|(?:controlplane|login|log)\.tailscale\.com/i;

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
  // Transport rejections can trigger logged-out status or interactive login before
  // the key is evaluated. Match the destination on the same line as the rejection.
  const lines = text.split(/\r?\n/);
  const transportFailures = lines.filter(
    (line) =>
      /unexpected HTTP response:\s*[45]\d{2}\b|all connection attempts failed|proxyconnect tcp/i.test(
        line,
      ) ||
      ((/\bCONNECT\b/.test(line) || /\bproxy\s+connect\b/i.test(line)) &&
        /failed|failure|refused|denied|rejected|error|forbidden|\s[45]\d{2}\b/i.test(line)),
  );
  const derpTransportFailures = transportFailures.filter((line) => derpDestination.test(line));
  if (derpTransportFailures.length) {
    return derpError(proxyRejectionStatus(derpTransportFailures));
  }
  const controlTransportFailures = transportFailures.filter((line) =>
    controlDestination.test(line),
  );
  if (controlTransportFailures.length) {
    return controlError(proxyRejectionStatus(controlTransportFailures));
  }
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
  const failures = lines.filter((line) =>
    /failed|failure|timeout|timed out|deadline exceeded|refused|unreachable|error|denied|x509|unknown authority|bad certificate|does not look like a TLS handshake|server gave HTTP response to HTTPS client|no such host|\bEOF\b|not connected|could not connect|unable to connect/i.test(
      line,
    ),
  );
  if ((status && hasDerpWarning(status)) || failures.some((line) => derpDestination.test(line))) {
    return derpError();
  }
  if (failures.some((line) => controlDestination.test(line))) {
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

function proxyRejectionStatus(lines: string[]): string | undefined {
  for (const line of lines) {
    const code =
      /(?:unexpected HTTP response:\s*|(?:proxyconnect tcp:|\bCONNECT\b).*?\s)(403|405|407)\b/i.exec(
        line,
      )?.[1];
    if (code) return code;
  }
  return undefined;
}

function controlError(httpStatus?: string): CtError {
  if (httpStatus) {
    return new CtError(
      "CONTROL_UNREACHABLE",
      `The egress proxy refused Tailscale's control connection (HTTP ${httpStatus}) after CONNECT.`,
      "The environment's network policy must allow HTTPS to controlplane.tailscale.com including HTTP protocol upgrades: Tailscale's control protocol upgrades an HTTPS POST to /ts2021. Some providers' proxies block upgrades; see docs/guides/troubleshooting.md.",
    );
  }
  return new CtError(
    "CONTROL_UNREACHABLE",
    "Tailscale could not reach its control plane through the environment's proxy.",
    "Allow HTTPS and POST to controlplane.tailscale.com, login.tailscale.com and log.tailscale.com in the network policy. Check HTTPS_PROXY and SSL_CERT_FILE (or NODE_EXTRA_CA_CERTS) for the proxy CA bundle.",
  );
}

function derpError(httpStatus?: string): CtError {
  if (httpStatus) {
    return new CtError(
      "DERP_UNREACHABLE",
      `The egress proxy refused Tailscale's DERP relay connection (HTTP ${httpStatus}).`,
      "The environment's network policy must allow HTTPS to *.tailscale.com DERP hosts including HTTP protocol upgrades. Some providers' proxies block upgrades; see docs/guides/troubleshooting.md.",
    );
  }
  return new CtError(
    "DERP_UNREACHABLE",
    "Tailscale could not establish a home DERP relay connection.",
    "Allow HTTPS including HTTP protocol upgrades to *.tailscale.com DERP hosts through the egress proxy and check its CA bundle. Direct UDP may be blocked in cloud containers; DERP must be reachable.",
  );
}
