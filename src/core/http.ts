import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import {
  EnvHttpProxyAgent,
  type ProxyAgent,
  type RequestInit,
  type Response,
  fetch as undiciFetch,
} from "undici";
import { CtError } from "./errors.js";

let agentPromise: Promise<EnvHttpProxyAgent> | undefined;

async function createAgent(): Promise<EnvHttpProxyAgent> {
  const bundles: string[] = [];
  const paths = new Set([process.env.NODE_EXTRA_CA_CERTS, process.env.SSL_CERT_FILE]);
  for (const path of paths) {
    if (!path) continue;
    try {
      bundles.push(await readFile(path, "utf8"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  // Explicit ca replaces Node's trust store; retain the public roots as well.
  const tls = bundles.length ? { ca: [...rootCertificates, ...bundles] } : undefined;
  // Undici 6 forwards these ProxyAgent options but omits them from the Env agent's types.
  const options: EnvHttpProxyAgent.Options & Pick<ProxyAgent.Options, "requestTls" | "proxyTls"> = {
    connect: tls,
    requestTls: tls,
    proxyTls: tls,
  };
  // Filter at emission: a warning listener runs after Node has already printed it.
  // The constructor emits synchronously, so restore the original before yielding.
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...args: unknown[]) => {
    const options = args[0];
    const code =
      warning instanceof Error && "code" in warning
        ? warning.code
        : typeof options === "object" && options !== null && "code" in options
          ? options.code
          : args[1];
    if (code !== "UNDICI-EHPA") Reflect.apply(emitWarning, process, [warning, ...args]);
  };
  try {
    return new EnvHttpProxyAgent(options);
  } finally {
    process.emitWarning = emitWarning;
  }
}

/** Proxy configuration is read from the environment by EnvHttpProxyAgent. */
export async function fetch(
  url: string | URL,
  options: Omit<RequestInit, "dispatcher"> = {},
): Promise<Response> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new CtError(
      "INVALID_ARGUMENT",
      "Invalid download URL.",
      "Use an absolute HTTP or HTTPS URL.",
    );
  }
  try {
    agentPromise ??= createAgent();
    const dispatcher = await agentPromise;
    return await undiciFetch(target, { ...options, dispatcher });
  } catch (cause) {
    throw new CtError(
      "DOWNLOAD_FAILED",
      `Could not download from ${target.hostname}.`,
      `Allow ${target.hostname} in the environment's network policy and check its proxy and CA bundle settings.`,
      { cause },
    );
  }
}

/** Call after consuming response bodies to release the connection pools. */
export async function closeHttp(): Promise<void> {
  const pending = agentPromise;
  agentPromise = undefined;
  if (pending) await (await pending).close();
}
