import { describe, expect, it } from "vitest";
import { CtError, ERROR_CODES } from "../../../src/core/errors.js";

describe("CtError", () => {
  it("preserves the stable code, message, next step, and cause", () => {
    const cause = new Error("fake underlying failure");
    const error = new CtError("DOWNLOAD_FAILED", "Download failed.", "Check network access.", {
      cause,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CtError");
    expect(error.code).toBe("DOWNLOAD_FAILED");
    expect(error.message).toBe("Download failed.");
    expect(error.next).toBe("Check network access.");
    expect(error.cause).toBe(cause);
    expect(error.stack).toContain("CtError: Download failed.");
  });

  it("has unique codes for the documented connection and SSH failures", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(ERROR_CODES).toEqual(
      expect.arrayContaining([
        "AUTH_KEY_MISSING",
        "AUTH_KEY_REJECTED",
        "CONTROL_UNREACHABLE",
        "DERP_UNREACHABLE",
        "DOWNLOAD_FAILED",
        "CHECKSUM_MISMATCH",
        "KERNEL_MODE_UNAVAILABLE",
        "SSH_AUTH_FAILED",
        "HOST_KEY_CHANGED",
        "NOT_IMPLEMENTED",
      ]),
    );
  });
});
