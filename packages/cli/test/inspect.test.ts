import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  FOREIGN_KEY,
  RECIPIENT_FPR,
  RECIPIENT_KEY,
  run,
  tempConfigPath,
  VECTOR_TOKEN,
} from "./helpers.js";

let config: string;

beforeEach(() => {
  config = tempConfigPath();
});
afterEach(() => {
  cleanup(config);
});

function writeRecipients(recipients: Record<string, { publicKey: string }>): void {
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ version: 1, recipients }));
}

const withConfig = (...args: string[]) => run([...args, "--config", config]);

describe("inspect", () => {
  it("describes a known vector token without decrypting", () => {
    const result = withConfig("inspect", VECTOR_TOKEN, "--json");
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.version).toBe(1);
    expect(parsed.fingerprint).toBe(RECIPIENT_FPR);
    expect(parsed.plaintextBytes).toBe("Fix the login redirect loop".length);
    expect(parsed.ciphertextBytes).toBe(parsed.plaintextBytes + 16);
  });

  it("prints a human-readable report", () => {
    expect(withConfig("inspect", VECTOR_TOKEN).stdout).toBe(
      `version: 1\nfingerprint: ${RECIPIENT_FPR}\nrecipient: unknown\n` +
        "ciphertext: 43 bytes\nplaintext: 27 bytes\n",
    );
  });

  it("names a configured recipient whose key matches the envelope fingerprint", () => {
    writeRecipients({ alice: { publicKey: RECIPIENT_KEY } });
    expect(withConfig("inspect", VECTOR_TOKEN).stdout).toBe(
      `version: 1\nfingerprint: ${RECIPIENT_FPR}\nrecipient: alice\n` +
        "ciphertext: 43 bytes\nplaintext: 27 bytes\n",
    );
    expect(JSON.parse(withConfig("inspect", VECTOR_TOKEN, "--json").stdout).recipient).toBe(
      "alice",
    );
  });

  it("reports every recipient sharing the key, and skips malformed entries", () => {
    writeRecipients({
      alice: { publicKey: RECIPIENT_KEY },
      bob: { publicKey: "not-a-key" },
      carol: { publicKey: RECIPIENT_KEY },
    });
    expect(JSON.parse(withConfig("inspect", VECTOR_TOKEN, "--json").stdout).recipient).toBe(
      "alice or carol",
    );
  });

  it("reports null for a valid key with a different fingerprint", () => {
    writeRecipients({ bob: { publicKey: FOREIGN_KEY } });
    const parsed = JSON.parse(withConfig("inspect", VECTOR_TOKEN, "--json").stdout);
    expect(parsed.recipient).toBeNull();
    expect(parsed.fingerprint).toBe(RECIPIENT_FPR);
  });

  it("works with no config file at all", () => {
    const missing = run(["inspect", VECTOR_TOKEN, "--json", "--config", tempConfigPath()]);
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout).recipient).toBeNull();
  });

  it("still describes the token when the config is unreadable", () => {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, "{ not json");
    const result = withConfig("inspect", VECTOR_TOKEN, "--json");
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.recipient).toBeNull();
    expect(parsed.fingerprint).toBe(RECIPIENT_FPR);
  });

  it("rejects malformed tokens with exit code 5", () => {
    expect(withConfig("inspect", "ENTZ1:!!!").status).toBe(5);
    expect(withConfig("inspect", "not-a-token").status).toBe(5);
    expect(withConfig("inspect", "ENTZ1:AAAA").status).toBe(5);
    expect(withConfig("inspect").status).toBe(2);
    expect(withConfig("fingerprint", VECTOR_TOKEN).status).toBe(2);
    expect(withConfig("init").status).toBe(2);
  });
});
