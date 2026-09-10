#!/usr/bin/env node
//
// entziffer reference implementation of the ENTZ1 wire format.
//
// This file exists to be *audited*, not to be fast or clever. It depends on nothing but
// Node's standard library, so you can read it top to bottom, compare it against
// docs/format.md, and satisfy yourself that the ciphertext an agent pastes into Linear is
// exactly what it claims to be. It is byte-for-byte identical to `@entziffer/core`:
// `node encrypt.mjs --vectors` re-derives every published test vector.
//
// Byte layout (all lengths in bytes; see docs/format.md for the normative spec):
//
//   token    = "ENTZ1:" || base64url_unpadded(envelope)
//   envelope = ver(1) || fpr(4) || ephPub(32) || ciphertext(n) || gcmTag(16)
//   header   = ver(1) || fpr(4) || ephPub(32)      <- the first 37 bytes, used as GCM AAD
//
//   ver    0x01
//   fpr    SHA-256(recipient raw X25519 public key)[0..4]
//   ephPub raw X25519 public key of a fresh, single-use ephemeral key pair
//
//   ikm    = X25519(ephemeral private, recipient public)
//   okm    = HKDF-SHA256(ikm, salt = ephPub, info = "entziffer-v1" || fpr, len = 44)
//   aesKey = okm[0..32]   nonce = okm[32..44]
//
// Usage:
//   node encrypt.mjs --to entz1pk_... "text to encrypt"
//   node encrypt.mjs --to entz1pk_... --stdin < body.md
//   node encrypt.mjs --decrypt --key <32-byte-hex | private-key.pem> ENTZ1:...
//   node encrypt.mjs --derive <32-byte-hex WebAuthn PRF output>
//   node encrypt.mjs --vectors [path/to/vectors.json]
//
// Key derivation (see docs/format.md):
//
//   seed = HKDF-SHA256(ikm = prf, salt = "", info = "entziffer-x25519-v1", len = 32)
//   the recipient private key is that seed, imported as X25519
//
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";

const VERSION = 0x01;
const MARKER = "ENTZ1:";
const PUBLIC_KEY_PREFIX = "entz1pk_";
const INFO_PREFIX = Buffer.from("entziffer-v1", "utf8");
const HEADER_BYTES = 37;
const TAG_BYTES = 16;
const DEFAULT_VECTORS = new URL("../packages/core/test/vectors.json", import.meta.url);

// Node's KeyObject API refuses `format: "raw"` for X25519, so raw keys are turned into
// DER documents by prepending the fixed RFC 8410 prefixes. These bytes are constant for
// every X25519 key: an SPKI/PKCS#8 wrapper whose only variable part is the 32-byte key.
const DER_SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const DER_PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");

const b64url = (buf) => buf.toString("base64url");
const unb64url = (str) => Buffer.from(str, "base64url");

const rawToPublicKey = (raw) =>
  createPublicKey({ key: Buffer.concat([DER_SPKI_X25519, raw]), format: "der", type: "spki" });

const rawToPrivateKey = (raw) =>
  createPrivateKey({ key: Buffer.concat([DER_PKCS8_X25519, raw]), format: "der", type: "pkcs8" });

// The raw 32 bytes are the tail of the SPKI document.
const rawPublicKeyOf = (key) =>
  createPublicKey(key).export({ format: "der", type: "spki" }).subarray(DER_SPKI_X25519.length);

const DERIVE_INFO = Buffer.from("entziffer-x25519-v1", "utf8");

/** The passkey PRF output is the only input: the same passkey always yields the same key. */
function deriveFromPrf(prf) {
  const seed = Buffer.from(hkdfSync("sha256", prf, Buffer.alloc(0), DERIVE_INFO, 32));
  const privateKey = rawToPrivateKey(seed);
  return { privateKey, rawPub: rawPublicKeyOf(privateKey) };
}

const fingerprint = (rawPub) => createHash("sha256").update(rawPub).digest().subarray(0, 4);

const formatFingerprint = (fpr) =>
  `${fpr.toString("hex").slice(0, 4)}-${fpr.toString("hex").slice(4)}`;

function parsePublicKeyString(str) {
  if (!str.startsWith(PUBLIC_KEY_PREFIX)) die(`public key must start with ${PUBLIC_KEY_PREFIX}`);
  const raw = unb64url(str.slice(PUBLIC_KEY_PREFIX.length));
  if (raw.length !== 32) die("public key must decode to 32 bytes");
  return raw;
}

/** Both sides run this identically; only the private half of the pair differs. */
function deriveKeyAndNonce(privateKey, publicKey, ephPub, fpr) {
  const ikm = diffieHellman({ privateKey, publicKey });
  const info = Buffer.concat([INFO_PREFIX, fpr]);
  const okm = Buffer.from(hkdfSync("sha256", ikm, ephPub, info, 44));
  return { key: okm.subarray(0, 32), nonce: okm.subarray(32, 44) };
}

function encrypt(plaintext, recipientRawPub, { ephemeralRaw } = {}) {
  // A caller-supplied ephemeral key makes the output deterministic; that is only ever
  // done to reproduce test vectors. Real encryptions use a fresh random key pair.
  const ephPriv = ephemeralRaw
    ? rawToPrivateKey(ephemeralRaw)
    : generateKeyPairSync("x25519").privateKey;
  const ephPub = rawPublicKeyOf(ephPriv);
  const fpr = fingerprint(recipientRawPub);
  const header = Buffer.concat([Buffer.of(VERSION), fpr, ephPub]);
  const { key, nonce } = deriveKeyAndNonce(ephPriv, rawToPublicKey(recipientRawPub), ephPub, fpr);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return MARKER + b64url(Buffer.concat([header, body, cipher.getAuthTag()]));
}

