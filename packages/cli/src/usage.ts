export const USAGE = `entziffer - encrypt text to an entziffer public key (ENTZ1)

Usage
  entziffer encrypt [text] [--to <name|entz1pk_...>] [--stdin] [--json]
  entziffer encrypt-issue --stdin-json [--to <r>] [--json]
  entziffer encrypt-issue --title <t> [--body <b> | --body-stdin] [--to <r>] [--json]
  entziffer keys add <name> <entz1pk_...> [--note <s>] [--default]
  entziffer keys list [--json]
  entziffer keys default <name>
  entziffer keys rm <name>
  entziffer inspect <token> [--json]

Global options
  --config <path>  config file (default: $XDG_CONFIG_HOME/entziffer/config.json)
  --quiet          suppress warnings and confirmations
  --json           machine-readable output, errors as {"error":{"code","message"}}
  --version        print version
  --help           print this help

Exit codes
  0 ok  1 error  2 usage  3 config  4 unknown recipient  5 crypto  6 empty stdin

'keys add' creates the config file (mode 0600) when it does not exist yet.
Decryption lives only in the Chrome extension; this CLI never handles private keys.
`;
