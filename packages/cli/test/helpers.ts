import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decrypt, importPublicKey } from "@entziffer/core";
import { hexToBytes, importRawPrivateKey } from "@entziffer/core/testing";
import vectors from "../../core/test/vectors.json" with { type: "json" };

export const BIN = fileURLToPath(new URL("../bin/entziffer.js", import.meta.url));
export const RECIPIENT_KEY: string = vectors.recipient.publicKey;
export const RECIPIENT_FPR: string = vectors.recipient.fingerprint;
export const VECTOR_TOKEN: string = vectors.vectors[0]?.token as string;

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function tempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "entziffer-cli-"));
  return join(dir, "entziffer", "config.json");
}

export function cleanup(configPath: string): void {
  rmSync(join(configPath, "..", ".."), { recursive: true, force: true });
}

export function run(args: string[], opts?: { input?: string }): RunResult {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    input: opts?.input ?? "",
    env: { ...process.env, XDG_CONFIG_HOME: undefined },
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

export async function decryptToken(token: string): Promise<string> {
  const priv = await importRawPrivateKey(hexToBytes(vectors.recipient.privateKeyHex));
  const pub = await importPublicKey(vectors.recipient.publicKey);
  return decrypt(token, priv, pub.fpr);
}
