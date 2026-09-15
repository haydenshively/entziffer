# @entziffer/extension

Chrome MV3 extension that decrypts `ENTZ1:` tokens in place on the sites you enable. Your X25519 private key is
**derived from a passkey** on every unlock: no private key is stored between sessions, and
between sessions this profile holds only the credential id, the public key, its fingerprint,
and the derivation version. While unlocked, the derived non-extractable key lives in this
extension's IndexedDB session store and is deleted on lock, auto-lock, or browser restart.

Requires **Chrome 133 or newer**, **macOS 15 or newer**, and a PRF-capable passkey provider
(iCloud Keychain) — see [../../docs/install.md](../../docs/install.md).

## Build and load unpacked

```sh
pnpm install                     # from the repo root
pnpm --filter @entziffer/core build
pnpm --filter @entziffer/extension build
```

Then in Chrome:

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → select `packages/extension/dist`. The card must show ID
   `bgopgffcljkdlogpflimomjbfbmbaoap` (see below); anything else means the manifest key is wrong.
3. Open the extension's options page → **Sites** → enable an origin (`https://linear.app`, say);
   the extension has no host access until you do. Then **Set up with Touch ID** → copy the
   `entz1pk_…` string.
4. **Keep the passkey.** It *is* the key: delete it from iCloud Keychain and every issue
   encrypted to it is unreadable forever. A second Mac on the same iCloud account recovers
   the key with **I already have an entziffer passkey**.
5. Register the public key with the CLI on any machine that creates issues:
   `npx entziffer keys add me entz1pk_…`

### Dev loop

There is no HMR — content scripts and service workers are reloaded by Chrome, not by Vite.
Re-run `pnpm --filter @entziffer/extension build`, then press the reload button on the
extension card in `chrome://extensions` and reload the page under test. Editing only the
options or popup page needs a rebuild plus reopening that page, not an extension reload.

`pnpm zip` rebuilds `dist/` and produces `entziffer-extension-<version>.zip` next to this
README, ready for a GitHub release. It shells out to the `zip` CLI, which is preinstalled on
macOS and on GitHub-hosted Linux runners.

## How it behaves on a page

