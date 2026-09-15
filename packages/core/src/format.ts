import { EntzifferError } from "./errors.js";

export const VERSION = 0x01;

/** The one and only token prefix; see docs/format.md. */
export const MARKER = "ENTZ1:";

export const FPR_BYTES = 4;
export const EPH_PUB_BYTES = 32;
export const HEADER_BYTES = 1 + FPR_BYTES + EPH_PUB_BYTES;
export const GCM_TAG_BYTES = 16;
export const MIN_ENVELOPE_BYTES = HEADER_BYTES + GCM_TAG_BYTES;

const TOKEN_PATTERN = `${MARKER}[A-Za-z0-9_-]+`;

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const B64URL_VALUES = ((): Int8Array => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i++) {
    table[B64URL_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

export function b64urlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += B64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function b64urlDecode(s: string): Uint8Array {
  const n = s.length;
  if (n % 4 === 1) throw new EntzifferError("BAD_BASE64", "truncated base64url group");
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? (B64URL_VALUES[c] as number) : -1;
    if (v < 0) throw new EntzifferError("BAD_BASE64", `invalid base64url character at ${i}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) {
    throw new EntzifferError("BAD_BASE64", "non-zero padding bits");
  }
  return out.subarray(0, o);
}

export interface TokenMatch {
  start: number;
  end: number;
  token: string;
}

/**
 * Finds every ENTZ1 token in `text`. Each match's `token` includes the `ENTZ1:` marker, and its
 * base64url run stops at the first character outside `[A-Za-z0-9_-]`, so a token may sit
 * mid-sentence or be followed by punctuation.
 */
export function findTokens(text: string): TokenMatch[] {
  return Array.from(text.matchAll(new RegExp(TOKEN_PATTERN, "g")), (m) => ({
    start: m.index,
    end: m.index + m[0].length,
    token: m[0],
  }));
}

export interface Envelope {
  ver: number;
  fpr: Uint8Array;
  ephPub: Uint8Array;
  ct: Uint8Array;
}

/** The {@link HEADER_BYTES}-byte prefix that every ENTZ1 envelope authenticates as AES-GCM AAD. */
export function encodeHeader(env: Omit<Envelope, "ct">): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES);
  out[0] = env.ver;
  out.set(env.fpr, 1);
  out.set(env.ephPub, 1 + FPR_BYTES);
  return out;
}

export function encodeEnvelope(env: Envelope): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + env.ct.length);
  out.set(encodeHeader(env), 0);
  out.set(env.ct, HEADER_BYTES);
  return out;
}

export function encodeToken(env: Envelope): string {
  return MARKER + b64urlEncode(encodeEnvelope(env));
}

/** Parses a token without decrypting it; validates marker, length, and version only. */
export function parseEnvelope(token: string): Envelope {
  if (!token.startsWith(MARKER)) throw new EntzifferError("BAD_MARKER");
  const bytes = b64urlDecode(token.slice(MARKER.length));
  if (bytes.length < MIN_ENVELOPE_BYTES) {
    throw new EntzifferError("BAD_LENGTH", `envelope is ${bytes.length} bytes`);
  }
  const ver = bytes[0] as number;
  if (ver !== VERSION) {
    throw new EntzifferError("UNSUPPORTED_VERSION", `unsupported version 0x${ver.toString(16)}`);
  }
  return {
    ver,
    fpr: bytes.subarray(1, 1 + FPR_BYTES),
    ephPub: bytes.subarray(1 + FPR_BYTES, HEADER_BYTES),
    ct: bytes.subarray(HEADER_BYTES),
  };
}
