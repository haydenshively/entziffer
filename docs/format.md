# ENTZ1 wire format

Version 1. One recipient per token. Everything below is normative; `packages/core`
and `reference/encrypt.mjs` must agree byte for byte.

## Primitives

| Purpose | Algorithm |
| --- | --- |
| Key agreement | X25519 (RFC 7748) |
| KDF | HKDF-SHA256 (RFC 5869) |
| AEAD | AES-256-GCM, 12-byte nonce, 16-byte tag |
| Key derivation | HKDF-SHA256 over a WebAuthn PRF output (see below) |
| Text encoding | UTF-8; base64url **without** padding (RFC 4648 §5) |

## Token

```
token    = "ENTZ1:" || base64url(envelope)
envelope = ver(1) || fpr(4) || ephPub(32) || ct || tag(16)
header   = ver(1) || fpr(4) || ephPub(32)                    // 37 bytes, used as AAD
```

- `ver` = `0x01`. Any other value is `UNSUPPORTED_VERSION`.
- `fpr` = `SHA-256(recipient raw public key)[0..4]`, displayed as `a1b2-c3d4`.
- `ephPub` = raw 32-byte X25519 public key of a freshly generated ephemeral key pair.
- `ct || tag` is the AES-GCM output over UTF-8 plaintext with `header` as additional
  authenticated data. Empty plaintext is legal, so the minimum envelope is 53 bytes.

Derivation:

```
ikm = X25519(ephPriv, recipientPub)
okm = HKDF-SHA256(ikm, salt = ephPub, info = utf8("entziffer-v1") || fpr, len = 44)
key   = okm[0..32]
nonce = okm[32..44]
```

### Why the nonce is derived

A fixed all-zero nonce would be safe here (the AES key is unique per token because the
ephemeral key is), but deriving it costs nothing on the wire and keeps the format usable
if v2 ever reuses one ephemeral key across several recipients, where a constant nonce
would be catastrophic.

### Fingerprint

`fpr` is a recipient routing hint and nothing more. It lets a reader decide "is this token for
me?" before any key agreement, and lets a UI put a name on a token it cannot read — the CLI's
`inspect` and the extension's address book both look the four bytes up in a local list of
public keys. It is attacker-controlled (a sender writes whatever it likes) and, at 32 bits,
collision-prone by construction, so it must never be treated as sender or recipient
authentication: only a successful AEAD open proves anything. There is no sender identity in
the format at all — encrypting needs no secret, so senders (CLI, agents) hold no key to be
identified by.

### Marker

The marker is exactly `ENTZ1:`. There is no configurable or namespaced prefix: a token that
does not start with those six bytes is `BAD_MARKER`.

Scanning: the base64url run after the marker is `[A-Za-z0-9_-]+` and ends at the first
character outside that set. A token may therefore sit mid-sentence, be followed by
punctuation, or appear inside markdown link text. A marker with an empty run is not a
token.

### Size

Ciphertext overhead is 53 bytes (37-byte header + 16-byte tag), and base64url expands by
4/3, so a token is `6 + ceil(4 * (53 + utf8len(plaintext)) / 3)` characters.

| Plaintext | Bytes on the wire | Token characters |
| --- | --- | --- |
| 0 | 53 | 77 |
| 60 (typical issue title) | 113 | 157 |
| 1 024 | 1 077 | 1 442 |
| 4 096 | 4 149 | 5 538 |

## Key strings

```
public key = "entz1pk_" || base64url(raw X25519 public key, 32 bytes)   // 51 chars
```

There is no private-key string: the private key is never serialized, stored, or exported.

## Key derivation

The recipient key pair is derived from a WebAuthn PRF output, so the same passkey always
yields the same identity and nothing has to be stored:

```
FIXED_PRF_SALT = SHA-256("entziffer-key-derivation-v1")
               = ddc9491d8d923e1ae18435a24f310f134cea31361178f52d0de7829d1207e9e8
prf  = PRF(salt = FIXED_PRF_SALT)          // credentials.create/get, userVerification required
seed = HKDF-SHA256(ikm = prf, salt = "", info = utf8("entziffer-x25519-v1"), len = 32)
```

