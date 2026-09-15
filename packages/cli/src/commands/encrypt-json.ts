import { encrypt } from "@entziffer/core";
import { readConfig } from "../config.js";
import { usageError } from "../errors.js";
import { json, out, readStdin } from "../io.js";
import { parseCommand } from "../options.js";
import { resolveRecipient } from "../recipient.js";
import { USAGE } from "../usage.js";

/** Stable `--json` contract; agents depend on the exact keys. */
export interface EncryptJsonOutput {
  fields: Record<string, string | null>;
  recipient: string;
  fingerprint: string;
}

const STDIN_SHAPE = "a one-level JSON object whose values are strings or null";

/** Stdin is the one input path that keeps plaintext out of argv, and so out of `ps` and shell history. */
function parseFields(raw: string): Record<string, string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw usageError(`encrypt-json expects ${STDIN_SHAPE} on stdin, not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError(`encrypt-json expects ${STDIN_SHAPE} on stdin`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) throw usageError("encrypt-json needs at least one field");
  for (const [key, value] of entries) {
    if (value !== null && typeof value !== "string") {
      throw usageError(`encrypt-json field "${key}" must be a string or null`);
    }
  }
  return parsed as Record<string, string | null>;
}

export async function cmdEncryptJson(args: string[]): Promise<void> {
  const { values, positionals, configPath, ...g } = parseCommand(args, {
    to: { type: "string", multiple: true },
  });
  if (g.help) return out(USAGE);
  if (positionals.length > 0) throw usageError("encrypt-json takes no positional arguments");

  const plain = parseFields(await readStdin("fields JSON"));
  const cfg = readConfig(configPath);
  const recipient = await resolveRecipient(values.to, cfg, configPath);

  const encrypted: [string, string | null][] = [];
  for (const [key, value] of Object.entries(plain)) {
    encrypted.push([key, value === null ? null : await encrypt(value, recipient.key)]);
  }
  const result: EncryptJsonOutput = {
    fields: Object.fromEntries(encrypted),
    recipient: recipient.name,
    fingerprint: recipient.fingerprint,
  };

  if (g.json) {
    json(result);
    return;
  }
  out(
    encrypted
      .map(([key, token]) => `${key}: ${token ?? ""}\n`)
      .join(""),
  );
}
