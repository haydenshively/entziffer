import { subtle } from "./crypto.js";
import { encryptWithEphemeralKey } from "./ecies.js";
import { EntzifferError } from "./errors.js";
import { ALGORITHM, derivePublicKeyRaw, type EntzPublicKey, RAW_KEY_BYTES } from "./keys.js";

export { derivePublicKeyRaw } from "./keys.js";

const PKCS8_X25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

export async function importRawPrivateKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== RAW_KEY_BYTES) {
    throw new EntzifferError("BAD_KEY_STRING", `private key must be ${RAW_KEY_BYTES} bytes`);
  }
  const pkcs8 = new Uint8Array(PKCS8_X25519_PREFIX.length + RAW_KEY_BYTES);
  pkcs8.set(PKCS8_X25519_PREFIX, 0);
  pkcs8.set(raw, PKCS8_X25519_PREFIX.length);
  return subtle().importKey("pkcs8", pkcs8 as BufferSource, ALGORITHM, true, ["deriveBits"]);
}

export async function exportRawPrivateKey(key: CryptoKey): Promise<Uint8Array> {
  const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", key));
  return pkcs8.subarray(pkcs8.length - RAW_KEY_BYTES);
}

export async function keyPairFromRawPrivateKey(raw: Uint8Array): Promise<CryptoKeyPair> {
  const privateKey = await importRawPrivateKey(raw);
  const pubRaw = await derivePublicKeyRaw(privateKey);
  const publicKey = await subtle().importKey("raw", pubRaw as BufferSource, ALGORITHM, true, []);
  return { privateKey, publicKey };
}

/** Deterministic {@link import("./ecies.js").encrypt} for known-answer vectors only. */
export async function encryptWithEphemeral(
  plaintext: string,
  to: EntzPublicKey,
  ephPriv: Uint8Array,
): Promise<string> {
  return encryptWithEphemeralKey(plaintext, to, await keyPairFromRawPrivateKey(ephPriv));
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
