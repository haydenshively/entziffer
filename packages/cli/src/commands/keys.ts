import { formatFingerprint, importPublicKey } from "@entziffer/core";
import { type Config, emptyConfig, readConfig, requireConfig, writeConfig } from "../config.js";
import { CliError, EXIT_UNKNOWN_RECIPIENT, usageError } from "../errors.js";
import { json, out, warn } from "../io.js";
import { parseCommand } from "../options.js";
import { fingerprintOf } from "../recipient.js";
import { USAGE } from "../usage.js";

export async function cmdKeys(args: string[]): Promise<void> {
  const { values, positionals, configPath, ...g } = parseCommand(args, {
    note: { type: "string" },
    default: { type: "boolean" },
  });
  if (g.help) return out(USAGE);

  const [sub, ...rest] = positionals;
  switch (sub) {
    case "add":
      return add(rest, values.note, values.default === true, configPath);
    case "list":
      return list(rest, configPath, g.json);
    case "default":
      return setDefault(rest, configPath);
    case "rm":
      return remove(rest, configPath);
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
): Promise<void> {
  const [name, publicKey, ...extra] = positionals;
  if (name === undefined || publicKey === undefined || extra.length > 0) {
    throw usageError("usage: entziffer keys add <name> <entz1pk_...> [--note <s>] [--default]");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw usageError(`invalid recipient name: ${JSON.stringify(name)}`);
  }
  const key = await importPublicKey(publicKey);

  const cfg = readConfig(configPath) ?? emptyConfig();
  cfg.recipients[name] = note === undefined ? { publicKey } : { publicKey, note };
  if (makeDefault || cfg.default === undefined) cfg.default = name;
  writeConfig(configPath, cfg);
  warn(`added ${name} (${formatFingerprint(key.fpr)})${cfg.default === name ? " as default" : ""}`);
}

async function list(positionals: string[], configPath: string, asJson: boolean): Promise<void> {
  if (positionals.length > 0) throw usageError("keys list takes no arguments");
  const cfg = readConfig(configPath) ?? emptyConfig();
  const rows = await Promise.all(
    Object.entries(cfg.recipients).map(async ([name, entry]) => ({
      name,
      publicKey: entry.publicKey,
      fingerprint: await fingerprintOf(entry.publicKey),
      note: entry.note ?? null,
      default: cfg.default === name,
    })),
  );
  if (asJson) {
    json({ default: cfg.default ?? null, recipients: rows });
    return;
  }
  if (rows.length === 0) {
    warn(`no recipients in ${configPath}`);
    return;
  }
  for (const row of rows) {
    const note = row.note === null ? "" : `  ${row.note}`;
    const fpr = row.fingerprint ?? "invalid";
    out(`${row.default ? "*" : " "} ${row.name}  ${fpr}  ${row.publicKey}${note}\n`);
  }
}

function setDefault(positionals: string[], configPath: string): void {
  const [name, ...extra] = positionals;
  if (name === undefined || extra.length > 0) {
    throw usageError("usage: entziffer keys default <name>");
  }
  const cfg: Config = requireConfig(configPath);
  if (cfg.recipients[name] === undefined) throw unknownRecipient(name);
  cfg.default = name;
  writeConfig(configPath, cfg);
  warn(`default recipient is now ${name}`);
}

function remove(positionals: string[], configPath: string): void {
  const [name, ...extra] = positionals;
  if (name === undefined || extra.length > 0) throw usageError("usage: entziffer keys rm <name>");
  const cfg: Config = requireConfig(configPath);
  if (cfg.recipients[name] === undefined) throw unknownRecipient(name);
  delete cfg.recipients[name];
  const reassigned = cfg.default === name;
  if (reassigned) cfg.default = Object.keys(cfg.recipients)[0];
  writeConfig(configPath, cfg);
  warn(`removed ${name}`);
  if (reassigned) {
    warn(
      cfg.default === undefined
        ? "no default recipient"
        : `default recipient is now ${cfg.default}`,
    );
  }
}
