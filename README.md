# entziffer

Linear has no private issues: anyone in the workspace can read every title and
description. **entziffer** encrypts an issue's title and description to your public key
before it ever reaches Linear, and a Chrome extension decrypts them into a floating pane
beside the page while you browse — issue list, board, detail view, notifications, search
results. To everyone else the issue is a `ENTZ1:…` string. The private key never leaves your
browser profile, so a Claude Code agent (or a teammate's script) can *write* private issues
for you with nothing but your public key.

```
agent/CLI (public key only) ──ENTZ1:<b64url>──▶ Linear ──▶ Chrome extension (private key) ──▶ plaintext shown to you
```

## How it works

Public-key encryption, X25519 + HKDF-SHA256 + AES-256-GCM, one ephemeral key pair per
token. Encrypting requires no secret, so the CLI, the skill, and any agent hold only your
`entz1pk_…` public key.

**No private key is stored between sessions.** It is derived from your passkey: the extension
asks the authenticator for a WebAuthn PRF value and turns it into the same X25519 key every
time, once per browser session. While unlocked, that derived key lives as a non-extractable
`CryptoKey` in the extension's own IndexedDB session store, and is deleted on lock, on
auto-lock, and on browser restart. What sits on disk between sessions is your public key and
which passkey to ask.
Because iCloud Keychain syncs the passkey, a new Mac on the same Apple account regenerates the
identical key after one Touch ID — your public key and every teammate's CLI config keep
working. The wire format is specified byte for byte in [docs/format.md](docs/format.md), and
[`reference/encrypt.mjs`](reference/encrypt.mjs) is a single dependency-free file that
implements it if you would rather not trust npm.

**Reading and editing an encrypted field.** entziffer never rewrites the page's text. Every
token stays exactly as the page rendered it and is masked with a CSS Custom Highlight — the
ciphertext goes transparent and the space it occupies is filled with a solid tint, like a censor's bar, so it
reads as redacted, nothing shifts, and selecting or copying still yields the ciphertext. The
plaintext appears in a floating pane beside the page — think a Markdown preview next to the
source — which lists every token on the page, editable and inert alike. Inert tokens are
read-only with a *Copy* button; a token inside an editor is editable in the pane, and what you
type there is re-encrypted to your own key and written back into the field as ciphertext, so
the plaintext never enters the editor unless you click *Insert plaintext*, which replaces the
ciphertext in the field for real — saving it then stores the plaintext in Linear, which is how
you declassify or edit an issue.

## Quick start (5 minutes)

1. **Install the extension.** Download `entziffer-extension-<version>.zip` from the
   [latest release](https://github.com/haydenshively/entziffer/releases/latest), unzip it,
   then `chrome://extensions` → Developer mode → *Load unpacked* → pick the folder.
   Chrome 133 or newer.
2. **Enable the sites you use.** A fresh install runs nowhere. On the options page, under
   *Sites*, add an origin (`https://linear.app` if you file Linear issues) — Chrome asks for
   permission on that origin only — or turn on *Enable on all sites*.
3. **Set up your key.** Open the extension's options page and click *Set up with Touch ID*.
   It creates a passkey in iCloud Keychain, derives your key from it, and shows the
   `entz1pk_…` public key. On another Mac, click *I already have an entziffer passkey*
   instead and pick the synced passkey — same key, same public key.
4. **Keep the passkey.** That passkey is the key. Deleting it from iCloud Keychain, or losing
   the Apple account it lives in, makes every issue encrypted to it unreadable forever. There
   is no backup file and no export.
5. **Tell the CLI about the key.**
   ```sh
   npx entziffer@latest keys add me entz1pk_...
   npx entziffer@latest keys default me
   ```
6. **Install the skill.**
   ```sh
   cp -R skills/private-linear-issue ~/.claude/skills/
   ```
7. **Use it.** Ask Claude Code: *"file a private Linear issue about the Acme renewal"*. It
   encrypts, files the issue, and hands you the URL. Open it in Chrome and read it.

Full details, per-repo skill installs, and a verification step: [docs/install.md](docs/install.md).

## Locking and unlocking

At rest the extension holds `{credentialId, publicKey, fingerprint}` and nothing else. The
pane carries a pill — a padlock and a token count — under its bottom-left corner, which reads
*Locked* for a new browser session; click it, approve the Touch ID prompt, and the plaintext
appears in the pane. The derived key lives in the extension's session store until the browser
restarts, until **Lock now**, or until the auto-lock timeout (1, 4, 12, or 24 hours; 12 by
default).

| Adversary | Result |
| --- | --- |
| Copies your Chrome profile directory | Gets a public key; needs your passkey and a Touch ID prompt to derive anything |
| Runs code in your profile while unlocked | Reads everything, exactly as the extension does |
| Has your Apple account and passkey | Has your key — that is what recovery means |

Requires macOS 15+ with Chrome 133+ and a PRF-capable passkey provider (iCloud Keychain). The
passkey is provider-bound: moving to a different provider means a different key, and
re-encrypting existing issues, which entziffer does not do for you yet.

## What is protected, and what is not

Encrypted: the **content** of the issue title and description — from teammates, workspace
admins, and Linear itself.

Not encrypted: that the issue exists, who created it, when, its team, project, labels,
status, comments, and the approximate length of the plaintext. Anyone who compromises your
Chrome profile while it is unlocked can read everything. Losing the passkey destroys the data
permanently. Read [SECURITY.md](SECURITY.md) and
[docs/threat-model.md](docs/threat-model.md) **before** deciding this is enough for your
threat model.

## Repo layout

| Path | What |
| --- | --- |
| `packages/core` | `@entziffer/core` — WebCrypto-only implementation of ENTZ1, zero runtime deps |
| `packages/cli` | `entziffer` — the npm CLI agents call (`encrypt-issue`, `keys`, …) |
| `packages/extension` | Chrome MV3 extension: keystore, session lock, content script, options page |
| `reference/` | `encrypt.mjs`, the auditable single-file implementation, plus cross-impl tests |
| `skills/private-linear-issue` | The Claude Code skill |
| `docs/` | [format](docs/format.md), [install](docs/install.md), [threat model](docs/threat-model.md) |

## Development

```sh
pnpm install
pnpm check          # lint, typecheck, build, then unit tests — in that order
pnpm test:e2e       # Playwright against a real Chrome, needs chromium
pnpm zip            # release artifact
node reference/encrypt.mjs --vectors   # audit the reference implementation
```

`pnpm check` runs the steps in the order they depend on each other: the unit tests import
`@entziffer/core` through its built `dist`, so `pnpm build` has to come first. The individual
steps are still available as `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test`.

Node ≥ 22, pnpm 10. CI runs everything above on every PR.

## License

MIT. See [LICENSE](LICENSE).
