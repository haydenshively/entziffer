# entziffer

Encrypt text — Linear issue titles and descriptions in particular — to an entziffer public key.
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
3. Encrypt an issue:

   ```sh
   entziffer encrypt-issue --stdin-json --json <<'JSON'
   {"title": "Reword the pricing page", "body": "…"}
   JSON
   ```

   Create the Linear issue with the returned strings. Linear stores ciphertext; the extension shows
   you the plaintext.

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

### `encrypt-issue --stdin-json [--to <r>] [--json]`

Encrypts a title and an optional body as two independent tokens. This is the one call the
`private-linear-issue` skill makes.

`--stdin-json` reads the whole issue from standard input as `{"title": string, "body"?: string}`,
so no plaintext ever appears in `argv` — where it would be visible to every process listing on the
machine, and to shell history. Prefer it over `--title`/`--body`/`--body-stdin`, which remain for
interactive use and cannot be combined with it:

```sh
entziffer encrypt-issue --stdin-json --json <<'JSON'
{"title": "Reword the pricing page", "body": "# Notes\n\nfrom a DM"}
JSON
```

The `--json` shape is a stable contract:

```json
{
  "title": "ENTZ1:…",
  "description": "ENTZ1:…",
  "recipient": "me",
  "fingerprint": "3697-8b57"
}
```

`description` is `null` when no body was given (`body` absent, `null`, or `""`), and `recipient` is `"literal"` when `--to` was a raw
`entz1pk_…` key. Without `--json` the command prints a `title:` line and a `description:` line.

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
plaintext byte length (ciphertext minus the 16-byte GCM tag).

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
| 6 | `--stdin` / `--body-stdin` / `--stdin-json` received nothing |

Errors always go to stderr as `entziffer: <message>`. With `--json` the same failure is additionally
printed to stdout:

```json
{ "error": { "code": "E_UNKNOWN_RECIPIENT", "message": "unknown recipient: ghost" } }
```

## Security

Encryption needs no secret, so agents and CI can encrypt freely. What is *not* protected: issue
metadata (author, timestamps, project, labels), the fact that an issue exists, and its size.
Encrypted titles are also unsearchable and unsortable in Linear. See `SECURITY.md` in the repository.
