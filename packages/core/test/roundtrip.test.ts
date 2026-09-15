import { describe, expect, it } from "vitest";
import {
  decrypt,
  decryptMany,
  encrypt,
  exportPublicKey,
  fingerprint,
  formatFingerprint,
  generateKeyPair,
  importPublicKey,
  parseEnvelope,
} from "../src/index.js";
import { derivePublicKeyRaw } from "../src/testing.js";

async function self() {
  const pair = await generateKeyPair({ extractable: true });
  const pub = await importPublicKey(await exportPublicKey(pair.publicKey));
  return { priv: pair.privateKey, pub };
}

describe("round trip", () => {
  const cases: Array<[string, string]> = [
    ["ascii", "Fix the login redirect loop"],
    ["unicode", "Grüße, 世界 — déjà vu"],
    ["emoji", "🔐🚀🧑‍💻 ok"],
    ["empty", ""],
    ["4KB", "x".repeat(4096)],
    ["newlines", "a\nb\r\nc\n"],
  ];

  it.each(cases)("%s", async (_name, plaintext) => {
    const { priv, pub } = await self();
    const token = await encrypt(plaintext, pub);
    expect(await decrypt(token, priv, pub.fpr)).toBe(plaintext);
  });

  it("uses a fresh ephemeral key per call", async () => {
    const { pub } = await self();
    const a = parseEnvelope(await encrypt("hi", pub));
    const b = parseEnvelope(await encrypt("hi", pub));
    expect(a.ephPub).not.toEqual(b.ephPub);
  });

  it("decryptMany reports per-item results without throwing", async () => {
    const { priv, pub } = await self();
    const good = await encrypt("ok", pub);
    const results = await decryptMany([good, "nonsense", "ENTZ1:!!!"], priv, pub.fpr);
    expect(results[0]).toEqual({ ok: true, text: "ok" });
    expect(results[1]).toEqual({ ok: false, code: "BAD_MARKER" });
    expect(results[2]).toEqual({ ok: false, code: "BAD_BASE64" });
  });

  it("derives the public key from a generated private key", async () => {
    const pair = await generateKeyPair({ extractable: true });
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    expect(await derivePublicKeyRaw(pair.privateKey)).toEqual(raw);
  });

  it("formats fingerprints", async () => {
    const fpr = await fingerprint(new Uint8Array(32));
    expect(formatFingerprint(fpr)).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
  });
});
