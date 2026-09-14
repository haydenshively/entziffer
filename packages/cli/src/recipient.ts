import {
  b64urlDecode,
  type EntzPublicKey,
  fingerprint,
  formatFingerprint,
  importPublicKey,
  PUBLIC_KEY_PREFIX,
  RAW_KEY_BYTES,
} from "@entziffer/core";
import type { Config } from "./config.js";
import { CliError, EXIT_CONFIG, EXIT_UNKNOWN_RECIPIENT, EXIT_USAGE } from "./errors.js";

export const LITERAL_RECIPIENT = "literal";

/** `null` for any entry that is not a well-formed key string, so one bad row cannot hide the rest. */
export async function fingerprintOf(publicKey: string): Promise<string | null> {
  if (!publicKey.startsWith(PUBLIC_KEY_PREFIX)) return null;
  try {
    const raw = b64urlDecode(publicKey.slice(PUBLIC_KEY_PREFIX.length));
    return raw.length === RAW_KEY_BYTES ? formatFingerprint(await fingerprint(raw)) : null;
  } catch {
    return null;
  }
}

export interface ResolvedRecipient {
  name: string;
  publicKey: string;
  key: EntzPublicKey;
  fingerprint: string;
}

function multiError(): CliError {
  return new CliError(
    "E_MULTI_UNSUPPORTED",
    "ENTZ1 v1 encrypts to exactly one recipient; pass a single --to",
    EXIT_USAGE,
  );
}

export async function resolveRecipient(
  to: string[] | undefined,
  cfg: Config | null,
  configPath: string,
): Promise<ResolvedRecipient> {
  if (to !== undefined && to.length > 1) throw multiError();
  const spec = to?.[0];
  if (spec?.includes(",")) throw multiError();

  let name: string;
  let publicKey: string;
  if (spec?.startsWith(PUBLIC_KEY_PREFIX)) {
    name = LITERAL_RECIPIENT;
    publicKey = spec;
  } else {
    if (cfg === null) {
      throw new CliError(
        "E_CONFIG_MISSING",
        `no config at ${configPath}; run 'entziffer keys add <name> <entz1pk_...>' or pass --to ${PUBLIC_KEY_PREFIX}...`,
        EXIT_CONFIG,
      );
    }
    if (spec === undefined && cfg.default === undefined) {
      throw new CliError(
        "E_NO_DEFAULT",
        "no default recipient; pass --to or run 'entziffer keys default <name>'",
        EXIT_CONFIG,
      );
    }
    name = spec ?? (cfg.default as string);
    const entry = cfg.recipients[name];
    if (entry === undefined) {
      throw new CliError(
        "E_UNKNOWN_RECIPIENT",
        `unknown recipient: ${name}`,
        EXIT_UNKNOWN_RECIPIENT,
      );
    }
    publicKey = entry.publicKey;
  }

  const key = await importPublicKey(publicKey);
  return { name, publicKey, key, fingerprint: formatFingerprint(key.fpr) };
}
