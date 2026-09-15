---
name: private-linear-issue
description: Create a Linear issue whose title and description are encrypted so nobody else in the workspace can read them. Use whenever the user asks for a private, confidential, secret, sensitive, or encrypted Linear issue or ticket, says something like "don't want this visible to the org", "hide this from the team", "Linear has no private issues", "encrypt this before filing it", or asks to file candid notes (e.g. sourced from a Slack DM or a 1:1) in Linear. Encrypts with the entziffer CLI before anything reaches Linear.
---

# Private Linear issue

Linear has no private issues. This skill files an issue whose **title and description are
ENTZ1 ciphertext**, readable only by the key holder's Chrome extension. Everything else
about the issue (author, timestamps, team, project, labels, comments) stays visible to the
whole workspace.

## Preconditions — check both before writing anything

1. `npx entziffer@latest --version` exits 0.
2. `~/.config/entziffer/config.json` exists and has a `default` recipient:
   `cat ~/.config/entziffer/config.json`.

If either check fails, **stop**. Print the setup steps from `docs/install.md`
(install the Chrome extension from the GitHub release; on its options page enable
`https://linear.app` under *Sites* — the extension runs on no site until you do — then click
*Set up with Touch ID*, or *I already have an entziffer passkey* on a second Mac; then
`npx entziffer@latest keys add me entz1pk_...` and `npx entziffer@latest keys default me`)
and let the user do it. `keys add` creates the config file itself.

**Never generate, request, or store a private key on the user's behalf.** There is no private
key to hold: the extension derives it from the user's passkey, and the CLI only ever needs a
public key.

## Workflow

1. Compose the title (one line) and the body (markdown) from the conversation. Keep them
   in your own context only — do not write them to a file, a scratchpad the user did not
   ask for, or any Linear field.
2. Encrypt. Pass the whole issue on stdin as JSON — **never** as `--title`/`--body`, which
   would put the plaintext in `argv`, where it is visible to every process listing on the
   machine and to shell history:

   ```sh
   npx entziffer@latest encrypt-issue --stdin-json --json <<'JSON'
   {"title": "<plaintext title>", "body": "<plaintext body>"}
   JSON
   ```

   The payload must be valid JSON: escape quotes, backslashes, and newlines inside the
   strings (a body's newlines become `\n`). Omit `body` for a title-only issue. Piping the
   same JSON in from another command works equally well.

   Output: `{"title":"ENTZ1:...","description":"ENTZ1:..."|null,"recipient":"me","fingerprint":"a1b2-c3d4"}`.
   Exit codes: 2 usage, 3 config, 4 unknown recipient, 5 crypto, 6 empty stdin.
3. Create the issue with the Linear MCP `save_issue` tool, using the returned strings
   **verbatim** as `title` and `description`. Ask the user for the team (and project, if
   they want one) rather than guessing. If the workspace already has a label named
   `private` (check with `list_issue_labels`), attach it; do not create one unprompted.
   Field names and the GraphQL fallback are in [reference/linear.md](reference/linear.md).
4. Report only the issue identifier and URL, plus the recipient fingerprint you encrypted
   to, so the user can confirm it matches their extension. Do not restate the plaintext in
   your summary unless the user asks you to.

## Hygiene rules — these are the point of the skill

- **Never** put the plaintext, a summary, a paraphrase, a translation, or a "hint" of it
  into any unencrypted Linear field: title, description, comments, label names, project or
  milestone names, branch names, attachment titles, or attachment bodies.
- **Never** write the plaintext into a commit message, PR title/body, or a file in the
  repo.
- **Never** echo the plaintext into a Linear comment later, including when following up on
  the issue. If a comment needs to carry sensitive text, encrypt it the same way with
  `npx entziffer@latest encrypt --stdin`, again passing the text on stdin.
- Treat ciphertext as opaque: never truncate it, wrap it, insert whitespace or newlines,
  reformat it, put it in a markdown code fence with added characters, or "clean it up".
  Copy the exact string. The extension stops reading a token at the first character
  outside `[A-Za-z0-9_-]`.
- A ciphertext title is unsearchable and unsortable in Linear. That is expected; do not
  add a plaintext "search hint" to compensate.
- If `encrypt-issue` fails for any reason, **stop and report the error**. Never fall back
  to filing the issue in plaintext, and never retry with a shortened or redacted version.
- If the user asks to see the plaintext back, tell them to open the issue in Chrome with
  the extension installed; do not decrypt it yourself (you have no private key, by design).

## Notes

- `npx entziffer@latest` resolves the newest published CLI on every call, which costs a
  network round trip and means each run trusts whatever was published last. Once v0.1.0 is
  out, install a reviewed version once (`npm i -g entziffer`, or `npx entziffer@0.1.x`) and
  replace `npx entziffer@latest` throughout this file with that command.
- `--to <name|entz1pk_...>` overrides the default recipient. v1 encrypts to exactly one
  recipient; a second person cannot be added after the fact.
- Remind the user once that their passkey *is* the key: deleting it from iCloud Keychain, or
  losing the Apple account that syncs it, loses every issue encrypted to it, permanently.
  There is no backup file to keep.
- Threat model and what is *not* protected: `SECURITY.md` / `docs/threat-model.md`.
