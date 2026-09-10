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
    expect(run(["--help"]).stdout).toContain("entziffer encrypt-issue");
  });

  it("reports errors as JSON on stdout and text on stderr", () => {
    const result = withConfig("encrypt", "x", "--to", "ghost", "--json");
    expect(JSON.parse(result.stdout)).toEqual({
      error: { code: "E_UNKNOWN_RECIPIENT", message: "unknown recipient: ghost" },
    });
    expect(result.stderr).toContain("unknown recipient: ghost");
  });
});

describe("encrypt-issue", () => {
  it("emits the JSON contract used by the skill", async () => {
    const result = run(["encrypt-issue", "--title", "Candid title", "--config", config, "--json"], {
      input: "",
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Object.keys(parsed)).toEqual(["title", "description", "recipient", "fingerprint"]);
    expect(parsed.description).toBeNull();
    expect(parsed.recipient).toBe("me");
    expect(parsed.fingerprint).toBe(RECIPIENT_FPR);
    expect(await decryptToken(parsed.title)).toBe("Candid title");
  });

  it("encrypts a body from --body and from --body-stdin", async () => {
    const inline = JSON.parse(
      withConfig("encrypt-issue", "--title", "T", "--body", "B", "--json").stdout,
    );
    expect(await decryptToken(inline.description)).toBe("B");

    const piped = run(
      ["encrypt-issue", "--title", "T", "--body-stdin", "--config", config, "--json"],
      {
        input: "# Notes\n\nfrom a DM\n",
      },
    );
    expect(await decryptToken(JSON.parse(piped.stdout).description)).toBe("# Notes\n\nfrom a DM");
  });

  it("prints title and description lines without --json", () => {
    const lines = withConfig("encrypt-issue", "--title", "T", "--body", "B").stdout.split("\n");
    expect(lines[0]?.startsWith("title: ENTZ1:")).toBe(true);
    expect(lines[1]?.startsWith("description: ENTZ1:")).toBe(true);
  });

  it("takes the whole issue from stdin JSON, keeping plaintext out of argv", async () => {
    const result = run(["encrypt-issue", "--stdin-json", "--config", config, "--json"], {
      input: `${JSON.stringify({ title: "Candid title", body: "# Notes\n\nfrom a DM" })}\n`,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Object.keys(parsed)).toEqual(["title", "description", "recipient", "fingerprint"]);
    expect(await decryptToken(parsed.title)).toBe("Candid title");
    expect(await decryptToken(parsed.description)).toBe("# Notes\n\nfrom a DM");
  });

  it("treats a missing stdin-json body as no description", () => {
    const result = run(["encrypt-issue", "--stdin-json", "--config", config, "--json"], {
      input: JSON.stringify({ title: "T" }),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).description).toBeNull();
  });

  it("rejects stdin-json combined with the flag inputs, and bad payloads", () => {
    for (const args of [
      ["--stdin-json", "--title", "T"],
      ["--stdin-json", "--body", "B"],
      ["--stdin-json", "--body-stdin"],
    ]) {
      const result = run(["encrypt-issue", ...args, "--config", config], {
        input: JSON.stringify({ title: "T" }),
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--stdin-json");
    }
    for (const input of ["not json", '["title"]', "{}", '{"title":""}', '{"title":"T","body":7}']) {
      expect(run(["encrypt-issue", "--stdin-json", "--config", config], { input }).status).toBe(2);
    }
    expect(run(["encrypt-issue", "--stdin-json", "--config", config], { input: "" }).status).toBe(
      6,
    );
  });

  it("requires --title and rejects both body sources", () => {
    expect(withConfig("encrypt-issue").status).toBe(2);
    expect(withConfig("encrypt-issue", "--title", "T", "--body", "B", "--body-stdin").status).toBe(
      2,
    );
    expect(
      run(["encrypt-issue", "--title", "T", "--body-stdin", "--config", config], { input: "" })
        .status,
    ).toBe(6);
  });
});
