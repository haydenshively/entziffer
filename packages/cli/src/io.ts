import { CliError, EXIT_EMPTY_STDIN } from "./errors.js";

export function out(s: string): void {
  process.stdout.write(s);
}

export function warn(message: string, quiet: boolean): void {
  if (!quiet) process.stderr.write(`entziffer: ${message}\n`);
}

export function json(value: unknown): void {
  out(`${JSON.stringify(value)}\n`);
}

/** Reads all of stdin, dropping one trailing newline; empty input is exit code 6. */
export async function readStdin(what: string): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliError("E_EMPTY_STDIN", `${what} is empty (stdin is a terminal)`, EXIT_EMPTY_STDIN);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  if (text.trim() === "") {
    throw new CliError("E_EMPTY_STDIN", `${what} is empty`, EXIT_EMPTY_STDIN);
  }
  return text;
}
