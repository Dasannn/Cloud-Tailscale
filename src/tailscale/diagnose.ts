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
  // An explicit auth-key rejection is stronger evidence than transport errors.
  // Bare keys can refer to the server's public key or a node key being renewed.
  if (
    /\binvalid key: unable to validate API key\b|\b(?:invalid|expired|revoked|rejected|not valid|not found)\b[^\n]*\bauth[ -]?key\b|\bauth[ -]?key\b[^\n]*\b(?:invalid|expired|revoked|rejected|not valid|not found)\b/i.test(
      text,
    )
  ) {
    return authKeyError();
  }
  // Transport rejections can trigger logged-out status or interactive login before
  // the key is evaluated. Match the destination on the same line as the rejection.
  const lines = text.split(/\r?\n/);
  const transportFailures = lines.filter(
    (line) =>
      /failed|failure|timeout|timed out|deadline exceeded|refused|unreachable|error|denied|x509|unknown authority|bad certificate|does not look like a TLS handshake|server gave HTTP response to HTTPS client|no such host|\bEOF\b|not connected|could not connect|unable to connect|(?:unexpected HTTP response:|fetch control key:)\s*[45]\d{2}\b|proxyconnect tcp/i.test(
        line,
      ) ||
      ((/\bCONNECT\b/.test(line) || /\bproxy\s+connect\b/i.test(line)) &&
        /failed|failure|refused|denied|rejected|error|forbidden|\s[45]\d{2}\b/i.test(line)),
  );
  const derpTransportFailures = transportFailures.filter((line) => derpDestination.test(line));
  if (derpTransportFailures.length) {
    return derpError(proxyRejection(derpTransportFailures));
  }
  const controlTransportFailures = transportFailures.filter((line) =>
    controlDestination.test(line),
  );
  if (controlTransportFailures.length) {
    return controlError(proxyRejection(controlTransportFailures));
  }
  if (status?.BackendState === "NeedsMachineAuth") {
    return new CtError(
      "AUTH_KEY_REJECTED",
      "The Tailscale node is waiting for device approval.",
      "Approve the device in the Tailscale admin console or use a pre-approved, ephemeral, tagged auth key from the environment's secrets.",
    );
  }
  // Startup login activity is routine; even prompts can be stale once Running.
  if (
    status?.BackendState === "NeedsLogin" ||
    (status?.BackendState !== "Running" && /To authenticate, visit:|Logged out\./i.test(text))
  ) {
    return authKeyError();
  }
  if (status && hasDerpWarning(status)) {
    return derpError();
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

function authKeyError(): CtError {
  return new CtError(
    "AUTH_KEY_REJECTED",
    "Tailscale rejected the auth key or requested an interactive login.",
    "Create a reusable, ephemeral, pre-approved, tagged auth key in the Tailscale admin console and replace TS_AUTHKEY (or TAILSCALE_AUTHKEY) in the environment's secrets. Allow login.tailscale.com and controlplane.tailscale.com.",
  );
}

type ProxyRejection = { stage: "connect" | "upgrade"; status: string };

function proxyRejection(lines: string[]): ProxyRejection | undefined {
  for (const line of lines) {
    // Read the first CONNECT status, including a successful 200, so a later
    // in-tunnel HTTP rejection on the same line is not blamed on CONNECT.
    const connectStatus =
      /(?:proxyconnect tcp:|\bCONNECT\b).*?\s(?:HTTP\/\d(?:\.\d)?\s+)?([1-5]\d{2})\b/i.exec(
        line,
      )?.[1];
    if (connectStatus && /^(403|405|407)$/.test(connectStatus)) {
      return { stage: "connect", status: connectStatus };
    }
    const upgradeStatus = /unexpected HTTP response:\s*(403|405|407)\b/i.exec(line)?.[1];
    if (upgradeStatus) return { stage: "upgrade", status: upgradeStatus };
  }
  return undefined;
}

function proxyConnectError(destination: "control" | "DERP relay", httpStatus: string): CtError {
  const code = destination === "control" ? "CONTROL_UNREACHABLE" : "DERP_UNREACHABLE";
  const hosts =
    destination === "control"
      ? "controlplane.tailscale.com, login.tailscale.com and log.tailscale.com"
      : "*.tailscale.com DERP hosts";
  if (httpStatus === "407") {
    return new CtError(
      code,
      `The egress proxy requires authentication for the CONNECT tunnel to Tailscale's ${destination} host (HTTP 407).`,
      "Check HTTPS_PROXY credentials and the proxy's authentication requirements, then retry up.",
    );
  }
  return new CtError(
    code,
    `The egress proxy refused the CONNECT tunnel to Tailscale's ${destination} host (HTTP ${httpStatus}).`,
    `Allow HTTPS CONNECT tunnels to ${hosts} in the environment's network policy.`,
  );
}

function controlError(rejection?: ProxyRejection): CtError {
  if (rejection?.stage === "connect") return proxyConnectError("control", rejection.status);
  if (rejection) {
    return new CtError(
      "CONTROL_UNREACHABLE",
      `The egress proxy refused Tailscale's control connection (HTTP ${rejection.status}) after CONNECT.`,
      "The environment's network policy must allow HTTPS to controlplane.tailscale.com including HTTP protocol upgrades: Tailscale's control protocol upgrades an HTTPS POST to /ts2021. Some providers' proxies block upgrades; see docs/guides/troubleshooting.md.",
    );
  }
  return new CtError(
    "CONTROL_UNREACHABLE",
    "Tailscale could not reach its control plane through the environment's proxy.",
    "Allow HTTPS and POST to controlplane.tailscale.com, login.tailscale.com and log.tailscale.com in the network policy. Check HTTPS_PROXY and SSL_CERT_FILE (or NODE_EXTRA_CA_CERTS) for the proxy CA bundle.",
  );
}

function derpError(rejection?: ProxyRejection): CtError {
  if (rejection?.stage === "connect") return proxyConnectError("DERP relay", rejection.status);
  if (rejection) {
    return new CtError(
      "DERP_UNREACHABLE",
      `The egress proxy refused Tailscale's DERP relay connection (HTTP ${rejection.status}).`,
      "The environment's network policy must allow HTTPS to *.tailscale.com DERP hosts including HTTP protocol upgrades. Some providers' proxies block upgrades; see docs/guides/troubleshooting.md.",
    );
  }
  return new CtError(
    "DERP_UNREACHABLE",
    "Tailscale could not establish a home DERP relay connection.",
    "Allow HTTPS including HTTP protocol upgrades to *.tailscale.com DERP hosts through the egress proxy and check its CA bundle. Direct UDP may be blocked in cloud containers; DERP must be reachable.",
  );
}
