import { parseArgs } from "node:util";
import { encrypt } from "@entziffer/core";
import { readConfig } from "../config.js";
import { parsing, usageError } from "../errors.js";
import { json, out, readStdin } from "../io.js";
import { GLOBAL_OPTIONS, globals } from "../options.js";
import { resolveRecipient } from "../recipient.js";
import { USAGE } from "../usage.js";

/** Shape consumed by the `private-linear-issue` skill; keep the keys exact. */
export interface EncryptIssueOutput {
  title: string;
  description: string | null;
  recipient: string;
  fingerprint: string;
}

const STDIN_JSON_SHAPE = '{"title": string, "body"?: string}';

interface Issue {
  title: string;
  body: string | null;
}

/** The one input mode that keeps plaintext out of argv, and so out of `ps` and shell history. */
function parseIssueJson(raw: string): Issue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw usageError(`--stdin-json expects ${STDIN_JSON_SHAPE} on stdin, not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError(`--stdin-json expects ${STDIN_JSON_SHAPE} on stdin`);
  }
  const { title, body } = parsed as { title?: unknown; body?: unknown };
  if (typeof title !== "string" || title === "") {
    throw usageError("--stdin-json needs a non-empty string title");
  }
  if (body !== undefined && body !== null && typeof body !== "string") {
    throw usageError("--stdin-json body must be a string when present");
  }
  return { title, body: body === undefined || body === null || body === "" ? null : body };
}

async function readIssue(values: {
  title?: string | undefined;
  body?: string | undefined;
  "body-stdin"?: boolean | undefined;
  "stdin-json"?: boolean | undefined;
}): Promise<Issue> {
  if (values["stdin-json"] === true) {
    if (values.title !== undefined || values.body !== undefined || values["body-stdin"] === true) {
      throw usageError("--stdin-json carries the title and body; drop --title/--body/--body-stdin");
    }
    return parseIssueJson(await readStdin("issue JSON"));
  }
  if (values.title === undefined) throw usageError("encrypt-issue needs --title or --stdin-json");
  if (values.body !== undefined && values["body-stdin"] === true) {
    throw usageError("pass --body or --body-stdin, not both");
  }
  return {
    title: values.title,
    body: values["body-stdin"] === true ? await readStdin("issue body") : (values.body ?? null),
  };
}

export async function cmdEncryptIssue(args: string[]): Promise<void> {
  const { values, positionals } = parsing(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: {
        ...GLOBAL_OPTIONS,
        title: { type: "string" },
        body: { type: "string" },
        "body-stdin": { type: "boolean" },
        "stdin-json": { type: "boolean" },
        to: { type: "string", multiple: true },
      },
    }),
  );
  const g = globals(values);
  if (g.help) return out(USAGE);
  if (positionals.length > 0) throw usageError("encrypt-issue takes no positional arguments");

  const issue = await readIssue(values);
  const cfg = readConfig(g.configPath, g.quiet);
  const recipient = await resolveRecipient(values.to, cfg, g.configPath);

  const result: EncryptIssueOutput = {
    title: await encrypt(issue.title, recipient.key),
    description: issue.body === null ? null : await encrypt(issue.body, recipient.key),
    recipient: recipient.name,
    fingerprint: recipient.fingerprint,
  };

  if (g.json) {
    json(result);
    return;
  }
  out(`title: ${result.title}\ndescription: ${result.description ?? ""}\n`);
}
