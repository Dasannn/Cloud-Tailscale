import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CtError } from "../../../src/core/errors.js";
import {
  clearSecrets,
  mask,
  printError,
  printResult,
  registerSecret,
  render,
  renderError,
} from "../../../src/core/output.js";

beforeEach(() => clearSecrets());
afterEach(() => {
  clearSecrets();
  vi.restoreAllMocks();
});

describe("mask", () => {
  it("masks all registered occurrences literally, including regex characters and whitespace", () => {
    registerSecret("FAKE.$[password](+)");
    registerSecret(" fake spaced secret ");
    expect(mask("FAKE.$[password](+) twice FAKE.$[password](+) and fake spaced secret ")).toBe(
      "[REDACTED] twice [REDACTED] and[REDACTED]",
    );
  });

  it("masks the longest overlapping value and does not recursively mask the replacement", () => {
    registerSecret("FAKE");
    registerSecret("FAKE-long-password");
    registerSecret("REDACTED");
    expect(mask("FAKE-long-password FAKE")).toBe("[REDACTED] [REDACTED]");
  });

  it.each([
    {
      values: ["tskey-FAKE!password-suffix"],
      text: "tskey-FAKE!password-suffix",
    },
    {
      values: ["FAKE-prefix!tskey-auth"],
      text: "FAKE-prefix!tskey-auth-FAKE-suffix",
    },
    {
      values: ["FAKE-first!middle", "middle!last-FAKE"],
      text: "FAKE-first!middle!last-FAKE",
    },
    {
      values: ["FAKE!FAKE"],
      text: "FAKE!FAKE!FAKE",
    },
    {
      values: ["FAKE-----BEGIN PRIVATE KEY-----"],
      text: "FAKE-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----",
    },
    {
      values: ["-----END PRIVATE KEY-----!FAKE-suffix"],
      text: "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----!FAKE-suffix",
    },
  ])("redacts the full union of overlapping matches in $text", ({ values, text }) => {
    for (const value of values) registerSecret(value);
    expect(mask(`before ${text} after`)).toBe("before [REDACTED] after");
  });

  it("merges a generic token with a longer JSON-escaped registered secret", () => {
    const password = 'tskey-FAKE!"password-suffix"';
    registerSecret(password);
    expect(mask(`before ${JSON.stringify(password)} after`)).toBe('before "[REDACTED]" after');
  });

  it("ignores empty or absent values and releases registered secrets", () => {
    expect(registerSecret("")).toBeUndefined();
    expect(registerSecret(undefined)).toBeUndefined();
    expect(mask("ordinary text")).toBe("ordinary text");
    registerSecret("FAKE-password");
    clearSecrets();
    expect(mask("FAKE-password")).toBe("FAKE-password");
  });

  it.each(["x", "up", "ssh", '\n\t"', " ", ".", "\\"])(
    "masks literal secrets shorter than four characters: %j",
    (secret) => {
      expect(registerSecret(secret)).toBe(secret);
      expect(mask(`${secret}|${secret}`)).toBe("[REDACTED]|[REDACTED]");
      expect(mask(JSON.stringify(secret).slice(1, -1))).toBe("[REDACTED]");
    },
  );

  it("masks repeated literal secrets", () => {
    registerSecret("code");
    expect(mask("code and code")).toBe("[REDACTED] and [REDACTED]");
  });

  it("masks unregistered Tailscale tokens with punctuation and repeated tokens", () => {
    expect(mask('key=tskey-auth-FAKE_123, "tskey-api-FAKE".')).toBe(
      'key=[REDACTED], "[REDACTED]".',
    );
  });

  it("masks embedded auth tokens and JSON-escaped registered values", () => {
    const password = 'FAKE-"password"\\with\nnewlines';
    registerSecret(password);
    expect(mask(`prefix-tskey-auth-FAKE ${JSON.stringify(password)}`)).toBe(
      'prefix-[REDACTED] "[REDACTED]"',
    );
  });

  it.each([
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY",
  ])("masks a multiline %s block without hiding surrounding text", (label) => {
    expect(
      mask(`before\n-----BEGIN ${label}-----\nFAKE-KEY-DATA\n-----END ${label}-----\nafter`),
    ).toBe("before\n[REDACTED]\nafter");
  });

  it("masks truncated PEM blocks and multiple keys", () => {
    expect(mask("-----BEGIN PRIVATE KEY-----\nFAKE unfinished")).toBe("[REDACTED]");
    expect(
      mask(
        "-----BEGIN PRIVATE KEY-----FAKE-----END PRIVATE KEY----- -----BEGIN RSA PRIVATE KEY-----FAKE-----END RSA PRIVATE KEY-----",
      ),
    ).toBe("[REDACTED] [REDACTED]");
  });
});

