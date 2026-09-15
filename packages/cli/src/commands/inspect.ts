import { formatFingerprint, GCM_TAG_BYTES, parseEnvelope } from "@entziffer/core";
import { usageError } from "../errors.js";
import { json, out } from "../io.js";
import { parseCommand } from "../options.js";
import { USAGE } from "../usage.js";

export function cmdInspect(args: string[]): void {
  const { positionals, ...g } = parseCommand(args);
  if (g.help) {
    out(USAGE);
    return;
  }

  const [token, ...extra] = positionals;
  if (token === undefined || extra.length > 0) throw usageError("usage: entziffer inspect <token>");

  const env = parseEnvelope(token);
  const report = {
    version: env.ver,
    fingerprint: formatFingerprint(env.fpr),
    ciphertextBytes: env.ct.length,
    plaintextBytes: env.ct.length - GCM_TAG_BYTES,
  };

  if (g.json) {
    json(report);
    return;
  }
  out(
    `version: ${report.version}\nfingerprint: ${report.fingerprint}\n` +
      `ciphertext: ${report.ciphertextBytes} bytes\nplaintext: ${report.plaintextBytes} bytes\n`,
  );
}
