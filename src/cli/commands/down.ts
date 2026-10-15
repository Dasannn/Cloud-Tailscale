import { CtError } from "../../core/errors.js";
import type { Result } from "../../core/output.js";
import { ensurePaths } from "../../core/paths.js";
import { TailscaleClient } from "../../tailscale/client.js";
import { isRunning, stop } from "../../tailscale/daemon.js";
import { findInstalled } from "../../tailscale/install.js";

export async function downCommand(args: string[] = []): Promise<Result> {
  if (args.length) {
    throw new CtError(
      "INVALID_ARGUMENT",
      "down takes no arguments.",
      "Run cloud-tailscale down [--json].",
    );
  }
  const paths = await ensurePaths();
  const running = await isRunning(paths);
  try {
    if (running) {
      const installation = await findInstalled(paths);
      if (!installation) {
        throw new CtError(
          "DAEMON_UNAVAILABLE",
          "The private daemon is running but its Tailscale client is missing; logout could not be confirmed.",
          "Restore the official client with cloud-tailscale up and retry down.",
        );
      }
      await new TailscaleClient(installation, paths).logout();
    }
  } finally {
    await stop(paths);
  }
  return {
    ok: true,
    message: running
      ? "Logged out of the tailnet and stopped the private Tailscale daemon."
      : "The private Tailscale daemon is already stopped.",
    data: { daemonRunning: false, loggedOut: true },
  };
}
