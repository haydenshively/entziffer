/** ENTZ1 sealing and opening; docs/format.md is normative for every layout and constant here. */
import { subtle } from "./crypto.js";
import { EntzifferError, type EntzifferErrorCode } from "./errors.js";
import { type Envelope, encodeHeader, encodeToken, parseEnvelope, VERSION } from "./format.js";
import { ALGORITHM, type EntzPublicKey, generateKeyPair } from "./keys.js";

const INFO_PREFIX = new TextEncoder().encode("entziffer-v1");
const OKM_BYTES = 44;
const AES_KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface DecryptSuccess {
  ok: true;
  text: string;
}

export interface DecryptFailure {
  ok: false;
  code: EntzifferErrorCode;
}

export type DecryptResult = DecryptSuccess | DecryptFailure;

async function deriveAesKeyAndNonce(
  ephPriv: CryptoKey,
  peerPub: CryptoKey,
  ephPub: Uint8Array,
  fpr: Uint8Array,
): Promise<{ key: CryptoKey; nonce: Uint8Array }> {
  const shared = await subtle().deriveBits({ name: ALGORITHM, public: peerPub }, ephPriv, 256);
  const ikm = await subtle().importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const info = new Uint8Array(INFO_PREFIX.length + fpr.length);
  info.set(INFO_PREFIX, 0);
  info.set(fpr, INFO_PREFIX.length);
  const okm = new Uint8Array(
    await subtle().deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: ephPub as BufferSource, info: info as BufferSource },
      ikm,
      OKM_BYTES * 8,
    ),
  );
  const key = await subtle().importKey(
    "raw",
    okm.subarray(0, AES_KEY_BYTES) as BufferSource,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  return { key, nonce: okm.subarray(AES_KEY_BYTES, AES_KEY_BYTES + NONCE_BYTES) };
}

export async function encryptWithEphemeralKey(
  plaintext: string,
  to: EntzPublicKey,
  ephPair: CryptoKeyPair,
): Promise<string> {
  const ephPub = new Uint8Array(await subtle().exportKey("raw", ephPair.publicKey));
  const { key, nonce } = await deriveAesKeyAndNonce(ephPair.privateKey, to.key, ephPub, to.fpr);
  const header = encodeHeader({ ver: VERSION, fpr: to.fpr, ephPub });
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: header as BufferSource },
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );
  return encodeToken({ ver: VERSION, fpr: to.fpr, ephPub, ct });
}

export async function encrypt(plaintext: string, to: EntzPublicKey): Promise<string> {
  return encryptWithEphemeralKey(plaintext, to, await generateKeyPair({ extractable: true }));
}

/**
 * Decrypts one token. Throws {@link EntzifferError} with `FPR_MISMATCH` before doing any
 * key agreement when the envelope names a different recipient, so callers can cheaply
 * distinguish "not for me" from "tampered".
 */
export async function decrypt(token: string, priv: CryptoKey, ownFpr: Uint8Array): Promise<string> {
  const env: Envelope = parseEnvelope(token);
  if (!equalBytes(env.fpr, ownFpr)) {
    throw new EntzifferError("FPR_MISMATCH", "token is encrypted for a different key");
  }
  let pt: ArrayBuffer;
  try {
    const peer = await subtle().importKey("raw", env.ephPub as BufferSource, ALGORITHM, false, []);
    const { key, nonce } = await deriveAesKeyAndNonce(priv, peer, env.ephPub, env.fpr);
    pt = await subtle().decrypt(
      {
        name: "AES-GCM",
        iv: nonce as BufferSource,
        additionalData: encodeHeader(env) as BufferSource,
      },
      key,
      env.ct as BufferSource,
    );
  } catch (e) {
    if (e instanceof EntzifferError) throw e;
    throw new EntzifferError("DECRYPT_FAILED", "authentication failed");
  }
  return new TextDecoder().decode(pt);
}

/** Never throws; every input yields one result in the same order. */
export async function decryptMany(
  tokens: string[],
  priv: CryptoKey,
  ownFpr: Uint8Array,
): Promise<DecryptResult[]> {
  return Promise.all(
    tokens.map(async (t): Promise<DecryptResult> => {
      try {
        return { ok: true, text: await decrypt(t, priv, ownFpr) };
      } catch (e) {
        return { ok: false, code: e instanceof EntzifferError ? e.code : "DECRYPT_FAILED" };
      }
    }),
  );
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
