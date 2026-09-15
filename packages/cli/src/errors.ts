import { EntzifferError } from "@entziffer/core";

export const EXIT_OK = 0;
export const EXIT_GENERIC = 1;
export const EXIT_USAGE = 2;
export const EXIT_CONFIG = 3;
export const EXIT_UNKNOWN_RECIPIENT = 4;
export const EXIT_CRYPTO = 5;
export const EXIT_EMPTY_STDIN = 6;

export class CliError extends Error {
  readonly code: string;
  readonly exit: number;

  constructor(code: string, message: string, exit: number) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exit = exit;
  }
}

export function usageError(message: string): CliError {
  return new CliError("E_USAGE", message, EXIT_USAGE);
}

/** Runs `fn`, rewriting `parseArgs` rejections into a usage error. */
export function parsing<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw usageError(e instanceof Error ? e.message : String(e));
  }
}

export function toCliError(e: unknown): CliError {
  if (e instanceof CliError) return e;
  if (e instanceof EntzifferError) return new CliError(`E_${e.code}`, e.message, EXIT_CRYPTO);
  return new CliError("E_GENERIC", e instanceof Error ? e.message : String(e), EXIT_GENERIC);
}
