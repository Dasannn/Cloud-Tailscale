import { CtError } from "../../core/errors.js";
import type { Result } from "../../core/output.js";
import { installRepoSkill, installSkill, readSkill } from "../../core/skill.js";

export async function skillCommand(args: string[]): Promise<Result<unknown>> {
  if (args.length !== 1 || !["--print", "--install", "--repo"].includes(args[0])) {
    throw new CtError(
      "INVALID_ARGUMENT",
      "Choose exactly one skill action: --print, --install, or --repo.",
      "Run cloud-tailscale skill --print, skill --install (Claude Code), or skill --repo (Codex repository).",
    );
  }
  if (args[0] === "--print") {
    const content = await readSkill();
    return { ok: true, message: content, data: { content } };
  }
  const repository = args[0] === "--repo";
  const installation = await (repository ? installRepoSkill() : installSkill());
  return {
    ok: true,
    message: [
      `Cloud-Tailscale skill ${installation.action}: ${installation.path}.`,
      ...(repository
        ? [
            "Review and commit this single skill file to make it available in future Codex Cloud tasks.",
          ]
        : []),
    ].join("\n"),
    data: installation,
  };
}