The PRF output MUST be exactly 32 bytes; any other length is `PRF_UNSUPPORTED`. This scheme
is **derivation version 1**. Implementations that persist an enrolled credential MUST store
the derivation version next to it and refuse to derive from a credential enrolled under a
version they do not implement, so a future scheme cannot silently reinterpret an existing
passkey.

`seed` is the raw X25519 private scalar. Any 32 bytes are a valid private key — clamping is
performed by the X25519 implementation on use, not by this spec. WebCrypto has no raw import
for X25519 private keys, so implementations build the PKCS#8 DER document
`302e020100300506032b656e04220420 || seed` and import that as non-extractable `deriveBits`.
The public key is `X25519(seed, basepoint)`.

## Error codes

`BAD_MARKER`, `BAD_BASE64`, `BAD_LENGTH`, `UNSUPPORTED_VERSION`, `FPR_MISMATCH`,
`KEY_MISMATCH`, `DECRYPT_FAILED`, `BAD_KEY_STRING`, `NO_KEY`, `LOCKED`, `PRF_UNSUPPORTED`,
`PASSKEY_CANCELLED`.

Decryption checks them in that order: marker, base64, length, version, fingerprint, then
AEAD. `FPR_MISMATCH` is raised before any key agreement, so "not addressed to me" is
cheap and clearly distinct from "tampered".

The two mismatch codes are not interchangeable. `FPR_MISMATCH` compares the envelope's
four-byte fingerprint and is only a routing hint — it must never be treated as proof of
identity. `KEY_MISMATCH` compares the full 32-byte derived public key against a stored one,
and is what an implementation raises when a passkey unlocks to the wrong identity.

## Test vectors

`packages/core/test/vectors.json` is consumed by the core tests, the reference script's
`--vectors` mode, and the extension bundle.

```jsonc
{
  "version": 1,
  "algorithm": "ENTZ1 (X25519 + HKDF-SHA256 + AES-256-GCM)",
  "recipient": {
    "privateKeyHex": "…64 hex chars…",   // raw X25519 scalar
    "publicKeyHex":  "…64 hex chars…",   // raw X25519 point
    "publicKey":     "entz1pk_…",
    "fingerprintHex": "…8 hex chars…",
    "fingerprint":    "a1b2-c3d4"
  },
  "derivation": {
    // Known-answer vector for the key derivation above.
    "prfSaltHex": "…FIXED_PRF_SALT…", "prfHex": "…64 hex chars…",
    "seedHex": "…64 hex chars…", "publicKeyHex": "…", "publicKey": "entz1pk_…",
    "fingerprintHex": "…", "fingerprint": "a1b2-c3d4"
  },
  "vectors": [
    {
      "name": "ascii-title",
      "ephemeralPrivateKeyHex": "…64 hex chars…",
      "plaintext": "…",
      "token": "ENTZ1:…"                 // expected output, byte for byte
    }
  ],
  "foreign": {
    // Same shape as a vector, plus the other recipient's key material.
    // Decrypting it with `recipient.privateKeyHex` must fail with FPR_MISMATCH.
    "note": "…",
    "privateKeyHex": "…", "publicKey": "entz1pk_…",
    "fingerprintHex": "…", "fingerprint": "a1b2-c3d4",
    "ephemeralPrivateKeyHex": "…", "plaintext": "…", "token": "ENTZ1:…"
  }
}
```

An implementation passes if, for every entry in `vectors`, encrypting `plaintext` to
`recipient.publicKey` with the given ephemeral private key reproduces `token` exactly,
and decrypting `token` with `recipient.privateKeyHex` reproduces `plaintext`; and if
deriving from `derivation.prfHex` reproduces `derivation.publicKey`
(`node reference/encrypt.mjs --derive <prfHex>`).
