import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decrypt,
  deriveKeyFromPrf,
  encrypt,
  exportPublicKey,
  importPublicKey,
} from "../packages/core/src/index.ts";
import { hexToBytes, importRawPrivateKey } from "../packages/core/src/testing.ts";
import vectors from "../packages/core/test/vectors.json" with { type: "json" };

const SCRIPT = fileURLToPath(new URL("./encrypt.mjs", import.meta.url));
const RECIPIENT_HEX = vectors.recipient.privateKeyHex;

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

function spawn(args: string[], stdin?: string): Ran {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", input: stdin });
  return { status: r.status ?? -1, stdout: r.stdout.trimEnd(), stderr: r.stderr };
}

function run(args: string[], stdin?: string): string {
  const r = spawn(args, stdin);
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
  return r.stdout;
}

const randomPlaintext = (): string =>
  `${crypto.randomUUID()} — ${"δ🔐".repeat(1 + Math.floor(Math.random() * 20))}\nline two`;

describe("reference/encrypt.mjs", () => {
  it("reproduces every published vector", () => {
    const r = spawn(["--vectors"]);
    expect(r.stderr).toContain(`${vectors.vectors.length}/${vectors.vectors.length} vectors match`);
    expect(r.status).toBe(0);
  });

  it("produces tokens that @entziffer/core can decrypt", async () => {
    const priv = await importRawPrivateKey(hexToBytes(RECIPIENT_HEX));
    const pub = await importPublicKey(vectors.recipient.publicKey);
    for (let i = 0; i < 5; i++) {
      const plaintext = randomPlaintext();
      const token = run(["--to", vectors.recipient.publicKey, "--stdin"], plaintext);
      expect(await decrypt(token, priv, pub.fpr)).toBe(plaintext);
    }
  });

  it("decrypts tokens produced by @entziffer/core", async () => {
    const pub = await importPublicKey(vectors.recipient.publicKey);
    for (let i = 0; i < 5; i++) {
      const plaintext = randomPlaintext();
      const token = await encrypt(plaintext, pub);
      expect(run(["--decrypt", "--key", RECIPIENT_HEX, token])).toBe(plaintext);
    }
  });

  it("derives the same key from a PRF output as @entziffer/core", async () => {
    const { publicRaw } = await deriveKeyFromPrf(hexToBytes(vectors.derivation.prfHex));
    const core = await exportPublicKey(
      await crypto.subtle.importKey("raw", publicRaw as BufferSource, "X25519", true, []),
    );
    expect(run(["--derive", vectors.derivation.prfHex]).split("\n")[0]).toBe(core);
    expect(core).toBe(vectors.derivation.publicKey);
  });

  it("drops one trailing newline from --stdin, like the CLI", async () => {
    const priv = await importRawPrivateKey(hexToBytes(RECIPIENT_HEX));
    const pub = await importPublicKey(vectors.recipient.publicKey);
    const token = run(["--to", vectors.recipient.publicKey, "--stdin"], "hello\n");
    expect(await decrypt(token, priv, pub.fpr)).toBe("hello");
  });

  it("rejects malformed base64url in tokens and key strings", () => {
    const bad = [
      ["--decrypt", "--key", RECIPIENT_HEX, "ENTZ1:abc$def"],
      ["--decrypt", "--key", RECIPIENT_HEX, `${vectors.vectors[0]?.token}=`],
      ["--decrypt", "--key", RECIPIENT_HEX, "ENTZ1:A"],
      ["--to", "entz1pk_zz!!", "x"],
      ["--to", `${vectors.recipient.publicKey}A`, "x"],
    ];
    for (const args of bad) expect(spawn(args).status).not.toBe(0);
  });

  it("refuses a token addressed to another key", () => {
    const r = spawn(["--decrypt", "--key", RECIPIENT_HEX, vectors.foreign.token]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FPR_MISMATCH");
  });
});
