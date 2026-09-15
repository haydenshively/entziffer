import {
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

interface Vector {
  name: string;
  plaintext: string;
  token: string;
}

interface Vectors {
  foreign: Vector & { fingerprint: string; name?: string };
  vectors: Vector[];
}

const vectors = JSON.parse(
  readFileSync(new URL("../../../core/test/vectors.json", import.meta.url), "utf8"),
) as Vectors;

export const foreign = vectors.foreign;

/** The PRF bytes the E2E hook feeds the service worker in place of a real ceremony. */
export const E2E_PRF_HEX = "aa".repeat(32);

const DER_SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const DER_PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");

const rawPublicKeyOf = (key: KeyObject): Buffer =>
  createPublicKey(key).export({ format: "der", type: "spki" }).subarray(DER_SPKI_X25519.length);

/** Mirrors `@entziffer/core`'s `deriveKeyFromPrf`, so the fixture is addressed to the seeded key. */
function deriveFromPrf(prfHex: string): { privateKey: KeyObject; rawPub: Buffer } {
  const seed = Buffer.from(
    hkdfSync("sha256", Buffer.from(prfHex, "hex"), Buffer.alloc(0), "entziffer-x25519-v1", 32),
  );
  const privateKey = createPrivateKey({
    key: Buffer.concat([DER_PKCS8_X25519, seed]),
    format: "der",
    type: "pkcs8",
  });
  return { privateKey, rawPub: rawPublicKeyOf(privateKey) };
}

const { rawPub } = deriveFromPrf(E2E_PRF_HEX);

export const recipient = {
  publicKey: `entz1pk_${rawPub.toString("base64url")}`,
  fingerprintHex: createHash("sha256").update(rawPub).digest().subarray(0, 4).toString("hex"),
};

function encrypt(plaintext: string): string {
  const ephPriv = generateKeyPairSync("x25519").privateKey;
  const ephPub = rawPublicKeyOf(ephPriv);
  const fpr = createHash("sha256").update(rawPub).digest().subarray(0, 4);
  const header = Buffer.concat([Buffer.of(0x01), fpr, ephPub]);
  const ikm = diffieHellman({
    privateKey: ephPriv,
    publicKey: createPublicKey({
      key: Buffer.concat([DER_SPKI_X25519, rawPub]),
      format: "der",
      type: "spki",
    }),
  });
  const okm = Buffer.from(
    hkdfSync("sha256", ikm, ephPub, Buffer.concat([Buffer.from("entziffer-v1"), fpr]), 44),
  );
  const cipher = createCipheriv("aes-256-gcm", okm.subarray(0, 32), okm.subarray(32, 44));
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return `ENTZ1:${Buffer.concat([header, body, cipher.getAuthTag()]).toString("base64url")}`;
}

const byName = new Map<string, Vector>([
  ...vectors.vectors.map((v): [string, Vector] => [v.name, { ...v, token: encrypt(v.plaintext) }]),
  ["foreign", { ...vectors.foreign, name: "foreign" }],
]);

function vector(name: string): Vector {
  const found = byName.get(name);
  if (found === undefined) throw new Error(`unknown vector ${name}`);
  return found;
}

export const token = (name: string): string => vector(name).token;
export const plaintext = (name: string): string => vector(name).plaintext;

const html = readFileSync(new URL("./fixture.html", import.meta.url), "utf8").replace(
  /__TOKEN_([a-z0-9-]+)__/g,
  (_, name: string) => token(name),
);

/** Same origin as the fixture: a cross-origin editor bundle would not share its document. */
const EDITOR_PATH = "/fixture-editor.js";

const editorBundle = (): Buffer =>
  readFileSync(new URL("../../dist-e2e/fixture-editor.js", import.meta.url));

export interface FixtureServer {
  url: string;
  close(): Promise<void>;
}

/** Content scripts are never injected into `file://` pages, so the fixture needs a real origin. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    if (req.url === EDITOR_PATH) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(editorBundle());
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
