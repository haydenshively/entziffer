import { formatFingerprint, GCM_TAG_BYTES, parseEnvelope } from "@entziffer/core";
import { readConfig } from "../config.js";
import { usageError } from "../errors.js";
import { json, out } from "../io.js";
import { parseCommand } from "../options.js";
import { fingerprintOf } from "../recipient.js";
import { USAGE } from "../usage.js";

const UNKNOWN_RECIPIENT = "unknown";

async function namesFor(fingerprint: string, configPath: string): Promise<string | null> {
  const cfg = readConfig(configPath);
  if (cfg === null) return null;
  const matched: string[] = [];
  for (const [name, entry] of Object.entries(cfg.recipients)) {
    if ((await fingerprintOf(entry.publicKey)) === fingerprint) matched.push(name);
  }
  return matched.length === 0 ? null : matched.join(", ");
}

export async function cmdInspect(args: string[]): Promise<void> {
  const { positionals, configPath, ...g } = parseCommand(args);
  if (g.help) {
    out(USAGE);
    return;
  }

  const [token, ...extra] = positionals;
  if (token === undefined || extra.length > 0) throw usageError("usage: entziffer inspect <token>");

  const env = parseEnvelope(token);
  const fingerprint = formatFingerprint(env.fpr);
  const report = {
    version: env.ver,
    fingerprint,
    recipient: await namesFor(fingerprint, configPath),
    ciphertextBytes: env.ct.length,
    plaintextBytes: env.ct.length - GCM_TAG_BYTES,
  };

  if (g.json) {
    json(report);
    return;
  }
  out(
    `version: ${report.version}\nfingerprint: ${report.fingerprint}\n` +
      `recipient: ${report.recipient ?? UNKNOWN_RECIPIENT}\n` +
      `ciphertext: ${report.ciphertextBytes} bytes\nplaintext: ${report.plaintextBytes} bytes\n`,
  );
}
