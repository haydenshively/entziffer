# @entziffer/extension

Chrome MV3 extension that reveals the plaintext of `ENTZ1:` tokens on the sites you enable —
on hover, in a floating card, without ever modifying the page's own text. Your X25519 private
key is **derived from a passkey** on every unlock: no private key is stored between sessions,
and between sessions this profile holds only the credential id, the public key, its
fingerprint, and the derivation version. While unlocked, the derived non-extractable key lives
in this extension's IndexedDB session store and is deleted on lock, auto-lock, or browser
restart.

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
3. Enable an origin, set up the passkey, and register the public key with the CLI —
   [../../docs/install.md](../../docs/install.md) walks through all three. The extension has
   no host access until you enable an origin, and **the passkey *is* the key**: delete it from
   iCloud Keychain and every issue encrypted to it is unreadable forever.

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
with a `MutationObserver` (100 ms debounce; a burst touching more than 32 roots escalates to one
walk of `document.body`), and asks the service worker to decrypt every token it finds in one
batched round trip. Results are cached (LRU, 256 tokens) for the tab's lifetime.

- **The page's text is never modified** — not in editors, not anywhere. No node is replaced,
  split, or rewritten, so selection, wrapping and copy are the page's own and a copy always
  yields ciphertext. Tokens are marked with the CSS Custom Highlight API (`highlight.ts`),
  which styles live ranges without touching the DOM: the `ENTZ1:` marker gets a small accent
  tag — grey when this key cannot open the token — and the ciphertext body after it is faded to
  65% of its own computed colour unless it is the token under the cursor.
- **Hovering a token opens a hover card**, which is the only place plaintext exists outside the
  extension's own pages. It lives in a shadow root on a `body`-level host, renders the plaintext
  in the token's own computed typography and wrapped at its block's width, and follows the
  cursor, sitting above and to the right of it — flipping at the viewport edges — because the
  browser draws a page's own `title` tooltip below and to the right of a resting cursor. The
  glass is hand-rolled: an SVG displacement filter painted in `lens.ts`, with the open, close and
  spring-lag animation in `motion.ts`, which honours `prefers-reduced-motion`. The card holds
  text and nothing else: no buttons, no inputs. Clicking a token pins its card until Escape, or
  until the cursor finds another token.
- **Editors are never edited.** A capture-phase guard (`guard.ts`) on `beforeinput`, `keydown`,
  `paste`, `cut` and `drop` cancels any edit whose range covers or borders a token, ahead of the
  browser's and the editor's own handling, and pins that token's card instead of letting the edit
  through. Selecting and copying are left alone. A token counts as editable — and so is guarded —
  when either endpoint of its range, or any text node it crosses, sits inside `[contenteditable]`,
  `.ProseMirror`, `[role="textbox"]`, `input`, or `textarea`. This is the single most important
  safety property of the extension: Linear's title and description are ProseMirror editors, and
  rewriting their text could persist plaintext back to Linear.
