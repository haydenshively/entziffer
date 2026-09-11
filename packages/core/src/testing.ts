import { subtle } from "./crypto.js";
import { encryptWithEphemeralKey } from "./ecies.js";
import { EntzifferError } from "./errors.js";
import {
  ALGORITHM,
  derivePublicKeyRaw,
  type EntzPublicKey,
  pkcs8FromSeed,
  RAW_KEY_BYTES,
} from "./keys.js";

export { bytesToHex, hexToBytes } from "./bytes.js";
export { derivePublicKeyRaw } from "./keys.js";

export async function importRawPrivateKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== RAW_KEY_BYTES) {
    throw new EntzifferError("BAD_KEY_STRING", `private key must be ${RAW_KEY_BYTES} bytes`);
  }
  return subtle().importKey("pkcs8", pkcs8FromSeed(raw) as BufferSource, ALGORITHM, true, [
    "deriveBits",
  ]);
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
