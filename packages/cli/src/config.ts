import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError, EXIT_CONFIG } from "./errors.js";
import { warn } from "./io.js";

export const CONFIG_VERSION = 1;
export const CONFIG_MODE = 0o600;

export interface RecipientEntry {
  publicKey: string;
  note?: string;
}

export interface Config {
  version: typeof CONFIG_VERSION;
  default?: string;
  recipients: Record<string, RecipientEntry>;
}

const KNOWN_KEYS = new Set(["version", "default", "recipients"]);

export function defaultConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "entziffer", "config.json");
}

export function emptyConfig(): Config {
  return { version: CONFIG_VERSION, recipients: {} };
}

function configError(path: string, detail: string): CliError {
  return new CliError("E_CONFIG", `invalid config at ${path}: ${detail}`, EXIT_CONFIG);
}

export function readConfig(path: string): Config | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CliError("E_CONFIG", `cannot read config at ${path}: ${String(e)}`, EXIT_CONFIG);
  }
  warnIfPermissive(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw configError(path, e instanceof Error ? e.message : String(e));
  }
  return validate(parsed, path);
}

export function requireConfig(path: string): Config {
  const cfg = readConfig(path);
  if (cfg === null) {
    throw new CliError(
      "E_CONFIG_MISSING",
      `no config at ${path}; run 'entziffer keys add <name> <entz1pk_...>'`,
      EXIT_CONFIG,
    );
  }
  return cfg;
}

function validate(parsed: unknown, path: string): Config {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw configError(path, "expected a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  if (o.version !== CONFIG_VERSION) throw configError(path, `expected version ${CONFIG_VERSION}`);
  for (const key of Object.keys(o)) {
    if (!KNOWN_KEYS.has(key)) warn(`ignoring unknown config key '${key}' in ${path}`);
  }
  const recipients: Record<string, RecipientEntry> = {};
  if (o.recipients !== undefined) {
    if (typeof o.recipients !== "object" || o.recipients === null || Array.isArray(o.recipients)) {
      throw configError(path, "'recipients' must be an object");
    }
    for (const [name, value] of Object.entries(o.recipients as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) {
        throw configError(path, `recipient '${name}' must be an object`);
      }
      const entry = value as Record<string, unknown>;
      if (typeof entry.publicKey !== "string") {
        throw configError(path, `recipient '${name}' is missing 'publicKey'`);
      }
      if (entry.note !== undefined && typeof entry.note !== "string") {
        throw configError(path, `recipient '${name}' has a non-string 'note'`);
      }
      recipients[name] =
        entry.note === undefined
          ? { publicKey: entry.publicKey }
          : { publicKey: entry.publicKey, note: entry.note };
    }
  }
  const cfg: Config = { version: CONFIG_VERSION, recipients };
  if (o.default !== undefined) {
    if (typeof o.default !== "string") throw configError(path, "'default' must be a string");
    cfg.default = o.default;
  }
  return cfg;
}

export function writeConfig(path: string, cfg: Config): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  // writeFileSync's `mode` is masked by umask and only applies when the file is created, so the
  // chmod is what actually guarantees 0600.
  // https://nodejs.org/api/fs.html#fswritefilesyncfile-data-options
  chmodSync(tmp, CONFIG_MODE);
  renameSync(tmp, path);
}

export function warnIfPermissive(path: string): void {
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      warn(`config ${path} is mode ${mode.toString(8)}; run: chmod 600 ${path}`);
    }
  } catch {
    // permissions are advisory; an unreadable stat is reported by the caller's own read
  }
}
