import { subtle } from "./crypto.js";
import { EntzifferError } from "./errors.js";
import { ALGORITHM, derivePublicKeyRaw, fingerprint, RAW_KEY_BYTES } from "./keys.js";

/** SHA-256("entziffer-key-derivation-v1"); normative in docs/format.md. */
export const FIXED_PRF_SALT = hexToBytes(
  "ddc9491d8d923e1ae18435a24f310f134cea31361178f52d0de7829d1207e9e8",
);

/** HKDF `info` separating this use of a WebAuthn PRF output from any future one. */
export const DERIVE_INFO = "entziffer-x25519-v1";
export const PRF_OUTPUT_BYTES = 32;

/**
 * The scheme {@link deriveKeyFromPrf} implements. Stored alongside every enrolled credential so a
 * later scheme has to opt in explicitly instead of reinterpreting an existing passkey.
 */
export const DERIVATION_VERSION = 1;

/** RFC 8410 PKCS#8 prefix for an X25519 private key; the only variable part is the 32-byte seed. */
const PKCS8_X25519_PREFIX = hexToBytes("302e020100300506032b656e04220420");

export interface DerivedKey {
  /** Non-extractable, `deriveBits` only. */
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
  fpr: Uint8Array;
}

/**
 * The whole key hierarchy: the same PRF output always yields the same X25519 key, so a passkey
 * synced to another device regenerates the identical identity. Nothing here is stored or
 * recoverable without the passkey.
 * @throws EntzifferError `PRF_UNSUPPORTED` unless the authenticator returned exactly
 * {@link PRF_OUTPUT_BYTES} bytes.
 */
export async function deriveKeyFromPrf(prf: Uint8Array): Promise<DerivedKey> {
  if (prf.length !== PRF_OUTPUT_BYTES) {
    throw new EntzifferError(
      "PRF_UNSUPPORTED",
      `PRF output must be exactly ${PRF_OUTPUT_BYTES} bytes, got ${prf.length}`,
    );
  }
  const base = await subtle().importKey("raw", prf as BufferSource, "HKDF", false, ["deriveBits"]);
  const seed = new Uint8Array(
    await subtle().deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0) as BufferSource,
        info: new TextEncoder().encode(DERIVE_INFO) as BufferSource,
      },
      base,
      RAW_KEY_BYTES * 8,
    ),
  );
  // WebCrypto has no raw X25519 private-key import, so the seed is wrapped in PKCS#8 DER; the
  // 32 seed bytes are transiently in the heap either way (see docs/threat-model.md).
  const pkcs8 = new Uint8Array(PKCS8_X25519_PREFIX.length + seed.length);
  pkcs8.set(PKCS8_X25519_PREFIX, 0);
  pkcs8.set(seed, PKCS8_X25519_PREFIX.length);
  const privateKey = await subtle().importKey("pkcs8", pkcs8 as BufferSource, ALGORITHM, false, [
    "deriveBits",
  ]);
  seed.fill(0);
  pkcs8.fill(0);
  const publicRaw = await derivePublicKeyRaw(privateKey);
  return { privateKey, publicRaw, fpr: await fingerprint(publicRaw) };
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
}
