import { describe, expect, it } from "vitest";
import {
  b64urlDecode,
  b64urlEncode,
  decrypt,
  type EntzifferErrorCode,
  importPublicKey,
  MARKER,
} from "../src/index.js";
import { hexToBytes, importRawPrivateKey } from "../src/testing.js";
import vectors from "./vectors.json" with { type: "json" };

const recipient = await importPublicKey(vectors.recipient.publicKey);
const priv = await importRawPrivateKey(hexToBytes(vectors.recipient.privateKeyHex));
const token = vectors.vectors[0]?.token ?? "";

function mutate(t: string, index: number, xor = 0x01): string {
  const bytes = b64urlDecode(t.slice(MARKER.length));
  bytes[index] = (bytes[index] as number) ^ xor;
  return MARKER + b64urlEncode(bytes);
}

async function codeOf(t: string): Promise<EntzifferErrorCode | undefined> {
  try {
    await decrypt(t, priv, recipient.fpr);
    return undefined;
  } catch (e) {
    return (e as { code: EntzifferErrorCode }).code;
  }
}

describe("tamper detection", () => {
  it("baseline decrypts", async () => {
    expect(await codeOf(token)).toBeUndefined();
  });

  it("flipped ciphertext byte → DECRYPT_FAILED", async () => {
    expect(await codeOf(mutate(token, 40))).toBe("DECRYPT_FAILED");
  });

  it("flipped tag byte → DECRYPT_FAILED", async () => {
    const bytes = b64urlDecode(token.slice(MARKER.length));
    expect(await codeOf(mutate(token, bytes.length - 1))).toBe("DECRYPT_FAILED");
  });

  it("flipped ephemeral public key byte → DECRYPT_FAILED", async () => {
    expect(await codeOf(mutate(token, 10))).toBe("DECRYPT_FAILED");
  });

  it("flipped fingerprint byte → FPR_MISMATCH", async () => {
    expect(await codeOf(mutate(token, 2))).toBe("FPR_MISMATCH");
  });

  it("version 0x02 → UNSUPPORTED_VERSION", async () => {
    expect(await codeOf(mutate(token, 0, 0x03))).toBe("UNSUPPORTED_VERSION");
  });

  it("truncated envelope → BAD_LENGTH", async () => {
    const bytes = b64urlDecode(token.slice(MARKER.length)).subarray(0, 36);
    expect(await codeOf(MARKER + b64urlEncode(bytes))).toBe("BAD_LENGTH");
  });

  it("empty body → BAD_LENGTH", async () => {
    expect(await codeOf(MARKER)).toBe("BAD_LENGTH");
  });

  it("bad marker → BAD_MARKER", async () => {
    expect(await codeOf(`ENTZ2:${token.slice(MARKER.length)}`)).toBe("BAD_MARKER");
    expect(await codeOf(`hs.${token}`)).toBe("BAD_MARKER");
  });

  it("non-base64url characters → BAD_BASE64", async () => {
    expect(await codeOf("ENTZ1:abc$def")).toBe("BAD_BASE64");
    expect(await codeOf("ENTZ1:AA=")).toBe("BAD_BASE64");
  });

  it("truncated base64url group → BAD_BASE64", async () => {
    expect(await codeOf(`${token}A`.slice(0, token.length + 1))).toBeDefined();
    expect(await codeOf("ENTZ1:A")).toBe("BAD_BASE64");
  });

  it("low-order ephemeral point → DECRYPT_FAILED", async () => {
    const bytes = b64urlDecode(token.slice(MARKER.length));
    for (const lowOrder of [new Uint8Array(32), Uint8Array.from([1, ...new Array(31).fill(0)])]) {
      bytes.set(lowOrder, 5);
      expect(await codeOf(MARKER + b64urlEncode(bytes))).toBe("DECRYPT_FAILED");
    }
  });

  it("non-zero base64url padding bits → BAD_BASE64", () => {
    expect(() => b64urlDecode("AB")).toThrowError(/padding/);
  });
});
