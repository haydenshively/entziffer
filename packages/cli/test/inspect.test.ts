import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
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
    const result = run(["inspect", VECTOR_TOKEN, "--json"]);
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
      "alice, carol",
    );
  });

  it("reports null for an unknown fingerprint and for a missing config file", () => {
    writeRecipients({ bob: { publicKey: "entz1pk_ZZZZ" } });
    expect(JSON.parse(withConfig("inspect", VECTOR_TOKEN, "--json").stdout).recipient).toBeNull();

    const parsed = JSON.parse(withConfig("inspect", VECTOR_TOKEN, "--json").stdout);
    expect(parsed.fingerprint).toBe(RECIPIENT_FPR);
  });

  it("works with no config file at all", () => {
    expect(JSON.parse(withConfig("inspect", VECTOR_TOKEN, "--json").stdout).recipient).toBeNull();
  });

  it("rejects malformed tokens with exit code 5", () => {
    expect(run(["inspect", "ENTZ1:!!!"]).status).toBe(5);
    expect(run(["inspect", "not-a-token"]).status).toBe(5);
    expect(run(["inspect", "ENTZ1:AAAA"]).status).toBe(5);
    expect(run(["inspect"]).status).toBe(2);
    expect(run(["fingerprint", VECTOR_TOKEN]).status).toBe(2);
    expect(run(["init"]).status).toBe(2);
  });
});