The content script runs only on origins the user enabled (see [Sites](#sites)), watches the DOM
with a `MutationObserver` (100 ms debounce), and asks the service worker to decrypt every token
it finds in one batched round trip. Results are cached (LRU, 2000 tokens) for the tab's lifetime.

- **Inert text** (list rows, board cards, notifications) is **replaced in place** with
  `<span data-entz-plain data-entz-ct="ENTZ1:…">`, so selection, wrapping, and copy all work
  normally. The span inherits the surrounding typography and carries one fixed, theme-neutral
  indicator — a thin dotted underline in the text's own colour — and nothing else; there is no
  setting for it. Multi-line descriptions render with `white-space: pre-wrap`. Hovering for
  400 ms opens a popover with the plaintext plus **Copy plaintext** and **Copy ciphertext**.
- **Editors are never touched.** A token counts as editable when either endpoint of its range
  — or any text node it crosses — sits inside `[contenteditable]`, `.ProseMirror`,
  `[role="textbox"]`, `input`, or `textarea`. Such a token keeps its exact ciphertext in the DOM; the
  plaintext is drawn on top in a shadow-DOM overlay pinned to the token's bounding rect.
  Click the overlay or press `Esc` to reveal the ciphertext for editing. An element that turns
  editable later is caught too: the observer watches `contenteditable` and immediately puts the
  ciphertext back under it. This is the single most important safety property of the extension — Linear's title and description are
  ProseMirror editors, and rewriting their text could persist plaintext back to Linear.
- **Tokens encrypted to someone else** get a small lock badge titled with their fingerprint;
  the ciphertext is left as is. Any other failure leaves the text untouched and silent.
- **A locked session** makes every token answer `LOCKED`. The page then shows
  exactly **one** 🔐 badge, titled *Click to unlock entziffer*, never inside an editable
  region and never in overlay-only mode (which only records the state for the popup).
  Clicking it sends `requestUnlock`. `LOCKED` is deliberately kept out of the LRU cache — it
  describes the session, not the token — so the `unlocked` broadcast can simply clear the
  badge and rescan.

## Key derivation and the session model

The keystore (DB version 4) holds exactly one record, and no private key:

```
{ id:"self", credentialId: ArrayBuffer, publicRaw, fpr, enrolledAt, derivation }
```

`derivation` is `@entziffer/core`'s `DERIVATION_VERSION`. Unlock refuses a record enrolled
under any other version rather than reinterpreting the passkey under a newer scheme.

Every unlock runs a WebAuthn assertion with `extensions:{prf:{eval:{first: FIXED_PRF_SALT}}}`
and `userVerification:"required"`, and `@entziffer/core`'s `deriveKeyFromPrf` turns the PRF
output into the X25519 key — the same key every time, on every device the passkey syncs to.
The second `session` store holds `{id:"unlocked", privateKey, unlockedAt}`. Records written by
DB versions 1 and 2 held a private key no passkey can reproduce, so `onupgradeneeded` deletes
them and sets `keyStorageReset` in `chrome.storage.local`; the options page shows a one-time
notice.

**Why an unlock tab.** Opening the OS passkey dialog closes the action popup, which would
abort the ceremony, so `requestUnlock` opens (or focuses) `unlock/index.html` in a tab. That
page asserts with `allowCredentials:[credentialId]`, falls back to an empty `allowCredentials`
(the browser's own picker over discoverable credentials) if that is refused, hands the PRF
output to the service worker, and closes itself. A visible button retries if the automatic
attempt throws. Set-up runs on the options page for the same reason, and follows `create()`
with a `get()` when the provider withholds PRF at creation time.

**Why the session key is in IndexedDB.** `chrome.storage.session` is JSON-only and cannot
hold a CryptoKey. The derived key therefore lives in the `session` store, with a boolean
sentinel in `chrome.storage.session` next to it: a session record whose sentinel is gone
(browser restart, extension reload) is stale and is deleted rather than used. It is also
cleared on `onStartup`, `onInstalled`, `lockNow`, and a `chrome.alarms` inactivity alarm
(`autoLockMinutes`, one of 60/240/720/1440, default 720). This is documented honestly in
[../../docs/threat-model.md](../../docs/threat-model.md): there is nothing to steal at rest,
but a live unlocked session is as exposed as ever.

**RP ID.** `RP_ID` in `src/shared/webauthn.ts` is `undefined`, so the browser uses the
extension origin. Changing it changes which passkey is selected, and therefore the derived
key.

**Pinned extension ID.** Because the origin is the RP ID, an unpacked extension whose ID
follows its install path would hand every machine a different RP and break cross-Mac
recovery. `manifest.json` therefore carries a `"key"`: the base64 DER SPKI of an RSA-2048
public key, which fixes the ID at

```
bgopgffcljkdlogpflimomjbfbmbaoap
```

exported as `EXTENSION_ID` from `src/shared/identity.ts` and asserted in the E2E suite. Only
the *public* half is in the repo — that is all Chrome needs to derive the ID for a
load-unpacked or zipped build. The matching private key is only used for Chrome Web Store
`.crx` packaging, which this project does not do; it was generated once, never committed, and
discarded. Changing the `"key"` changes the ID, changes the RP, and orphans every passkey
enrolled under the old one.

### Messages

| Message | From | Effect |
| --- | --- | --- |
| `getStatus` | anywhere | `{hasKey, locked, identity, enrolledAt}` |
| `decrypt` | content script | per-token results; `{ok:false, code:"LOCKED"}` for every token while locked |
| `requestUnlock` | content script, popup | opens or focuses the unlock tab |
| `getUnlockParams` | extension pages | `{credentialId}` base64url, or `null` when no key is stored |
| `setupKey {credentialId, prf}` | options | derives, stores the public record, opens the session |
| `unlock {credentialId?, prf}` | unlock page, options | derives; `KEY_MISMATCH` unless it matches the stored public key; refreshes the stored credential id |
| `lockNow` | extension pages | clears session record, sentinel, and alarm, then broadcasts `locked` |
| `forgetKey` | options | deletes the key record and the session; the passkey itself is untouched |

Everything but `getStatus`, `decrypt`, `requestUnlock` and the settings pair is refused
unless `sender.url` is an extension page. `getUnlockParams` stays separate from `getStatus`
rather than merging into it: it returns the stored `credentialId`, which only the unlock and
options pages may see, whereas `getStatus` is readable from any content script.

The service worker broadcasts two messages to every tab: `unlocked`, after which content
scripts retry their tokens, and `locked`, on which they destroy overlays, drop the decrypt
cache, revert every in-place replacement to ciphertext, and show the single 🔐 badge — no
reload needed.

## Sites

The manifest declares **no** `host_permissions` and **no** static `content_scripts`: nothing is
special-cased, Linear included. Every site goes through the same path — the options page (or the
popup's **Enable on this site**) calls `chrome.permissions.request({origins:["https://x.com/*"]})`
and stores the origin in `enabledOrigins`; the service worker then registers one dynamic content
script for every enabled origin whose permission is still held
(`chrome.scripting.registerContentScripts`, id `entz-enabled-origins`, re-synced on
`onStartup`, `onInstalled`, and both `chrome.permissions` events). **Enable on all sites**
requests `<all_urls>` and registers a single `<all_urls>` match instead. Removing a site from
the options list also revokes its permission.

The popup learns the current tab's origin from `chrome.tabs.query({active:true,
currentWindow:true})`, which returns a URL because opening the popup grants **`activeTab`** for
that tab — that is why the manifest asks for `activeTab` rather than the far broader `tabs`
permission.

## Settings

Stored in `chrome.storage.local`; every page reacts to changes without an extension reload —
turning on `overlayOnly` reverts every in-place replacement to ciphertext on the spot, no page
reload needed.

| Setting | Meaning |
| --- | --- |
| `overlayOnly` | Kill switch: never modify page text, use an overlay everywhere. |
| `enabledOrigins` | The allowlist above. |
| `allSites` | `<all_urls>` was granted via **Enable on all sites**. |
| `autoLockMinutes` | Inactivity minutes before a passkey-protected key re-locks: 60, 240, 720 (default), or 1440. `setSettings` rejects anything else. |

## Tests

```sh
pnpm test       # repo root: Vitest, no browser needed
pnpm test:e2e   # Playwright, builds dist-e2e/ first
```

Unit tests (jsdom, plus `fake-indexeddb` for the keystore) cover token discovery — including tokens split across text nodes and
inline elements and the `isEditable` table — the in-place replacement,
asserting that a `contenteditable` is left byte-identical even when a token merely crosses one,
reverting replacements back to ciphertext, and the observer's reaction to an ancestor becoming
editable.

The Playwright suite launches `chromium.launchPersistentContext` with
`channel: "chromium"` and `--load-extension`, which supports extensions **headless** on
Playwright 1.63; no `headless: false` and no `xvfb` are needed in CI. It seeds a key through a test-only
hook on the service worker (`__entzSeedFromPrf`, fixed fake PRF bytes standing in for a
ceremony), compiled in only when `import.meta.env.VITE_E2E === "1"`; the fixture server derives
the same key with `node:crypto` and encrypts the fixture's tokens to it.

Passkey coverage is in two layers. The hook-driven tests (`__entzSeedFromPrf`,
`__entzUnlockWithPrf`, `__entzLockNow`, `__entzRunStartupHandler`) assert the whole
locked→badge→unlock→decrypt→lock cycle, that another passkey's PRF output does not unlock,
that the startup handler empties the session store, and that a session record without its
sentinel never unlocks. On top of that, two tests drive **real ceremonies**: Chrome's CDP
virtual authenticator supports the PRF extension (`WebAuthn.addVirtualAuthenticator` with
`hasPrf: true`) and discoverable credentials, so set-up, unlock, and the empty-`allowCredentials`
recovery flow all run through actual `credentials.create`/`get` calls. The credential is bound
to the tab's virtual authenticator and does not survive a transfer to another target, so those
tests keep every ceremony in the *same* tab.

### Manual checklist (things no virtual authenticator can prove)

- Set up against **iCloud Keychain** on macOS 15+ and confirm the extension-origin RP ID is
  accepted and PRF comes back at `create()` and at `get()`.
- Quit Chrome completely, reopen Linear, and confirm the 🔐 badge appears and Touch ID
  decrypts the page.
- Confirm a second Mac signed into the same iCloud account recovers the identical public key
  with **I already have an entziffer passkey**.
- Copy the profile directory to another user account and confirm nothing decrypts there.

`test:e2e` therefore builds a separate **`dist-e2e/`** output (`node scripts/build.mjs --e2e`)
rather than reusing `dist/`. That build differs from the shipping one in exactly two ways: the
service-worker test hooks are included, and `http://127.0.0.1/*` is written into
`host_permissions` plus a static `content_scripts` entry, so the fixture — served by a tiny
`node:http` server, because Chrome never injects content scripts into `file://` pages — is in
scope without going through the allowlist UI. The shipping `dist/manifest.json` is a
byte-for-byte copy of `manifest.json`, which declares neither.

## Layout

```
manifest.json                  copied verbatim into dist/
icons/icon{16,48,128}.png      static, emitted into dist/icons/
scripts/build.mjs              both Vite configs (ESM pages + IIFE content script) and the driver
scripts/zip.mjs                release zip
src/shared/messages.ts         typed request/response protocol
src/sw/{index,keystore,session,settings}.ts
src/content/{index,scan,render,overlay,popover,shadow}.ts + styles.css
src/options/, src/popup/, src/unlock/
src/shared/webauthn.ts         create/get ceremonies, RP_ID, PRF extraction
test/*.test.ts                 Vitest (jsdom)
test/e2e/                      Playwright spec, fixture, fixture server
```

`scripts/build.mjs` holds both inline Vite configs and runs them in turn with an explicit
`outDir` and `e2e` flag — the pages bundle (ESM, code-split) first, then the content script
(one IIFE, CSS inlined) into the same directory. The manifest and the icons are emitted by a
small plugin, so there is no `publicDir`.
