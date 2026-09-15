import { describe, expect, it } from "vitest";
import { decrypt, formatFingerprint, importPublicKey } from "../src/index.js";
import {
  bytesToHex,
  encryptWithEphemeral,
  hexToBytes,
  importRawPrivateKey,
} from "../src/testing.js";
import vectors from "./vectors.json" with { type: "json" };

const recipient = await importPublicKey(vectors.recipient.publicKey);
const priv = await importRawPrivateKey(hexToBytes(vectors.recipient.privateKeyHex));

describe("known-answer vectors", () => {
  it("recipient fingerprint matches", () => {
    expect(bytesToHex(recipient.fpr)).toBe(vectors.recipient.fingerprintHex);
    expect(formatFingerprint(recipient.fpr)).toBe(vectors.recipient.fingerprint);
  });

  it.each(vectors.vectors.map((v) => [v.name, v] as const))(
    "%s reproduces the token",
    async (_n, v) => {
      expect(
        await encryptWithEphemeral(v.plaintext, recipient, hexToBytes(v.ephemeralPrivateKeyHex)),
      ).toBe(v.token);
    },
  );

  it.each(vectors.vectors.map((v) => [v.name, v] as const))("%s decrypts", async (_n, v) => {
    expect(await decrypt(v.token, priv, recipient.fpr)).toBe(v.plaintext);
  });

  it("60-char title yields a 157-char token", () => {
    const v = vectors.vectors.find((x) => x.name === "title-60");
    expect(v?.plaintext.length).toBe(60);
    expect(v?.token.length).toBe(157);
  });

  it("a foreign token is rejected with FPR_MISMATCH", async () => {
    await expect(decrypt(vectors.foreign.token, priv, recipient.fpr)).rejects.toMatchObject({
      code: "FPR_MISMATCH",
    });
  });
});
