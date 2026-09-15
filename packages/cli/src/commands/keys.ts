import { parseArgs } from "node:util";
import { formatFingerprint, importPublicKey } from "@entziffer/core";
import { type Config, emptyConfig, readConfig, requireConfig, writeConfig } from "../config.js";
import { CliError, EXIT_UNKNOWN_RECIPIENT, parsing, usageError } from "../errors.js";
import { json, out, warn } from "../io.js";
import { GLOBAL_OPTIONS, globals } from "../options.js";
import { USAGE } from "../usage.js";

export async function cmdKeys(args: string[]): Promise<void> {
  const { values, positionals } = parsing(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: { ...GLOBAL_OPTIONS, note: { type: "string" }, default: { type: "boolean" } },
    }),
  );
  const g = globals(values);
  if (g.help) return out(USAGE);

  const [sub, ...rest] = positionals;
  switch (sub) {
    case "add":
      return add(rest, values.note, values.default === true, g.configPath, g.quiet);
    case "list":
      return list(rest, g.configPath, g.quiet, g.json);
    case "default":
      return setDefault(rest, g.configPath, g.quiet);
    case "rm":
      return remove(rest, g.configPath, g.quiet);
    default:
      throw usageError(
        sub === undefined ? "keys needs a subcommand" : `unknown keys subcommand: ${sub}`,
      );
  }
}

function unknownRecipient(name: string): CliError {
  return new CliError("E_UNKNOWN_RECIPIENT", `unknown recipient: ${name}`, EXIT_UNKNOWN_RECIPIENT);
}

async function add(
  positionals: string[],
  note: string | undefined,
  makeDefault: boolean,
  configPath: string,
  quiet: boolean,
): Promise<void> {
  const [name, publicKey, ...extra] = positionals;
  if (name === undefined || publicKey === undefined || extra.length > 0) {
    throw usageError("usage: entziffer keys add <name> <entz1pk_...> [--note <s>] [--default]");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw usageError(`invalid recipient name: ${JSON.stringify(name)}`);
  }
  const key = await importPublicKey(publicKey);

  const cfg = readConfig(configPath, quiet) ?? emptyConfig();
  cfg.recipients[name] = note === undefined ? { publicKey } : { publicKey, note };
  if (makeDefault || cfg.default === undefined) cfg.default = name;
  writeConfig(configPath, cfg);
  warn(
    `added ${name} (${formatFingerprint(key.fpr)})${cfg.default === name ? " as default" : ""}`,
    quiet,
  );
}

async function list(
  positionals: string[],
  configPath: string,
  quiet: boolean,
  asJson: boolean,
): Promise<void> {
  if (positionals.length > 0) throw usageError("keys list takes no arguments");
  const cfg = readConfig(configPath, quiet) ?? emptyConfig();
  const rows = await Promise.all(
    Object.entries(cfg.recipients).map(async ([name, entry]) => ({
      name,
      publicKey: entry.publicKey,
      fingerprint: formatFingerprint((await importPublicKey(entry.publicKey)).fpr),
      note: entry.note ?? null,
      default: cfg.default === name,
    })),
  );
  if (asJson) {
    json({ default: cfg.default ?? null, recipients: rows });
    return;
  }
  if (rows.length === 0) {
    warn(`no recipients in ${configPath}`, quiet);
    return;
  }
  for (const row of rows) {
    const note = row.note === null ? "" : `  ${row.note}`;
    out(`${row.default ? "*" : " "} ${row.name}  ${row.fingerprint}  ${row.publicKey}${note}\n`);
  }
}

function setDefault(positionals: string[], configPath: string, quiet: boolean): void {
  const [name, ...extra] = positionals;
  if (name === undefined || extra.length > 0) {
    throw usageError("usage: entziffer keys default <name>");
  }
  const cfg: Config = requireConfig(configPath, quiet);
  if (cfg.recipients[name] === undefined) throw unknownRecipient(name);
  cfg.default = name;
  writeConfig(configPath, cfg);
  warn(`default recipient is now ${name}`, quiet);
}

function remove(positionals: string[], configPath: string, quiet: boolean): void {
  const [name, ...extra] = positionals;
  if (name === undefined || extra.length > 0) throw usageError("usage: entziffer keys rm <name>");
  const cfg: Config = requireConfig(configPath, quiet);
  if (cfg.recipients[name] === undefined) throw unknownRecipient(name);
  delete cfg.recipients[name];
  if (cfg.default === name) {
    const next = Object.keys(cfg.recipients)[0];
    if (next === undefined) {
      cfg.default = undefined;
    } else {
      cfg.default = next;
    }
  }
  writeConfig(configPath, cfg);
  warn(`removed ${name}`, quiet);
}
