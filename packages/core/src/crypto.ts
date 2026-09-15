import { EntzifferError } from "./errors.js";

/**
 * The single WebCrypto entry point for this package.
 * @throws EntzifferError `NO_KEY` where `crypto.subtle` is absent (an insecure context, or a
 * runtime older than the X25519 support this format requires).
 */
export function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (c?.subtle === undefined) throw new EntzifferError("NO_KEY", "WebCrypto is unavailable");
  return c.subtle;
}
