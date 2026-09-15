# Contributing

## Prerequisites

- Node 22 or newer.
- pnpm 10. `corepack enable` installs the exact version pinned in `package.json`.
- Chrome 133 or newer, on macOS 15 or newer, to run the extension against a real passkey.
  Unit tests and the Playwright suite need neither macOS nor a passkey.

## Setup

```sh
git clone git@github.com:haydenshively/entziffer.git && cd entziffer
corepack enable
pnpm install
pnpm check
```

`pnpm check` is lint → build → typecheck → unit tests, in that order because the CLI and the
extension typecheck against `@entziffer/core`'s built `dist`. Run the pieces on their own as
`pnpm lint`, `pnpm build`, `pnpm typecheck`, `pnpm test`; `pnpm format` applies Biome's
formatting.

## Working on the extension

```sh
pnpm build
```

Load `packages/extension/dist` unpacked in `chrome://extensions` (Developer mode → **Load
unpacked**). The card must show ID `bgopgffcljkdlogpflimomjbfbmbaoap`; anything else means the
manifest `key` changed, which changes the WebAuthn RP ID and therefore the derived key.

There is no HMR. After a change: rebuild, press the reload button on the extension card, reload
the page under test. Popup and options changes need only the rebuild plus reopening that page.
The extension package's [README](packages/extension/README.md) covers the architecture, the
message protocol, and the test hooks.

## Tests

```sh
pnpm test                                   # Vitest, jsdom, no browser
pnpm --filter @entziffer/extension exec playwright install --with-deps chromium   # once
pnpm test:e2e                               # Playwright: builds dist-e2e/, drives real Chrome
```

## Pull requests

Branch from `master`, keep `pnpm check` green, open a PR. CI runs lint, build, typecheck, unit
tests on Node 22 and 24, and the Playwright suite, and uploads the extension zip as a workflow
artifact so reviewers can load a PR's build without checking it out.

## Releasing

Releases are driven by the version in `package.json`, not by tags. To ship:

1. Bump `version` in `packages/core/package.json` and `packages/cli/package.json` to the same
   value. Bump `packages/extension/package.json` and `packages/extension/manifest.json` too, so
   the zip and the card in `chrome://extensions` carry the same number.
2. Merge to `master`.

`.github/workflows/release.yml` then re-runs CI and, if that version is not yet on npm, publishes
`@entziffer/core` and `entziffer` with provenance. If the tag `v<version>` does not exist it
creates it, along with a GitHub release whose asset is the extension zip CI just built and
tested. The extension is `private: true` and never goes to npm; the GitHub release is its only
distribution channel while it is off the Chrome Web Store. A `master` push that changes no
version publishes nothing.

Both published packages must keep a `repository.url` pointing at this repo: npm verifies it
against the provenance statement and rejects the publish with a 422 when it is missing.

### One-time setup (repository owner)

- On npmjs.com, add a **trusted publisher** for both `entziffer` and `@entziffer/core`:
  GitHub Actions, repository `haydenshively/entziffer`, workflow `release.yml`, environment
  `release`. A package that has never been published cannot have a trusted publisher yet; its
  first version goes up with `pnpm publish -r --access public` from a maintainer's machine, after
  which the workflow takes over.
- On GitHub, create the `release` environment (Settings → Environments). Required reviewers are
  optional and gate every publish behind an approval click.
- No `NPM_TOKEN` secret is used or needed.
