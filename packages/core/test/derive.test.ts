import { describe, expect, it } from "vitest";
import {
  DERIVATION_VERSION,
  deriveKeyFromPrf,
  exportPublicKey,
  FIXED_PRF_SALT,
  formatFingerprint,
} from "../src/index.js";
import { bytesToHex, hexToBytes } from "../src/testing.js";
import vectors from "./vectors.json" with { type: "json" };

const prf = hexToBytes(vectors.derivation.prfHex);

describe("deriveKeyFromPrf", () => {
  it("reproduces the published derivation vector", async () => {
    const { privateKey, publicRaw, fpr } = await deriveKeyFromPrf(prf);
    expect(bytesToHex(publicRaw)).toBe(vectors.derivation.publicKeyHex);
    expect(
      await exportPublicKey(
        await crypto.subtle.importKey("raw", publicRaw as BufferSource, "X25519", true, []),
      ),
    ).toBe(vectors.derivation.publicKey);
    expect(formatFingerprint(fpr)).toBe(vectors.derivation.fingerprint);
    expect(privateKey.extractable).toBe(false);
    expect(privateKey.usages).toEqual(["deriveBits"]);
  });

  it("is deterministic and distinct per PRF output", async () => {
    const again = await deriveKeyFromPrf(prf);
    expect(bytesToHex(again.publicRaw)).toBe(vectors.derivation.publicKeyHex);
    const other = await deriveKeyFromPrf(new Uint8Array(32).fill(1));
    expect(bytesToHex(other.publicRaw)).not.toBe(vectors.derivation.publicKeyHex);
  });

  it.each([0, 1, 16, 31, 33, 64])(
    "rejects a %i-byte PRF output: only exactly 32 bytes derive a key",
    async (length) => {
      await expect(deriveKeyFromPrf(new Uint8Array(length))).rejects.toMatchObject({
        code: "PRF_UNSUPPORTED",
      });
    },
  );

  it("pins the derivation version stored with every enrolled credential", () => {
    expect(DERIVATION_VERSION).toBe(1);
  });

  it("pins the fixed PRF salt", () => {
    expect(bytesToHex(FIXED_PRF_SALT)).toBe(vectors.derivation.prfSaltHex);
  });
});
