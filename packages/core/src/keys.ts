import { bytesToHex, hexToBytes } from "./bytes.js";
import { subtle } from "./crypto.js";
import { EntzifferError } from "./errors.js";
import { b64urlDecode, b64urlEncode, FPR_BYTES } from "./format.js";

export const ALGORITHM = "X25519";
export const PUBLIC_KEY_PREFIX = "entz1pk_";
export const RAW_KEY_BYTES = 32;

const PKCS8_X25519_PREFIX = hexToBytes("302e020100300506032b656e04220420");

/**
 * Wraps a raw X25519 scalar in the RFC 8410 PKCS#8 document WebCrypto needs, since it has no
 * raw import for private keys (https://wicg.github.io/webcrypto-secure-curves/#x25519-operations).
 * The caller owns zeroizing both `seed` and the returned buffer.
 */
export function pkcs8FromSeed(seed: Uint8Array): Uint8Array {
  const out = new Uint8Array(PKCS8_X25519_PREFIX.length + seed.length);
  out.set(PKCS8_X25519_PREFIX, 0);
  out.set(seed, PKCS8_X25519_PREFIX.length);
  return out;
}

export interface EntzPublicKey {
  raw: Uint8Array;
  key: CryptoKey;
  fpr: Uint8Array;
}

export function generateKeyPair(opts?: { extractable?: boolean }): Promise<CryptoKeyPair> {
  return subtle().generateKey(ALGORITHM, opts?.extractable ?? false, [
    "deriveBits",
  ]) as Promise<CryptoKeyPair>;
}

export async function fingerprint(raw: Uint8Array): Promise<Uint8Array> {
  const digest = await subtle().digest("SHA-256", raw as BufferSource);
  return new Uint8Array(digest, 0, FPR_BYTES);
}

/** Renders a 4-byte fingerprint as `a1b2-c3d4`. */
export function formatFingerprint(fpr: Uint8Array): string {
  const hex = bytesToHex(fpr);
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

export async function importPublicKey(s: string): Promise<EntzPublicKey> {
  if (!s.startsWith(PUBLIC_KEY_PREFIX)) {
    throw new EntzifferError("BAD_KEY_STRING", `public key must start with ${PUBLIC_KEY_PREFIX}`);
  }
  let raw: Uint8Array;
  try {
    raw = b64urlDecode(s.slice(PUBLIC_KEY_PREFIX.length));
  } catch {
    throw new EntzifferError("BAD_KEY_STRING", "public key is not valid base64url");
  }
  if (raw.length !== RAW_KEY_BYTES) {
    throw new EntzifferError("BAD_KEY_STRING", `public key must be ${RAW_KEY_BYTES} bytes`);
  }
  return importRawPublicKey(raw);
}

export async function importRawPublicKey(raw: Uint8Array): Promise<EntzPublicKey> {
  let key: CryptoKey;
  try {
    key = await subtle().importKey("raw", raw as BufferSource, ALGORITHM, true, []);
  } catch {
    throw new EntzifferError("BAD_KEY_STRING", "public key is not a valid X25519 point");
  }
  return { raw, key, fpr: await fingerprint(raw) };
}

export async function exportPublicKey(k: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await subtle().exportKey("raw", k));
  return PUBLIC_KEY_PREFIX + b64urlEncode(raw);
}

/** Recovers the matching public key by agreeing `priv` against the Curve25519 base point. */
export async function derivePublicKeyRaw(priv: CryptoKey): Promise<Uint8Array> {
  const basePoint = new Uint8Array(RAW_KEY_BYTES);
  basePoint[0] = 9;
  const base = await subtle().importKey("raw", basePoint as BufferSource, ALGORITHM, true, []);
  return new Uint8Array(await subtle().deriveBits({ name: ALGORITHM, public: base }, priv, 256));
}
