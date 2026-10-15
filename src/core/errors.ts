export const ERROR_CODES = [
  "AUTH_KEY_MISSING",
  "AUTH_KEY_REJECTED",
  "CONTROL_UNREACHABLE",
  "DERP_UNREACHABLE",
  "DOWNLOAD_FAILED",
  "CHECKSUM_MISMATCH",
  "KERNEL_MODE_UNAVAILABLE",
  "SSH_AUTH_FAILED",
  "HOST_KEY_CHANGED",
  "SSH_CONNECTION_FAILED",
  "SSH_KNOWN_HOSTS_FAILED",
  "SSH_CONFIG_FAILED",
  "HOME_UNAVAILABLE",
  "UNSUPPORTED_ARCH",
  "PROCESS_FAILED",
  "PROCESS_TIMEOUT",
  "INVALID_ARGUMENT",
  "SKILL_CONFLICT",
  "SKILL_INSTALL_FAILED",
  "GIT_ROOT_NOT_FOUND",
  "NOT_IMPLEMENTED",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class CtError extends Error {
  readonly code: ErrorCode;
  readonly next: string;

  constructor(code: ErrorCode, message: string, next: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CtError";
    this.code = code;
    this.next = next;
  }
}
