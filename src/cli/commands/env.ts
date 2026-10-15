import { CtError } from "../../core/errors.js";
import type { Result } from "../../core/output.js";
import { ensureConnected } from "../../tailscale/connect.js";

export async function envCommand(args: string[] = []): Promise<Result> {
  if (args.length) {
    throw new CtError(
      "INVALID_ARGUMENT",
      "env takes no arguments.",
      "Run cloud-tailscale env [--json].",
    );
  }
  const connection = await ensureConnected();
  const proxy = `socks5h://127.0.0.1:${connection.config.proxyPort}`;
  return {
    ok: true,
    message: [
      "# Scope these exports to tools reaching tailnet destinations (for example in a subshell).",
      "# HTTPS_PROXY/https_proxy and HTTP_PROXY/http_proxy stay unchanged for the environment's egress proxy.",
      "# Tools that prefer HTTPS_PROXY over ALL_PROXY can use the local HTTP listener explicitly per request.",
      `# Local HTTP proxy: http://127.0.0.1:${connection.config.proxyPort}`,
      `export ALL_PROXY='${proxy}'`,
      `export all_proxy='${proxy}'`,
    ].join("\n"),
    data: {
      ALL_PROXY: proxy,
      all_proxy: proxy,
      httpProxy: `http://127.0.0.1:${connection.config.proxyPort}`,
    },
  };
}
