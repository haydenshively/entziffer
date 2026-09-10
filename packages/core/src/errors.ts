export type EntzifferErrorCode =
  | "BAD_MARKER"
  | "BAD_BASE64"
  | "BAD_LENGTH"
  | "UNSUPPORTED_VERSION"
  | "FPR_MISMATCH"
  | "KEY_MISMATCH"
  | "DECRYPT_FAILED"
  | "BAD_KEY_STRING"
  | "NO_KEY"
  | "LOCKED"
  | "PRF_UNSUPPORTED"
  | "PASSKEY_CANCELLED";

export class EntzifferError extends Error {
  readonly code: EntzifferErrorCode;

  constructor(code: EntzifferErrorCode, message?: string) {
    super(message ?? code);
    this.name = "EntzifferError";
    this.code = code;
  }
}
