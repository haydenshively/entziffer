import { beforeEach, describe, expect, it } from "vitest";
import {
  getPeople,
  namesByFingerprint,
  parseConfigRecipients,
  setPeople,
} from "../src/shared/people.js";

/** Two 32-byte keys whose SHA-256 prefixes collide, which four bytes of fingerprint cannot rule out. */
const TWIN_A = "entz1pk_fZfWWPVcIUTdyI1ZdOpPn3wG9QKvLFwUNy2rMD9Iih8";
const TWIN_B = "entz1pk_KjvWpW75eWLtOQtDaE2rxhPlcg6Se6HKqs_fgQnR6Wc";
const TWIN_FPR = "4c2f-09c3";

const ALICE = "entz1pk__sWZim4NXpI4lpbsahPtbYXpgPdd_KurSBKH54lUpjc";
const ALICE_FPR = "3697-8b57";

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

describe("getPeople", () => {
  it("is empty when nothing is stored, and when the stored value is not a list", async () => {
    expect(await getPeople()).toEqual([]);
    stored.people = { alice: ALICE };
    expect(await getPeople()).toEqual([]);
  });

  it("drops malformed entries and keeps the rest", async () => {
    stored.people = [
      { name: "Alice", publicKey: ALICE, note: "dropped" },
      { name: "", publicKey: TWIN_A },
      { name: "No key" },
      { name: "Bad prefix", publicKey: "pk_nope" },
      { name: "Bad base64", publicKey: "entz1pk_!!!!" },
      { name: "Short", publicKey: "entz1pk_AAAA" },
      { name: 7, publicKey: TWIN_A },
      null,
      "Alice",
      { name: "  Bob  ", publicKey: TWIN_B },
    ];
    expect(await getPeople()).toEqual([
      { name: "Alice", publicKey: ALICE },
      { name: "Bob", publicKey: TWIN_B },
    ]);
  });

  it("caps a name at 64 characters, after trimming", async () => {
    stored.people = [{ name: `  ${"a".repeat(80)}  `, publicKey: ALICE }];
    expect((await getPeople())[0]?.name).toBe("a".repeat(64));
  });

  it("keeps one entry per public key", async () => {
    stored.people = [
      { name: "Alice", publicKey: ALICE },
      { name: "Alice again", publicKey: ALICE },
    ];
    expect(await getPeople()).toEqual([{ name: "Alice", publicKey: ALICE }]);
  });
});

describe("setPeople", () => {
  it("stores only what a read would keep", async () => {
    expect(
      await setPeople([
        { name: "Alice", publicKey: ALICE },
        { name: "", publicKey: TWIN_A },
      ]),
    ).toEqual([{ name: "Alice", publicKey: ALICE }]);
    expect(stored.people).toEqual([{ name: "Alice", publicKey: ALICE }]);
    expect(await getPeople()).toEqual([{ name: "Alice", publicKey: ALICE }]);
  });
});

describe("namesByFingerprint", () => {
  it("names nobody when the book is empty or the fingerprint is unknown", async () => {
    expect((await namesByFingerprint()).size).toBe(0);
    await setPeople([{ name: "Alice", publicKey: ALICE }]);
    expect((await namesByFingerprint()).get(TWIN_FPR)).toBeUndefined();
  });

  it("names the one person a fingerprint belongs to", async () => {
    await setPeople([{ name: "Alice", publicKey: ALICE }]);
    expect((await namesByFingerprint()).get(ALICE_FPR)).toBe("Alice");
  });

  it("joins the names of two keys that share a fingerprint", async () => {
    await setPeople([
      { name: "Bob", publicKey: TWIN_A },
      { name: "Alice", publicKey: ALICE },
      { name: "Carol", publicKey: TWIN_B },
    ]);
    const names = await namesByFingerprint();
    expect(names.get(TWIN_FPR)).toBe("Bob or Carol");
    expect(names.get(ALICE_FPR)).toBe("Alice");
  });

  it("reads storage once for any number of lookups", async () => {
    await setPeople([{ name: "Alice", publicKey: ALICE }]);
    reads = 0;
    const names = await namesByFingerprint();
    expect(reads).toBe(1);
    expect(names.get(ALICE_FPR)).toBe("Alice");
  });
});

describe("parseConfigRecipients", () => {
  it("is null for anything that is not a config with recipients", () => {
    expect(parseConfigRecipients(ALICE)).toBeNull();
    expect(parseConfigRecipients("{")).toBeNull();
    expect(parseConfigRecipients('{"version":1}')).toBeNull();
    expect(parseConfigRecipients('{"recipients":[]}')).toBeNull();
  });

  it("takes every recipient it can read as a key", () => {
    expect(
      parseConfigRecipients(
        JSON.stringify({
          version: 1,
          default: "me",
          recipients: {
            Alice: { publicKey: ALICE, note: "work" },
            Broken: { publicKey: "entz1pk_nope" },
            Empty: {},
            Bob: { publicKey: TWIN_B },
          },
        }),
      ),
    ).toEqual([
      { name: "Alice", publicKey: ALICE },
      { name: "Bob", publicKey: TWIN_B },
    ]);
  });
});
