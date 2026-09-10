import { describe, expect, it } from "vitest";
import { RECIPIENT_FPR, run, VECTOR_TOKEN } from "./helpers.js";

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
    expect(run(["inspect", VECTOR_TOKEN]).stdout).toBe(
      `version: 1\nfingerprint: ${RECIPIENT_FPR}\nciphertext: 43 bytes\nplaintext: 27 bytes\n`,
    );
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
