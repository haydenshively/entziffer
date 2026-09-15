import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  decryptToken,
  RECIPIENT_FPR,
  RECIPIENT_KEY,
  run,
  tempConfigPath,
} from "./helpers.js";

let config: string;

beforeEach(() => {
  config = tempConfigPath();
  run(["keys", "add", "me", RECIPIENT_KEY, "--config", config]);
});
afterEach(() => {
  cleanup(config);
});

const withConfig = (...args: string[]) => run([...args, "--config", config]);

describe("encrypt", () => {
  it("encrypts to the default recipient and round-trips", async () => {
    const result = withConfig("encrypt", "Fix the login redirect loop");
    expect(result.status).toBe(0);
    expect(result.stdout.endsWith("\n")).toBe(true);
    const token = result.stdout.trimEnd();
    expect(token.startsWith("ENTZ1:")).toBe(true);
    expect(await decryptToken(token)).toBe("Fix the login redirect loop");
  });

  it("encrypts to a literal key with no config at all", async () => {
    const result = run([
      "encrypt",
      "hello",
      "--to",
      RECIPIENT_KEY,
      "--config",
      "/nonexistent/c.json",
      "--json",
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.recipient).toBe("literal");
    expect(parsed.fingerprint).toBe(RECIPIENT_FPR);
    expect(await decryptToken(parsed.token)).toBe("hello");
  });

  it("reads plaintext from stdin", async () => {
    const result = run(["encrypt", "--stdin", "--config", config], {
      input: "line one\nline two\n",
    });
    expect(result.status).toBe(0);
    expect(await decryptToken(result.stdout.trimEnd())).toBe("line one\nline two");
  });

  it("rejects the removed --marker flag as a usage error", () => {
    expect(withConfig("encrypt", "hey", "--marker", "hs.ENTZ1:").status).toBe(2);
  });

  it("exits 6 on empty stdin", () => {
    const result = run(["encrypt", "--stdin", "--config", config], { input: "" });
    expect(result.status).toBe(6);
  });

  it("rejects multiple recipients with E_MULTI_UNSUPPORTED", () => {
    for (const args of [
      ["encrypt", "x", "--to", "me", "--to", RECIPIENT_KEY],
      ["encrypt", "x", "--to", "me,other"],
    ]) {
      const result = run([...args, "--config", config, "--json"]);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).error.code).toBe("E_MULTI_UNSUPPORTED");
    }
  });

  it("maps failures to exit codes", () => {
    expect(withConfig("encrypt").status).toBe(2);
    expect(withConfig("encrypt", "x", "--to", "ghost").status).toBe(4);
    expect(withConfig("encrypt", "x", "--to", "entz1pk_zzz").status).toBe(5);
    expect(run(["encrypt", "x", "--config", "/nonexistent/c.json"]).status).toBe(3);
    expect(run(["bogus"]).status).toBe(2);
    expect(run(["--version"]).status).toBe(0);
    expect(run(["--help"]).stdout).toContain("entziffer encrypt-json");
  });

  it("reports errors as JSON on stdout and text on stderr", () => {
    const result = withConfig("encrypt", "x", "--to", "ghost", "--json");
    expect(JSON.parse(result.stdout)).toEqual({
      error: { code: "E_UNKNOWN_RECIPIENT", message: "unknown recipient: ghost" },
    });
    expect(result.stderr).toContain("unknown recipient: ghost");
  });
});

describe("encrypt-json", () => {
  const encryptJson = (input: string, ...args: string[]) =>
    run(["encrypt-json", ...args, "--config", config], { input });

  it("emits the stable JSON contract, one token per field", async () => {
    const result = encryptJson(
      `${JSON.stringify({ title: "Candid title", body: "# Notes\n\nfrom a DM" })}\n`,
      "--json",
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Object.keys(parsed)).toEqual(["fields", "recipient", "fingerprint"]);
    expect(Object.keys(parsed.fields)).toEqual(["title", "body"]);
    expect(parsed.recipient).toBe("me");
    expect(parsed.fingerprint).toBe(RECIPIENT_FPR);
    expect(await decryptToken(parsed.fields.title)).toBe("Candid title");
    expect(await decryptToken(parsed.fields.body)).toBe("# Notes\n\nfrom a DM");
  });

  it("passes null fields through and encrypts empty strings", async () => {
    const result = encryptJson(JSON.stringify({ title: "T", body: null, note: "" }), "--json");
    expect(result.status).toBe(0);
    const { fields } = JSON.parse(result.stdout);
    expect(fields.body).toBeNull();
    expect(await decryptToken(fields.note)).toBe("");
  });

  it("keeps every input key, __proto__ included", async () => {
    const result = encryptJson('{"__proto__": "p", "constructor": "c"}', "--json");
    expect(result.status).toBe(0);
    const entries = Object.entries(JSON.parse(result.stdout).fields) as [string, string][];
    expect(entries.map(([key]) => key)).toEqual(["__proto__", "constructor"]);
    expect(await Promise.all(entries.map(([, token]) => decryptToken(token)))).toEqual(["p", "c"]);
  });

  it("prints one key: token line per field without --json", () => {
    const lines = encryptJson(JSON.stringify({ title: "T", body: null })).stdout.split("\n");
    expect(lines[0]?.startsWith("title: ENTZ1:")).toBe(true);
    expect(lines[1]).toBe("body: ");
  });

  it("rejects bad payloads with a usage error and empty stdin with exit 6", () => {
    for (const input of ["not json", '["title"]', "{}", '{"title":7}', '{"a":{"b":"c"}}']) {
      expect(encryptJson(input).status).toBe(2);
    }
    expect(encryptJson('{"title":"T"}', "extra").status).toBe(2);
    expect(encryptJson("").status).toBe(6);
  });
});
