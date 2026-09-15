# entziffer

Encrypt text — an issue title and description, a wiki paragraph, a chat message — to an entziffer
public key.
The CLI only ever *encrypts*; the private key lives exclusively in the
[entziffer Chrome extension](https://github.com/haydenshively/entziffer), which decrypts matching
`ENTZ1:` tokens in place on the sites you enable there. There is no `keygen` and no `decrypt` here, by
design.

The published bundle inlines `@entziffer/core`, so nothing else is loaded at runtime. Node >= 22, ESM.

## Install

```sh
npx entziffer@latest --help     # no install
npm i -g entziffer              # or install the binary
```

## Quick start

1. Install the Chrome extension, open its options page, and generate a key. It shows a public key
   string like `entz1pk_…`.
2. Register it:

   ```sh
   entziffer keys add me entz1pk_… --note "work laptop"
   ```

   The first key you add becomes the default recipient.
3. Encrypt some fields:

   ```sh
   entziffer encrypt-json --json <<'JSON'
   {"title": "Reword the pricing page", "body": "…"}
   JSON
   ```

   Put the returned strings into the fields of whatever tool you use — a Linear or GitHub issue,
   say. The service stores ciphertext; the extension shows you the plaintext.

## Commands

### `encrypt [text] [--to <name|entz1pk_...>] [--stdin] [--json]`

Prints one token, followed by a newline. Text comes from the positional argument or, with
`--stdin`, from standard input (one trailing newline is dropped). `--to` accepts a configured
recipient name or a literal `entz1pk_…` string; a literal key needs no config file at all. Omitting
`--to` uses the configured default. ENTZ1 v1 encrypts to exactly one recipient, so passing `--to`
twice — or a comma-separated list — fails with `E_MULTI_UNSUPPORTED`.

With `--json`:

```json
{ "token": "ENTZ1:…", "recipient": "me", "fingerprint": "3697-8b57" }
```

### `encrypt-json [--to <name|entz1pk_...>] [--json]`

Encrypts several fields in one call, each to its own independent token — the shape an agent needs
when it fills in a form or files a record on your behalf. Input is always standard input, so no
plaintext ever appears in `argv`, where it would be visible to every process listing on the machine
and to shell history. It must be a one-level JSON object whose values are strings or `null`:

```sh
entziffer encrypt-json --json <<'JSON'
{"title": "Reword the pricing page", "body": "# Notes\n\nfrom a DM", "footnote": null}
JSON
```

The `--json` shape is a stable contract; `fields` keeps the input's keys and order:

```json
{
  "fields": { "title": "ENTZ1:…", "body": "ENTZ1:…", "footnote": null },
  "recipient": "me",
  "fingerprint": "3697-8b57"
}
```

A `null` value passes through as `null`; an empty string is encrypted like any other. `recipient`
is `"literal"` when `--to` was a raw `entz1pk_…` key. Without `--json` the command prints one
`<key>: <token>` line per field. Nested objects, arrays, and numbers are a usage error.

### `keys add <name> <entz1pk_...> [--note <s>] [--default]`

Validates the key, stores it, and makes it the default if it is the first one (or if `--default` is
passed). Creates the config file (mode `0600`) when it does not exist yet.

### `keys list [--json]`

Text output is `<* if default> <name>  <fingerprint>  <public key>  <note>`. JSON output is
`{"default": "me" | null, "recipients": [{"name","publicKey","fingerprint","note","default"}]}`.

### `keys default <name>` / `keys rm <name>`

Switch or remove a recipient. Removing the default promotes another recipient when one remains.

### `inspect <token> [--json]`

Parses a token without decrypting it: version, recipient fingerprint, ciphertext size, and the
plaintext byte length (ciphertext minus the 16-byte GCM tag). The report also names the
name the token is encrypted for when the fingerprint matches a key in `keys list` —
`recipient: alice` in text, `"recipient": "alice"` in JSON, `unknown`/`null` when nothing matches,
and every matching name joined with ` or ` when several share a key. The fingerprint is a routing
hint, not an identity check.

## Configuration

Default path: `$XDG_CONFIG_HOME/entziffer/config.json`, else `~/.config/entziffer/config.json`.
Override per invocation with `--config <path>`.

```json
{
  "version": 1,
  "default": "me",
  "recipients": {
    "me": { "publicKey": "entz1pk_…", "note": "work laptop" }
  }
}
```

`keys add` creates the file with mode `0600` when it is missing; the CLI warns on stderr when an
existing file is group- or world-readable, and when it holds a key it does not recognise (unknown
keys are ignored, not an error).

Global options: `--config <path>`, `--quiet` (suppress warnings and confirmations), `--json`,
`--version`, `--help`.

## Exit codes

| code | meaning |
| ---- | ------- |
| 0 | success |
| 1 | generic failure |
| 2 | usage error, including more than one recipient |
| 3 | config missing, invalid, or without a default recipient |
| 4 | unknown recipient name |
| 5 | crypto or token failure (bad key string, malformed token) |
| 6 | `--stdin` or `encrypt-json` received nothing |

Errors always go to stderr as `entziffer: <message>`. With `--json` the same failure is additionally
printed to stdout:

```json
{ "error": { "code": "E_UNKNOWN_RECIPIENT", "message": "unknown recipient: ghost" } }
```

## Security

Encryption needs no secret, so agents and CI can encrypt freely. What is *not* protected: issue
metadata (author, timestamps, project, labels), the fact that an issue exists, and its size.
Encrypted titles are also unsearchable and unsortable in the host application. See `SECURITY.md` in
the repository.
