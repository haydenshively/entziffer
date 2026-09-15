import { parseArgs } from "node:util";
import { encrypt } from "@entziffer/core";
import { readConfig } from "../config.js";
import { parsing, usageError } from "../errors.js";
import { json, out, readStdin } from "../io.js";
import { GLOBAL_OPTIONS, globals } from "../options.js";
import { resolveRecipient } from "../recipient.js";
import { USAGE } from "../usage.js";

export async function cmdEncrypt(args: string[]): Promise<void> {
  const { values, positionals } = parsing(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: {
        ...GLOBAL_OPTIONS,
        to: { type: "string", multiple: true },
        stdin: { type: "boolean" },
      },
    }),
  );
  const g = globals(values);
  if (g.help) return out(USAGE);

  const text = await resolveText(positionals, values.stdin === true);
  const cfg = readConfig(g.configPath, g.quiet);
  const recipient = await resolveRecipient(values.to, cfg, g.configPath);
  const token = await encrypt(text, recipient.key);

  if (g.json) {
    json({ token, recipient: recipient.name, fingerprint: recipient.fingerprint });
    return;
  }
  out(`${token}\n`);
}

async function resolveText(positionals: string[], stdin: boolean): Promise<string> {
  if (positionals.length > 1) throw usageError("encrypt takes at most one text argument");
  const arg = positionals[0];
  if (stdin) {
    if (arg !== undefined) throw usageError("pass text or --stdin, not both");
    return readStdin("stdin");
  }
  if (arg === undefined) throw usageError("encrypt needs text or --stdin");
  return arg;
}
