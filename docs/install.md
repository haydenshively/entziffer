# Installing entziffer

Three pieces, in this order: the **extension** (derives your private key from a passkey), the
**CLI** (the encryptor), and the **skill** (teaches Claude Code to use both). Budget five
minutes.

Requirements: macOS 15 or newer, Chrome 133 or newer (X25519 in WebCrypto and the WebAuthn
PRF extension), Node 22 or newer.

## 1. Chrome extension

The extension is distributed as an unpacked build attached to each GitHub release; it is
not in the Chrome Web Store.

1. Download `entziffer-extension-<version>.zip` from the
   [latest release](https://github.com/haydenshively/entziffer/releases/latest).
2. Unzip it into a folder you will keep — Chrome loads the extension from that path on
   every start, so don't unzip into `~/Downloads` and then clean it out.
3. Open `chrome://extensions`, turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder (the one containing
   `manifest.json`).
5. Confirm the version in `chrome://extensions` matches the release you downloaded, and that
   the **ID** reads `bgopgffcljkdlogpflimomjbfbmbaoap`.

Building it yourself instead:

```sh
pnpm install && pnpm --filter @entziffer/extension build
# load packages/extension/dist as the unpacked extension
```

### Your extension ID must be `bgopgffcljkdlogpflimomjbfbmbaoap`

The extension origin is the WebAuthn RP ID, so the ID decides which passkey Chrome offers
and therefore which key you get. `manifest.json` carries a `"key"` that pins it, which is
what lets a second Mac find the same synced passkey. **If `chrome://extensions` shows a
different ID, the manifest key is wrong** — you are running a modified or repackaged build,
and any key you set up under it will not match the one on your other machines. Re-download
the release rather than enrolling a passkey.

### Enable the sites you use

A fresh install has **no host access at all** and runs on no page until you say so. On the
options page, under **Sites**, type an origin and click **Enable site**: Chrome asks for
permission on that origin, and the content script is registered for it. If you file issues in
Linear, add `https://linear.app` first. **Enable on all sites** requests `<all_urls>` instead,
and the popup offers **Enable on this site** for whatever tab you are looking at. Removing a
site from the list hands the permission back.

### Set up your key

Open the extension's options page (**Details → Extension options**, or the popup's settings
link) and click **Set up with Touch ID**. That creates a passkey (iCloud Keychain by default)
and derives your X25519 key from its WebAuthn PRF output. Copy the `entz1pk_…` public key and
note the fingerprint (`a1b2-c3d4`).

No private key is stored between sessions: on disk the extension keeps the credential id, the
public key, its fingerprint, and the derivation version. Every unlock re-derives the private
key from the passkey, so the same passkey always yields the same identity; while unlocked, the
derived non-extractable key lives in the extension's IndexedDB session store and is deleted on
lock, auto-lock, or browser restart.

Requirements:

- macOS 15 (Sequoia) or newer, Chrome 133 or newer.
- A passkey provider that supports the PRF extension: **iCloud Keychain** (verified). A
  hardware security key works only if it supports `hmac-secret`.

### On a second Mac (or after a profile wipe)

Open the options page and click **I already have an entziffer passkey**. Chrome shows its
passkey picker over discoverable credentials; choose the entziffer passkey synced through
iCloud Keychain, approve Touch ID, and the same public key comes back. Teammates' CLI configs
keep working untouched.

### The passkey is the key

Deleting that passkey from iCloud Keychain — or losing the Apple account that syncs it —
makes every issue encrypted to it unreadable forever. There is no backup file, no export, and
no escrow.

The passkey is also provider-bound: PRF output belongs to the credential, so a passkey
re-created in a different provider derives a *different* key. Switching providers means a new
identity and re-encrypting existing issues, which entziffer does not do for you.

### Locking and unlocking

- The plaintext pane carries a pill — a padlock and a token count — under its bottom-left
  corner. In a new browser session it reads *Locked*, and the pane offers an **Unlock** button;
  clicking either the collapsed pill or that button opens an unlock tab that runs the Touch ID
  prompt and closes itself, and the pane then fills with plaintext. Clicking the pill otherwise
  collapses the pane into it or opens the pane again — the pill never moves, and its padlock is
  shut while the pane is collapsed and open while it is expanded. The action popup has
  **Unlock** and **Lock now** buttons. (The prompt has to run in a tab: opening the OS dialog
  closes the popup.)
- The session ends on browser restart, on extension reload, on **Lock now**, and after the
  auto-lock timeout — 1, 4, 12 (default), or 24 hours, chosen on the options page. Locking is
  immediate on every open tab: the pane empties without a reload. The page's own text was
  never changed, so there is nothing to strip.

If something goes wrong:

- **`PRF_UNSUPPORTED`** ("this passkey provider did not return a PRF value") means the
  authenticator you chose does not implement the PRF extension, or macOS is older than 15.
  Nothing is stored. Retry and pick a different provider in Chrome's dialog.
