import pkg from "../package.json" with { type: "json" };
import { cmdEncrypt } from "./commands/encrypt.js";
import { cmdEncryptIssue } from "./commands/encrypt-issue.js";
import { cmdInspect } from "./commands/inspect.js";
import { cmdKeys } from "./commands/keys.js";
import { EXIT_OK, toCliError, usageError } from "./errors.js";
import { json, out, setQuiet } from "./io.js";
import { USAGE } from "./usage.js";

export const VERSION: string = pkg.version;

export async function run(argv: string[]): Promise<number> {
  const wantsJson = argv.includes("--json");
  setQuiet(argv.includes("--quiet"));
  try {
    await dispatch(argv);
    return EXIT_OK;
  } catch (e) {
    const err = toCliError(e);
    process.stderr.write(`entziffer: ${err.message}\n`);
    if (wantsJson) json({ error: { code: err.code, message: err.message } });
    return err.exit;
  }
}

async function dispatch(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return out(USAGE);
    case "--version":
    case "-v":
      return out(`${VERSION}\n`);
    case "encrypt":
      return cmdEncrypt(args);
    case "encrypt-issue":
      return cmdEncryptIssue(args);
    case "keys":
      return cmdKeys(args);
    case "inspect":
      return cmdInspect(args);
    default:
      throw usageError(`unknown command: ${command}`);
  }
}
