# entziffer reference implementation

`encrypt.mjs` is a single file that implements the whole ENTZ1 wire format using nothing
but Node's standard library (`node:crypto`, `node:fs`, `node:process`). It exists so that
you can encrypt without trusting npm, and so that a security reviewer can read the format
in one sitting.

It is byte-for-byte identical to [`@entziffer/core`](../packages/core): given the same
ephemeral key it produces the same token, and CI runs a cross-implementation test in both
directions ([`cross-impl.test.ts`](cross-impl.test.ts)).

## Run it without npm

```sh
node encrypt.mjs --to entz1pk_... "Fix the login redirect loop"
node encrypt.mjs --to entz1pk_... --stdin < body.md
```

No install step, no `node_modules`, no network access. Node ≥ 22.

`--decrypt` is an audit aid, not part of the product — in normal use the private key lives
only inside the Chrome extension and never touches disk:

```sh
node encrypt.mjs --decrypt --key <32-byte-hex | private-key.pem> "ENTZ1:..."
```

## Audit it

1. Read [`../docs/format.md`](../docs/format.md), the normative spec.
2. Read `encrypt.mjs` top to bottom. The header comment restates the byte layout so you can
   check the code against the spec without switching files; that restatement is not
   normative — `docs/format.md` is, and it wins wherever the two disagree.
3. Verify against the published vectors:

   ```sh
   node encrypt.mjs --vectors                       # ../packages/core/test/vectors.json
   node encrypt.mjs --vectors path/to/vectors.json
   ```

   Every vector is re-encrypted with its recorded ephemeral private key and compared to
   the expected token, then decrypted back to the expected plaintext. Exit status is 0
   only if all of them match.
4. Diff the two implementations if you want to check for a discrepancy the vectors would
   miss: the derivation lives in `deriveKeyAndNonce` here and in
   `../packages/core/src/ecies.ts`.

## Vendor it into your own repo

The file is self-contained and MIT licensed. Copy it anywhere and run it:

```sh
curl -O https://raw.githubusercontent.com/haydenshively/entziffer/master/reference/encrypt.mjs
curl -O https://raw.githubusercontent.com/haydenshively/entziffer/master/packages/core/test/vectors.json
node encrypt.mjs --vectors ./vectors.json     # confirm the copy is intact
node encrypt.mjs --to entz1pk_... "text"
```

Pin the copy in git and re-run `--vectors` after any update. Nothing else in this repo is
required at runtime.
