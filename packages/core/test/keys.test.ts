import { describe, expect, it } from "vitest";
import {
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  PUBLIC_KEY_PREFIX,
} from "../src/index.js";

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