- **Tokens encrypted to someone else** get the grey tag, and their card names the recipient's
  fingerprint — or, when the address book knows that fingerprint, **Encrypted for Alice ·
  1a2b-3c4d** (see
  [People](#people)). Any other failure gets the same grey tag and a card saying so.
- **A locked session** makes every token answer `LOCKED`. The tags are drawn either way, so the
  page looks the same; hovering shows a **Locked · click to unlock** card, and clicking the token
  or the card sends `requestUnlock`. `LOCKED` is deliberately kept out of the LRU cache — it
  describes the session, not the token — so the `unlocked` broadcast can simply rescan.

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

**Why an unlock window.** Opening the OS passkey dialog closes the action popup, which would
abort the ceremony, so `requestUnlock` opens (or refocuses) `unlock/index.html` as a small
popup window, centred on the window the request came from; closing itself hands focus straight
back to the tab the user was on. That page asserts with `allowCredentials:[credentialId]`,
falls back to an empty `allowCredentials` (the browser's own picker over discoverable
credentials) if that is refused, hands the PRF output to the service worker, and closes itself.
A visible button retries if the automatic attempt throws. Set-up runs on the options page for
the same reason, and follows `create()` with a `get()` when the provider withholds PRF at
creation time.

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
| `getStatus` | extension pages | `{hasKey, locked, identity, enrolledAt}` |
| `decrypt` | content script | per-token results; `{ok:false, code:"LOCKED"}` for every token while locked |
| `requestUnlock` | content script, popup, options | opens or refocuses the unlock window |
| `getUnlockParams` | unlock page | `{credentialId}` base64url, or `null` when no key is stored |
| `setupKey {credentialId, prf}` | options | derives, stores the public record, opens the session |
| `unlock {credentialId?, prf}` | unlock page | derives; `KEY_MISMATCH` unless it matches the stored public key; refreshes the stored credential id |
| `lockNow` | popup, options | clears session record, sentinel, and alarm, then broadcasts `locked` |
| `getSettings` / `setSettings` | options | the auto-lock delay below |
| `forgetKey` | options | deletes the key record and the session; the passkey itself is untouched |

`decrypt` results carry an extra `recipient` on `FPR_MISMATCH` — the address book's name for the
token's recipient, when it has one.

`decrypt` and `requestUnlock` are the only two a content script may send — `CONTENT_TYPES` in
`src/shared/messages.ts` is the allowlist, and everything outside it is refused unless
`sender.url` is an extension page, so a new request type is privileged until it is deliberately
opened up. `getUnlockParams` stays separate from `getStatus` rather than merging into it: the
stored credential id is only ever needed by the page that runs a ceremony.

The service worker broadcasts three messages — to every tab with `tabs.sendMessage`, and once
more with `runtime.sendMessage`, which is what reaches the options page and the popup. On
`unlocked`, content scripts rescan and retry their tokens. On `locked`, they flip every token
they know to the locked state in place, drop the decrypt cache, and take the card down; the
options page and popup refresh. On `people`, content scripts drop their cache and rescan, and the
options page redraws its list. No reload anywhere.

## Sites

The manifest declares **no** `host_permissions` and **no** static `content_scripts`: nothing is
special-cased, Linear included. Every site goes through the same path — the options page (or the
popup's **Enable on this site**) calls `chrome.permissions.request({origins:["https://x.com/*"]})`.
The granted host permissions *are* the allowlist: nothing is mirrored into storage, so a revoke
from `chrome://extensions` cannot leave a stale copy behind, and `enabledSites` in
`src/shared/origins.ts` derives the list from `chrome.permissions.getAll()` every time it is
needed. The service worker registers one dynamic content script covering every granted origin
(`chrome.scripting.registerContentScripts`, id `entz-enabled-origins`,
`persistAcrossSessions: false`), rebuilt from those permissions on `onStartup`, `onInstalled`,
and both `chrome.permissions` events. **Enable on all sites** requests `<all_urls>` and
collapses the registration to a single `<all_urls>` match. Removing a site from the options list
revokes its permission, which unregisters it.

The popup learns the current tab's origin from `chrome.tabs.query({active:true,
currentWindow:true})`, which returns a URL because opening the popup grants **`activeTab`** for
that tab — that is why the manifest asks for `activeTab` rather than the far broader `tabs`
permission.

## People

An address book of names for public keys, edited in the options page and stored in
`chrome.storage.sync` under `people` as `[{name, publicKey}]` — public data only, synced with the
Chrome profile, rebuilt entry by entry on read so malformed rows are dropped. Fingerprints are
derived from the keys, never stored. Pasting the CLI's `~/.config/entziffer/config.json` into the
key field imports every recipient it names, which is what keeps the two books agreeing.

The service worker resolves the name at decrypt time and returns it as `recipient` on an
`FPR_MISMATCH` result, so the content script never reads storage; a change to the book broadcasts
`people`, on which open tabs drop their cache and rescan.

Because everyone encrypts to their own key, "encrypted for Alice" is in practice "Alice's
message" — but **a fingerprint is a routing hint the sender chose, not authentication**. Anyone
can label a token with any fingerprint and four bytes collide, so the card only ever says whose a
token is, never who it came from, and two entries sharing a fingerprint are shown joined with
"or".

## Settings

One setting, stored in `chrome.storage.local` under `settings` and rebuilt field by field on
read, so fields older builds wrote are dropped rather than carried forward. Every page reacts to
a change without an extension reload.

| Setting | Meaning |
| --- | --- |
| `autoLockMinutes` | Inactivity minutes before a passkey-protected key re-locks: 60, 240, 720 (default), or 1440. `setSettings` rejects anything else. |

`chrome.storage.local` also carries `keyStorageReset`, the one-time notice about dropped pre-v3
records.

## Tests

```sh
pnpm test       # repo root: Vitest, no browser needed
pnpm test:e2e   # Playwright, builds dist-e2e/ first
```

Unit tests (jsdom, plus `fake-indexeddb` for the keystore) cover token discovery — including
tokens split across text nodes and inline elements and the `isEditable` table — splitting a token
into its tag and body, the pointer hit-testing that decides which token is hovered (the gap
between the lines of a wrapped token included), the card's mount/show/teardown and its refusal to
hold anything but text, the displacement map behind the glass, the dynamic script registration,
the session lock and its alarm, the settings round trip, the address book's validation and
fingerprint lookup, the message allowlist, and a lock landing
while a decrypt is in flight (the reply is dropped, nothing is cached, no plaintext is shown).

The Playwright suite launches `chromium.launchPersistentContext` with
`channel: "chromium"` and `--load-extension`, which supports extensions **headless** on
Playwright 1.63; no `headless: false` and no `xvfb` are needed in CI. It seeds a key through a test-only
hook on the service worker (`__entzSeedFromPrf`, fixed fake PRF bytes standing in for a
ceremony), compiled in only when `import.meta.env.VITE_E2E === "1"`; the fixture server derives
the same key with `node:crypto` and encrypts the fixture's tokens to it. It asserts, among other
things, that every text node on the page stays byte-identical to the ciphertext, editable or not,
that no plaintext exists anywhere until a token is hovered, and that a real ProseMirror editor's
own keymap never sees the refused edit.

Passkey coverage is in two layers. The hook-driven tests (`__entzSeedFromPrf`,
`__entzUnlockWithPrf`, `__entzLockNow`, `__entzRunStartupHandler`) assert the whole
locked→card→unlock→decrypt→lock cycle, that another passkey's PRF output does not unlock,
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
- Quit Chrome completely, reopen Linear, hover a token, and confirm the **Locked · click to
  unlock** card appears and Touch ID decrypts the page.
- Confirm a second Mac signed into the same iCloud account recovers the identical public key
  with **I already have an entziffer passkey**.
- Copy the profile directory to another user account and confirm nothing decrypts there.

`test:e2e` therefore builds a separate **`dist-e2e/`** output (`node scripts/build.mjs --e2e`)
rather than reusing `dist/`. That build differs from the shipping one only in ways the fixture
needs: the service-worker test hooks are compiled in, sourcemaps are emitted, the name becomes
`entziffer (e2e)`, a ProseMirror fixture editor is bundled alongside, and `http://127.0.0.1/*`
is written into `host_permissions` plus a static `content_scripts` entry, so the fixture — served
by a tiny `node:http` server, because Chrome never injects content scripts into `file://` pages —
is in scope without going through the allowlist UI. The shipping `dist/manifest.json` is a
byte-for-byte copy of `manifest.json`, which declares neither.

## Layout

```
manifest.json                  copied verbatim into dist/
icons/icon{16,48,128}.png      static, emitted into dist/icons/
scripts/build.mjs              both Vite configs (ESM pages + IIFE content script) and the driver
scripts/zip.mjs                release zip
src/shared/messages.ts         typed request/response protocol
src/shared/origins.ts          enabled sites, derived from the granted host permissions
src/shared/people.ts           the address book: storage, validation, fingerprint lookup
src/sw/{index,keystore,session,settings,scripts,broadcast}.ts
src/content/{index,scan,hit,guard,highlight,pane,lens,motion,cache,shadow}.ts + styles.css
src/options/, src/popup/, src/unlock/
src/shared/webauthn.ts         create/get ceremonies, RP_ID, PRF extraction
test/*.test.ts                 Vitest (jsdom)
test/e2e/                      Playwright spec, fixture, fixture server, fixture ProseMirror editor
```

`scripts/build.mjs` holds both inline Vite configs and runs them in turn with an explicit
`outDir` and `e2e` flag — the pages bundle (ESM, code-split) first, then the content script
(one IIFE, CSS inlined) into the same directory, plus the fixture editor on E2E builds. The
manifest and the icons are emitted by a small plugin, so there is no `publicDir`.
