import { parseArgs } from "node:util";
import { formatFingerprint, GCM_TAG_BYTES, parseEnvelope } from "@entziffer/core";
import { parsing, usageError } from "../errors.js";
import { json, out } from "../io.js";
import { GLOBAL_OPTIONS, globals } from "../options.js";
import { USAGE } from "../usage.js";

export async function cmdInspect(args: string[]): Promise<void> {
  const { values, positionals } = parsing(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: GLOBAL_OPTIONS,
    }),
  );
  const g = globals(values);
  if (g.help) return out(USAGE);

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