function decrypt(token, privateKey) {
  if (!token.startsWith(MARKER)) die(`token does not start with ${MARKER}`);
  const env = unb64url(token.slice(MARKER.length));
  if (env.length < HEADER_BYTES + TAG_BYTES) die(`envelope is only ${env.length} bytes`);
  if (env[0] !== VERSION) die(`unsupported version 0x${env[0].toString(16)}`);
  const header = env.subarray(0, HEADER_BYTES);
  const fpr = env.subarray(1, 5);
  const ephPub = env.subarray(5, HEADER_BYTES);
  const rest = env.subarray(HEADER_BYTES);
  const own = fingerprint(rawPublicKeyOf(privateKey));
  // Checked before any key agreement: "not addressed to me" must be distinguishable from
  // "tampered with", and it is cheap.
  if (!own.equals(fpr)) {
    die(`FPR_MISMATCH: token is for ${formatFingerprint(fpr)}, key is ${formatFingerprint(own)}`);
  }
  const { key, nonce } = deriveKeyAndNonce(privateKey, rawToPublicKey(ephPub), ephPub, fpr);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(rest.subarray(rest.length - TAG_BYTES));
  const pt = rest.subarray(0, rest.length - TAG_BYTES);
  return Buffer.concat([decipher.update(pt), decipher.final()]).toString("utf8");
}

function loadPrivateKey(spec) {
  if (/^[0-9a-fA-F]{64}$/.test(spec)) return rawToPrivateKey(Buffer.from(spec, "hex"));
  return createPrivateKey(readFileSync(spec, "utf8"));
}

function verifyVectors(path) {
  const file = JSON.parse(readFileSync(path, "utf8"));
  const recipientPub = parsePublicKeyString(file.recipient.publicKey);
  const recipientPriv = rawToPrivateKey(Buffer.from(file.recipient.privateKeyHex, "hex"));
  let failed = 0;
  if (file.derivation) {
    const { rawPub } = deriveFromPrf(Buffer.from(file.derivation.prfHex, "hex"));
    const key = PUBLIC_KEY_PREFIX + b64url(rawPub);
    const ok = key === file.derivation.publicKey;
    if (!ok) failed++;
    process.stderr.write(`${ok ? "ok  " : "FAIL"} derivation (${key})\n`);
  }
  for (const v of file.vectors) {
    const ephemeralRaw = Buffer.from(v.ephemeralPrivateKeyHex, "hex");
    const token = encrypt(v.plaintext, recipientPub, { ephemeralRaw });
    const roundTrip = decrypt(token, recipientPriv);
    const ok = token === v.token && roundTrip === v.plaintext;
    if (!ok) {
      failed++;
      process.stderr.write(`FAIL ${v.name}\n  expected ${v.token}\n  actual   ${token}\n`);
    } else {
      process.stderr.write(`ok   ${v.name}\n`);
    }
  }
  process.stderr.write(`${file.vectors.length - failed}/${file.vectors.length} vectors match\n`);
  if (failed > 0) process.exit(1);
}

function die(message) {
  process.stderr.write(`entziffer-reference: ${message}\n`);
  process.exit(1);
}

const USAGE = `Usage:
  node encrypt.mjs --to entz1pk_... "text"        encrypt an argument
  node encrypt.mjs --to entz1pk_... --stdin       encrypt everything on stdin
  node encrypt.mjs --decrypt --key <hex|pem> TOKEN
  node encrypt.mjs --derive <prf-hex>              public key derived from a PRF output
  node encrypt.mjs --vectors [vectors.json]
`;

function main(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--to") opts.to = argv[++i];
    else if (arg === "--key") opts.key = argv[++i];
    else if (arg === "--stdin") opts.stdin = true;
    else if (arg === "--decrypt") opts.decrypt = true;
    else if (arg === "--derive") opts.derive = argv[++i];
    else if (arg === "--vectors")
      opts.vectors = argv[i + 1]?.startsWith("--") ? true : (argv[++i] ?? true);
    else if (arg === "--help" || arg === "-h") return process.stdout.write(USAGE);
    else if (arg.startsWith("--")) die(`unknown option ${arg}`);
    else positional.push(arg);
  }

  if (opts.vectors) {
    return verifyVectors(opts.vectors === true ? DEFAULT_VECTORS : opts.vectors);
  }
  if (opts.derive) {
    if (!/^[0-9a-fA-F]{64}$/.test(opts.derive)) die("--derive takes a 32-byte hex PRF output");
    const { rawPub } = deriveFromPrf(Buffer.from(opts.derive, "hex"));
    const fpr = fingerprint(rawPub);
    return process.stdout.write(
      `${PUBLIC_KEY_PREFIX + b64url(rawPub)}\n${formatFingerprint(fpr)}\n`,
    );
  }
  if (opts.decrypt) {
    if (!opts.key) die("--decrypt requires --key <32-byte-hex | private-key.pem>");
    const token = opts.stdin ? readFileSync(0, "utf8").trim() : positional[0];
    if (!token) die("no token given");
    return process.stdout.write(`${decrypt(token, loadPrivateKey(opts.key))}\n`);
  }
  if (!opts.to) die(`missing --to entz1pk_...\n${USAGE}`);
  const plaintext = opts.stdin ? readFileSync(0, "utf8") : positional[0];
  if (plaintext === undefined) die("no plaintext given (pass it as an argument or use --stdin)");
  process.stdout.write(`${encrypt(plaintext, parsePublicKeyString(opts.to), opts)}\n`);
}

main(process.argv.slice(2));