- **A cancelled prompt** (`NotAllowedError`, shown as *Cancelled*) means you dismissed the
  dialog or it timed out. Nothing changed; try again.
- **`KEY_MISMATCH`** on unlock ("that passkey belongs to a different entziffer key") means you
  picked the wrong passkey: the key it derives does not match the stored public key. The stored
  identity is left alone. (`FPR_MISMATCH` is a different thing — see
  [format.md](format.md#error-codes) — it means a *token* was encrypted to somebody else.)
- **If a provider refuses to create a passkey for the extension's origin**
  (`chrome-extension://…` as the RP ID), pick a different provider in Chrome's dialog — Google
  Password Manager is known to work, as is iCloud Keychain. The RP ID is the pinned extension
  id and stays that way: `RP_ID` in `packages/extension/src/shared/webauthn.ts` exists so the
  constant has one home, not as a per-user escape hatch. Changing it selects a different
  passkey and therefore derives a different key, which orphans every passkey already enrolled —
  a breaking change for every existing user, not a local workaround.

**Forget key** in the options page's danger zone removes this browser's copy of the public
data. The passkey itself stays in iCloud Keychain (delete it in the Passwords app if you mean
to destroy the key); setting up again with the same passkey returns the same key.

## 2. CLI

No install needed — `npx` fetches it per invocation:

```sh
npx entziffer@latest --version
```

Prefer it on `PATH`? `pnpm add -g entziffer` (or `npm i -g entziffer`). Every command below
works either way. `@latest` re-resolves the newest publication on every call: convenient now,
but once v0.1.0 is out, pin a version you have reviewed (`npx entziffer@0.1.x`) or install it
globally, so a future publication cannot change what your agent runs.

Register the public key from step 1 and make it the default recipient. Compare the whole
`entz1pk_…` string against the one shown in the extension — character for character, over a
channel you trust — not the short fingerprint; the 4-byte fingerprint in a token is a routing
hint ("which key is this for?"), not an identity check:

```sh
npx entziffer@latest keys add me entz1pk_...
npx entziffer@latest keys default me
npx entziffer@latest keys list
```

`keys add` creates `~/.config/entziffer/config.json` with mode `0600` when it does not exist
yet; there is no separate init step.

### Config file

`~/.config/entziffer/config.json`, mode `0600`:

```json
{
  "version": 1,
  "default": "me",
  "recipients": {
    "me": { "publicKey": "entz1pk_...", "note": "laptop chrome" }
  }
}
```

Only public keys live here; the file contains no secrets, but keep it `0600` anyway so
nothing silently swaps a recipient on you. Unknown keys are ignored with a warning on stderr.

## 3. Claude Code skill

Global — available in every repo on this machine:

```sh
cp -R skills/private-linear-issue ~/.claude/skills/
```

Per repo — commit it so your team gets it:

```sh
mkdir -p .claude/skills
cp -R /path/to/entziffer/skills/private-linear-issue .claude/skills/
```

Copy vs symlink: **copy** if the skill should keep working when this checkout moves or
disappears, and if you want it pinned to a reviewed version. **Symlink**
(`ln -s "$PWD/skills/private-linear-issue" ~/.claude/skills/private-linear-issue`) if you
are developing entziffer and want edits to take effect immediately; Claude Code follows
symlinks. Do not symlink a skill into a repo you push — teammates get a dangling link.

The skill needs the Linear MCP server connected in the same session (`/mcp` to check).

## 4. Verify the whole chain

```sh
# 1. CLI encrypts to your key
npx entziffer@latest encrypt --to me "hello from entziffer" 
# → ENTZ1:...

# 2. The envelope names your fingerprint, without decrypting anything
npx entziffer@latest inspect "ENTZ1:..."

# 3. The extension decrypts it: paste the token into any Linear issue comment box
#    preview, or a Linear issue you own, and confirm the plaintext appears in the pane.
```

Then the end-to-end test: ask Claude Code *"file a private Linear issue titled 'entziffer
smoke test' saying it worked"*. You should get an issue URL; opening it in Chrome should
show the plaintext in the pane, and opening it in a browser without the extension (or asking a
teammate) should show `ENTZ1:…`.

If step 3 shows no plaintext in Chrome:

- Check the fingerprint from `inspect` against the one in the extension popup — a token
  encrypted to the wrong recipient gets a grey tag and has no pane entry to read.
- Check that entziffer is unlocked: a pill reading *Locked* means the session is locked, not
  that the token is wrong.
- Check that the origin is enabled: open the popup on that tab, which says whether entziffer
  runs there and offers **Enable on this site** when it does not.

## Auditing instead of trusting npm

Skip the CLI entirely and use the dependency-free
[reference implementation](../reference/encrypt.mjs):

```sh
node reference/encrypt.mjs --vectors
node reference/encrypt.mjs --to entz1pk_... "text"
```

See [reference/README.md](../reference/README.md) for how to vendor and audit it.