describe("rendering", () => {
  it("preserves the result envelope when a secret matches a field name", () => {
    registerSecret("message");
    expect(JSON.parse(render({ ok: true, message: "message", data: {} }, true))).toEqual({
      ok: true,
      message: "[REDACTED]",
      data: {},
    });
  });
  it("prints only the masked message in text mode", () => {
    expect(render({ ok: true, message: "Connected tskey-auth-FAKE", data: { count: 1 } })).toBe(
      "Connected [REDACTED]\n",
    );
  });

  it("keeps JSON valid while masking string values and preserving object keys", () => {
    const password = 'FAKE-"password"\\with\nnewlines';
    registerSecret(password);
    const rendered = render(
      {
        ok: true,
        message: `secret ${password}`,
        data: {
          [password]: [
            password,
            null,
            true,
            7,
            { key: "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----" },
          ],
        },
      },
      true,
    );
    expect(JSON.parse(rendered)).toEqual({
      ok: true,
      message: "secret [REDACTED]",
      data: { [password]: ["[REDACTED]", null, true, 7, { key: "[REDACTED]" }] },
    });
  });

  it("preserves error data.code and data.next when secrets match those keys", () => {
    registerSecret("code");
    registerSecret("next");
    const error = new CtError("AUTH_KEY_REJECTED", "Rejected code.", "Replace code next.");

    expect(JSON.parse(renderError(error, true))).toEqual({
      ok: false,
      message: "Rejected [REDACTED].",
      data: { code: "AUTH_KEY_REJECTED", next: "Replace [REDACTED] [REDACTED]." },
    });
  });

  it("prints errors with a code and next step in text and JSON", () => {
    const error = new CtError(
      "AUTH_KEY_REJECTED",
      "Rejected tskey-auth-FAKE.",
      "Replace tskey-auth-FAKE.",
    );
    expect(renderError(error)).toBe(
      "AUTH_KEY_REJECTED: Rejected [REDACTED].\nNext: Replace [REDACTED].\n",
    );
    expect(JSON.parse(renderError(error, true))).toEqual({
      ok: false,
      message: "Rejected [REDACTED].",
      data: { code: "AUTH_KEY_REJECTED", next: "Replace [REDACTED]." },
    });
  });

  it("writes results to stdout and errors to stderr", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    printResult({ ok: true, message: "Ready.", data: {} });
    printError(new CtError("NOT_IMPLEMENTED", "Not ready.", "Try later."), true);
    expect(stdout).toHaveBeenCalledWith("Ready.\n");
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"ok":false'));
  });

  it.each([false, true])("writes masked unsuccessful results to stderr (json=%s)", (json) => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    registerSecret("FAKE-password");
    printResult(
      { ok: false, message: "Rejected FAKE-password.", data: { next: "Replace FAKE-password." } },
      json,
    );
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      json
        ? '{"ok":false,"message":"Rejected [REDACTED].","data":{"next":"Replace [REDACTED]."}}\n'
        : "Rejected [REDACTED].\n",
    );
  });
});
