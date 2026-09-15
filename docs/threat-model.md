# Threat model

Read this before you put anything in an entziffer issue that would hurt if it leaked.
[SECURITY.md](../SECURITY.md) is the short version; this file is the reasoning.

## What entziffer is for

One person keeps candid notes in Linear — often sourced from a Slack DM or a 1:1 — and
does not want the rest of the workspace, or Linear's own staff, reading them. Linear has
no per-issue access control, so the content is encrypted client-side instead.

## Assets

| Asset | Protected? |
| --- | --- |
| Issue title text | Yes — AES-256-GCM, key held only by the recipient |
| Issue description text | Yes |
| Comment text | Only if you explicitly encrypt each comment |
| The fact that an issue exists | **No** |
| Author, timestamps, team, project, labels, status, assignee, cycle | **No** |
| Approximate plaintext length | **No** — ciphertext length ≈ plaintext length + 53 bytes |
| Recipient fingerprint | **No** — the first 4 bytes of the envelope name the key |

The fingerprint is a routing hint: it tells the extension whether a token is addressed to the
key it holds. Four bytes is far too short to resist a deliberate collision search, so it is not
an identity check — see [Operational rules](#operational-rules).

## Adversaries this defeats

- **Any other member of your Linear workspace**, including admins and owners. They see
  `ENTZ1:…`.
- **Linear the company**, and anyone who obtains a dump of Linear's database or a Linear
  API token for your workspace.
- **Integrations**: Slack unfurls, GitHub sync, webhooks, search indexers, analytics — all
  of them receive the ciphertext.
- **A tampering attacker.** The 37-byte header (version, fingerprint, ephemeral public key)
  is authenticated as AES-GCM additional data, so flipping any byte of an envelope makes
  decryption fail rather than silently changing the plaintext.

## Adversaries this does not defeat

- **A compromised Chrome profile with an unlocked session.** While unlocked, the derived key
  sits in the extension's IndexedDB — non-extractable, so it cannot be read back out, but
  usable for decryption by anything that can talk to the extension — and the extension
  decrypts into the page, so malware or a malicious extension with access to your profile can
  read every plaintext you view. Extension permissions are the whole ballgame: the extension
  ships with no host access at all and runs only on the origins you enable one at a time (or
  everywhere, if you turn on *Enable on all sites*).
  [Key derivation](#key-derivation-and-the-session) helps only against an attacker who is
  *not* running code in an unlocked session.
- **A compromised machine generally** — a keylogger or screen recorder sees plaintext as
  you type or read it.
- **Anyone who can change what the agent encrypts.** A prompt-injected agent could be made
  to encrypt to the *attacker's* public key, or to leak the plaintext elsewhere before
  encrypting. When it matters, check the recipient's stored public key (`entziffer keys list`)
  against the one your extension shows, not just the fingerprint the CLI reports.
- **Traffic analysis and metadata correlation.** "Hayden filed 4 encrypted issues in the
  Hiring project on the day of the review cycle" is fully legible.
- **Someone shoulder-surfing your screen.** The extension's job is to show you plaintext.

## Key derivation and the session

No private key is stored between sessions. Every unlock runs
`navigator.credentials.get({ userVerification: "required", extensions: { prf: { eval: { first:
FIXED_PRF_SALT } } } })` against the entziffer passkey and derives

```
seed = HKDF-SHA256(ikm = prf, salt = "", info = "entziffer-x25519-v1", len = 32)
```

which is imported as the X25519 private key. The keystore holds `{credentialId, publicRaw,
fpr, enrolledAt, derivation}` — public data plus which passkey to ask and which derivation
scheme produced the stored public key. While unlocked, the derived key lives in the
extension's IndexedDB session store and is deleted on lock, auto-lock, or browser restart.

| Adversary | Outcome |
| --- | --- |
| Copies the Chrome profile directory | Gets the public key and a credential id; needs the authenticator and a user-verification prompt to derive anything |
| Steals the laptop, locked, no unlocked session | Also needs Touch ID for entziffer specifically |
| Runs code in your profile while the session is unlocked | **Can decrypt** — no change |
| Controls the Apple account that syncs the passkey | **Can derive the key** — that is what cross-device recovery costs |

The unlocked private key is a non-extractable CryptoKey in a separate IndexedDB store, so it
is on disk while unlocked. It is deleted on `chrome.runtime.onStartup`, on `onInstalled`
(extension reload or update), when the `chrome.storage.session` sentinel is missing at
service-worker start — the case a browser restart alone would miss — on explicit **Lock
now**, and on a `chrome.alarms` inactivity timer (default 12 hours; `0` disables it). Those
bound the exposure window; they do not shrink it to zero.

**Residual: the seed in the heap.** WebCrypto has no raw import for an X25519 private key, so
the 32 derived bytes are assembled into a PKCS#8 buffer and handed to `importKey`. Those bytes
therefore exist as plain JavaScript memory for the duration of the call (both buffers are
zeroed afterwards, which JavaScript cannot guarantee reclaims copies the engine made). No
WebCrypto path avoids this; anything able to read the service worker's heap at that moment is
already able to ask the extension to decrypt.

Failure modes: an authenticator without PRF support answers `PRF_UNSUPPORTED` and nothing is
stored; dismissing the prompt is `PASSKEY_CANCELLED` and leaves the state unchanged; a passkey
that derives a different key answers `KEY_MISMATCH` rather than replacing your identity.

## Rendering: in place vs overlay-only

The extension shows plaintext two ways, and the trade-off is legibility against how much of the
page's own DOM it touches.

- **In place (the default).** Inert text — list rows, board cards, notifications, read-only
  descriptions — has its ciphertext replaced by a `<span data-entz-plain>` carrying the
  plaintext, so selection, wrapping, find-in-page, and copy behave normally. The span inherits
  the surrounding typography and adds only a thin dotted underline. The ciphertext is kept in
  `data-entz-ct` and put back on lock or on any settings change. The residual risk is that the
  host page's own JavaScript can read the plaintext out of the DOM. entziffer never writes into
  an editor — `[contenteditable]`, `.ProseMirror`, `[role="textbox"]`, `input`, `textarea` — so
  nothing round-trips back to the server, but a page that scrapes its own rendered text would
  see decrypted content.
- **Overlay-only** (`overlayOnly`, off by default). Page text is never modified: the plaintext
  is drawn in a shadow-DOM overlay pinned to the token's client rects, and clicking it or
  pressing `Esc` reveals the ciphertext underneath. This is what editable regions always get.
  It removes the DOM-scraping risk at the cost of text you cannot select or search.

Overlay-only is a kill switch, not a hardened mode: the plaintext still exists in the tab's
process, and the overlay is still injected into the page's document. Hardening it — an isolated
rendering surface, no plaintext reachable from page script — is tracked in
[issue #1](https://github.com/haydenshively/entziffer/issues/1).

## Cryptographic caveats

- **No forward secrecy for the recipient key.** Each token uses a fresh ephemeral sender
  key, so compromising one token compromises only that token — but an attacker who later
  obtains your *long-term private key* can decrypt every issue ever encrypted to it,
  including ones already in Linear's backups. Rotating your key does not protect old
  issues; only deleting them does.
- **Single recipient in v1.** You cannot add a second reader after the fact; you would
  re-encrypt and re-file. The format reserves room for multi-recipient (which is why the
  nonce is derived rather than fixed), but v1 rejects more than one.
- **No signatures.** A token proves nobody tampered with it, not who wrote it. Anyone with
  your public key can create an issue that decrypts cleanly for you. Trust the Linear
  author field for provenance, not the ciphertext.
- **Your key is exactly as strong as the passkey's PRF secret.** It inherits the
  authenticator's protection (Secure Enclave, user verification) and the sync channel's:
  whoever controls the iCloud account that syncs the passkey can derive the key.
- **The passkey is provider-bound.** PRF output is a property of the credential, so a passkey
  moved or re-created in another provider derives a *different* key. Changing providers means
  a new identity and re-encrypting existing issues, which entziffer does not do for you.
- **Key loss is permanent data loss.** There is no escrow, no export, and no support ticket.
  Delete the passkey (or lose the Apple account) and the issues stay unreadable forever. This
  is the single most likely way to lose data with entziffer.

## Operational rules

- Never paste plaintext into a Linear comment, label, project name, branch name, or
  attachment, and never into a commit message. The skill enforces this for agents; you
  have to enforce it for yourself.
- Encrypted titles are unsearchable and unsortable. Do not compensate with a plaintext
  "hint" — that hint is usually the part that mattered.
- When you add a teammate's key, compare the **full `entz1pk_…` string** out of band, not the
  4-byte fingerprint: an attacker can search for a key whose fingerprint matches, but not one
  whose whole public key does. `entziffer keys list` prints the stored key next to its name;
  the extension's options page prints the one it holds.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
