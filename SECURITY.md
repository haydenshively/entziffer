# Security

## Supported versions

entziffer is pre-1.0. Only the latest tagged release gets fixes.

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/haydenshively/entziffer/security/advisories/new)
for this repository. **Do not open a public issue, and do not file it as an encrypted
Linear issue.**

Please include the affected component (`@entziffer/core`, `entziffer` CLI, the Chrome
extension, or `reference/encrypt.mjs`), the version or commit, and enough detail to
reproduce. Expect an acknowledgement within a week. There is no bug bounty.

Findings that let an attacker read plaintext without the private key, recover the private
key, or trick the extension into writing plaintext back into a Linear field are the ones
worth reporting most urgently.

## What entziffer protects

The **content** of a Linear issue's title and description, against everyone with access to
Linear — teammates, workspace admins, integrations, and Linear itself. Encryption is
X25519 + HKDF-SHA256 + AES-256-GCM, done on your machine before anything is sent.

## What it does not protect

- **Metadata.** That the issue exists, who filed it, when, its team, project, labels,
  status, assignee, and comments are all plaintext in Linear.
- **Length.** Ciphertext is 53 bytes longer than the UTF-8 plaintext, so the size of what
  you wrote is visible.
- **Comments**, unless you encrypt each one deliberately.
- **Your machine.** A compromised Chrome profile, a malicious extension, or malware can
  read every plaintext while the session is unlocked, because the extension's job is to
  display it. Locking narrows that window (see below); it does not close it.
- **Old issues after a key compromise.** There is no forward secrecy for the long-term
  recipient key: whoever gets that key can read everything ever encrypted to it.
- **Authorship.** Tokens are encrypted but not signed; anyone with your public key can
  create an issue that decrypts for you.

## Where the private key lives

No private key is stored between sessions. The X25519 private key is derived
deterministically from your passkey's WebAuthn PRF output (HKDF-SHA256, info
`entziffer-x25519-v1`) with `userVerification: "required"`; between sessions the extension
keeps only the credential id, the public key, its fingerprint, and the derivation version.
While unlocked, the derived non-extractable key lives in the extension's own IndexedDB
session store and is deleted on lock, auto-lock, or browser restart. What that buys,
precisely:

- **Nothing to steal at rest.** Someone who copies the Chrome profile directory — off a
  backup, a stolen disk, or a second admin account — gets public data. Deriving the key
  needs your authenticator and a user-verification prompt.
- **Does not protect an unlocked session.** After you unlock, the derived key sits in the
  extension's IndexedDB for the rest of the session, and code running in your profile can
  ask the extension to decrypt exactly as before.
- **Bounds the window.** The session is cleared on browser restart, on extension reload, on
  **Lock now**, and on an inactivity alarm (1, 4, 12, or 24 hours; 12 by default).
- **Residual exposure.** The 32-byte seed exists transiently in the JavaScript heap during
  derivation: WebCrypto has no raw X25519 private-key import, so the seed must be assembled
  into a PKCS#8 buffer first. See [docs/threat-model.md](docs/threat-model.md).

## Losing the passkey means permanent data loss

The passkey is the key. There is no backup blob, no export, and no escrow: deleting the
passkey from iCloud Keychain, or losing the Apple account that syncs it, makes every issue
encrypted to that key unreadable forever. A new Mac on the same iCloud account recovers the
key with one Touch ID. Moving to a different passkey provider does not — it yields a
different key.

## Cryptographic details and full threat model

[docs/threat-model.md](docs/threat-model.md) — adversaries covered and not covered,
caveats, and operational rules. The wire format is specified in
[docs/format.md](docs/format.md), with an auditable single-file implementation in
[reference/encrypt.mjs](reference/encrypt.mjs) (`node reference/encrypt.mjs --vectors`).
