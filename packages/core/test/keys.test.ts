import { describe, expect, it } from "vitest";
import {
  exportPublicKey,
  fingerprintOfKeyString,
  generateKeyPair,
  importPublicKey,
  PUBLIC_KEY_PREFIX,
} from "../src/index.js";
import vectors from "./vectors.json" with { type: "json" };

describe("key strings", () => {
  it("exports and re-imports", async () => {
    const pair = await generateKeyPair({ extractable: true });
    const s = await exportPublicKey(pair.publicKey);
    expect(s.startsWith(PUBLIC_KEY_PREFIX)).toBe(true);
    expect(s.length).toBe(PUBLIC_KEY_PREFIX.length + 43);
    expect((await importPublicKey(s)).raw.length).toBe(32);
  });

  it("generated keys are non-extractable by default", async () => {
    const pair = await generateKeyPair();
    expect(pair.privateKey.extractable).toBe(false);
  });

  it.each([
    ["missing prefix", "AAAA"],
    ["bad base64", `${PUBLIC_KEY_PREFIX}!!!!`],
    ["wrong length", `${PUBLIC_KEY_PREFIX}AAAA`],
  ])("%s → BAD_KEY_STRING", async (_n, s) => {
    await expect(importPublicKey(s)).rejects.toMatchObject({ code: "BAD_KEY_STRING" });
  });
});

describe("fingerprintOfKeyString", () => {
  it("formats the fingerprint of a key it would import", async () => {
    expect(await fingerprintOfKeyString(vectors.recipient.publicKey)).toBe(
      vectors.recipient.fingerprint,
    );
    expect(await fingerprintOfKeyString(vectors.foreign.publicKey)).toBe(
      vectors.foreign.fingerprint,
    );
  });

  it.each([
    ["missing prefix", "AAAA"],
    ["bad base64", `${PUBLIC_KEY_PREFIX}!!!!`],
    ["wrong length", `${PUBLIC_KEY_PREFIX}AAAA`],
    ["empty", ""],
  ])("%s → null", async (_n, s) => {
    expect(await fingerprintOfKeyString(s)).toBeNull();
  });
});
