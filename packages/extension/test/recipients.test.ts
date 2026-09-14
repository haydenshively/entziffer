import { beforeEach, describe, expect, it } from "vitest";
import vectors from "../../core/test/vectors.json" with { type: "json" };
import type { TokenResult } from "../src/shared/messages.js";
import { setPeople } from "../src/shared/people.js";
import { withRecipients } from "../src/sw/recipients.js";

const FOREIGN = vectors.foreign;
const READABLE = vectors.vectors[0] as { token: string };

let stored: Record<string, unknown>;
let reads: number;

beforeEach(() => {
  stored = {};
  reads = 0;
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      sync: {
        get: async (key: string) => {
          reads++;
          return { [key]: stored[key] };
        },
        set: async (patch: Record<string, unknown>) => Object.assign(stored, patch),
      },
    },
  };
});

describe("withRecipients", () => {
  it("names only the foreign tokens in a mixed batch", async () => {
    await setPeople([{ name: "Alice", publicKey: FOREIGN.publicKey }]);
    const tokens = [READABLE.token, FOREIGN.token, FOREIGN.token, "not-a-token"];
    const results: TokenResult[] = [
      { ok: true, text: "readable" },
      { ok: false, code: "FPR_MISMATCH" },
      { ok: false, code: "DECRYPT_FAILED" },
      { ok: false, code: "FPR_MISMATCH" },
    ];
    reads = 0;
    expect(await withRecipients(results, tokens)).toEqual([
      { ok: true, text: "readable" },
      { ok: false, code: "FPR_MISMATCH", recipient: "Alice" },
      { ok: false, code: "DECRYPT_FAILED" },
      { ok: false, code: "FPR_MISMATCH" },
    ]);
    expect(reads).toBe(1);
  });

  it("leaves a fingerprint the book does not know unnamed", async () => {
    await setPeople([{ name: "Alice", publicKey: vectors.recipient.publicKey }]);
    const results: TokenResult[] = [{ ok: false, code: "FPR_MISMATCH" }];
    expect(await withRecipients(results, [FOREIGN.token])).toEqual(results);
  });

  it("reads no storage when nothing mismatched", async () => {
    await setPeople([{ name: "Alice", publicKey: FOREIGN.publicKey }]);
    reads = 0;
    const results: TokenResult[] = [
      { ok: true, text: "readable" },
      { ok: false, code: "DECRYPT_FAILED" },
    ];
    expect(await withRecipients(results, [READABLE.token, FOREIGN.token])).toBe(results);
    expect(reads).toBe(0);
  });
});
