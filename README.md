# entziffer

Shared tools — issue trackers, wikis, docs, chat — have no field-level privacy. **entziffer**
encrypts a piece of text to your public key before it leaves your machine. A Chrome extension
shows you the plaintext in a card under your cursor; everyone else sees an `ENTZ1:…` string.

The private key never leaves your browser, so an agent or a teammate's script can *write*
private text for you with nothing but your public key. Filing
[private Linear issues](#example-private-linear-issues) is the motivating use case.

```
agent/CLI (public key only) ──ENTZ1:<b64url>──▶ any web app ──▶ Chrome extension (private key) ──▶ plaintext shown to you
```

## Quick start

Needs macOS 15+, Chrome 133+, Node 22+. Five minutes.

1. **Install the extension.** Unzip the
   [latest release](https://github.com/haydenshively/entziffer/releases/latest) somewhere
   permanent, then `chrome://extensions` → Developer mode → *Load unpacked*.
2. **Enable a site.** On the options page, under *Sites*, add an origin such as
   `https://linear.app`. A fresh install runs nowhere.
3. **Create your key.** Click *Set up with Touch ID*. Copy the `entz1pk_…` public key it shows.
4. **Register it with the CLI.**
   ```sh
   npx entziffer@latest keys add me entz1pk_...
   ```
5. **Encrypt something.**
   ```sh
   echo "Candid notes nobody else should read." | npx entziffer@latest encrypt --stdin
   ```
6. **Read it.** Paste the `ENTZ1:…` token into any field on the site you enabled and hover it.

**The passkey is the key.** Delete it from iCloud Keychain, or lose the Apple account, and
everything encrypted to it is gone. There is no backup file.

Second Mac, extension ID check, troubleshooting: [docs/install.md](docs/install.md).

## How it works

### Encryption

- X25519 + HKDF-SHA256 + AES-256-GCM, with a fresh ephemeral key pair per token.
- Encrypting needs no secret, so the CLI and any agent hold only your `entz1pk_…` public key.
- The wire format is specified byte for byte in [docs/format.md](docs/format.md).
  [`reference/encrypt.mjs`](reference/encrypt.mjs) implements it in one dependency-free file.

### Your key

- No private key is stored. The extension derives it from your passkey's WebAuthn PRF output,
  once per browser session, after a Touch ID prompt.
- While unlocked, the derived key is a non-extractable `CryptoKey` in the extension's session
  store. It is deleted on lock, auto-lock, and browser restart.
- iCloud Keychain syncs the passkey, so a second Mac derives the identical key. Your public key
  and every teammate's CLI config keep working.

### Reading

- The page's text is never rewritten. A CSS Custom Highlight tags the `ENTZ1:` marker of each
  token; the ciphertext stays selectable and copyable.
- Hover a token and its plaintext appears in a card beside the cursor, drawn in the page's own
  font. Click to pin the card and copy from it. Escape unpins.
- Tokens encrypted to someone else get a grey tag and a grey card naming the recipient when
  their key is in your *People* address book.
- Editing a token inside the page's editor is refused, since that would corrupt it or leak
  plaintext. To change a field, re-encrypt the new value with the CLI and paste it in.

## Example: private Linear issues

Linear has no private issues: every title and description is readable by the whole
workspace. An agent files the issue with ciphertext in both fields and only you can read it.

1. Enable `https://linear.app` under *Sites*.
2. Encrypt the fields together on stdin, so plaintext never touches `argv`:
   ```sh
   npx entziffer@latest encrypt-json --json <<'JSON'
   {"title": "Acme renewal — candid notes", "description": "…"}
   JSON
   ```
   Output: `{"fields":{"title":"ENTZ1:…","description":"ENTZ1:…"},"recipient":"me","fingerprint":"a1b2-c3d4"}`.
3. Create the issue with the Linear MCP server's `save_issue` (or the GraphQL API), passing the
   returned `fields` **verbatim**. No code fence, no wrapping, no truncation.
4. Report the issue URL and the fingerprint, so you can check it against your extension.

Rules for the agent:

- Never put plaintext, a summary, or a "search hint" into any unencrypted field: comments,
  labels, project names, branch names, attachments, commit messages.
- Encrypted titles are unsearchable and unsortable. Accept it.
- If encryption fails, stop. Never file in plaintext.
- To change an encrypted field, re-encrypt the whole new value and replace it.

## Locking

A new browser session starts locked. Hovering a token shows *Locked · click to unlock*; click,
approve Touch ID, and tokens start answering the cursor. The session ends on browser restart, on
**Lock now**, or after the auto-lock timeout (1, 4, 12, or 24 hours; 12 by default).

| Adversary | Result |
| --- | --- |
| Copies your Chrome profile directory | Gets a public key; needs your passkey and a Touch ID prompt to derive anything |
| Runs code in your profile while unlocked | Reads everything, exactly as the extension does |
| Has your Apple account and passkey | Has your key — that is what recovery means |

## What is protected, and what is not

- **Protected:** the content of the fields you encrypt, from teammates, admins, and the vendor.
- **Not protected:** that the record exists, who created it and when, every field left in
  plaintext, and the approximate length of the text.
- **Not protected:** anything, while your Chrome profile is unlocked and compromised.
- **Permanent loss:** losing the passkey. Nothing can recover the data.

Read [SECURITY.md](SECURITY.md) and [docs/threat-model.md](docs/threat-model.md) before
trusting this with anything that would hurt if it leaked.

## Repo layout

| Path | What |
| --- | --- |
| `packages/core` | `@entziffer/core` — WebCrypto-only implementation of ENTZ1, zero runtime deps |
| `packages/cli` | `entziffer` — the npm CLI agents call (`encrypt`, `encrypt-json`, `keys`, …) |
| `packages/extension` | Chrome MV3 extension: keystore, session lock, content script, options page |
| `reference/` | `encrypt.mjs`, the auditable single-file implementation, plus cross-impl tests |
| `docs/` | [format](docs/format.md), [install](docs/install.md), [threat model](docs/threat-model.md) |
| `CONTRIBUTING.md` | Local setup, dev loop, and how a release happens |

## Development

Node ≥ 22 and pnpm 10 (`corepack enable` picks up the pinned version from `package.json`).

```sh
pnpm install
pnpm check          # lint, build, typecheck, then unit tests — in that order
pnpm test:e2e       # Playwright against a real Chrome; first run:
                    #   pnpm --filter @entziffer/extension exec playwright install --with-deps chromium
pnpm zip            # the release artifact, packages/extension/entziffer-extension-<version>.zip
node reference/encrypt.mjs --vectors   # audit the reference implementation
```

`pnpm check` runs the steps in the order they depend on each other: the extension and the CLI
typecheck against `@entziffer/core`'s built `dist`, and the unit tests import it, so `pnpm build`
has to come first. The individual steps are still available as `pnpm lint`, `pnpm build`,
`pnpm typecheck`, and `pnpm test`.

To try the extension, load `packages/extension/dist` unpacked in `chrome://extensions`. There is
no HMR: rebuild, press reload on the extension card, reload the page. Details, and the release
process, in [CONTRIBUTING.md](CONTRIBUTING.md). CI runs everything above on every PR.

## License

MIT. See [LICENSE](LICENSE).
