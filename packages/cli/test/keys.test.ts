import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, RECIPIENT_FPR, RECIPIENT_KEY, run, tempConfigPath } from "./helpers.js";

let config: string;

beforeEach(() => {
  config = tempConfigPath();
});
afterEach(() => {
  cleanup(config);
});

const withConfig = (...args: string[]) => run([...args, "--config", config]);

describe("keys", () => {
  it("add creates a 0600 config when none exists", () => {
    expect(withConfig("keys", "add", "me", RECIPIENT_KEY).status).toBe(0);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
      version: 1,
      recipients: { me: { publicKey: RECIPIENT_KEY } },
      default: "me",
    });
    expect(statSync(config).mode & 0o777).toBe(0o600);
  });

  it("first add becomes the default and list reports it", () => {
    expect(withConfig("keys", "add", "me", RECIPIENT_KEY, "--note", "laptop").status).toBe(0);
    expect(withConfig("keys", "add", "other", RECIPIENT_KEY).status).toBe(0);

    const listed = JSON.parse(withConfig("keys", "list", "--json").stdout);
    expect(listed.default).toBe("me");
    expect(listed.recipients).toEqual([
      {
        name: "me",
        publicKey: RECIPIENT_KEY,
        fingerprint: RECIPIENT_FPR,
        note: "laptop",
        default: true,
      },
      {
        name: "other",
        publicKey: RECIPIENT_KEY,
        fingerprint: RECIPIENT_FPR,
        note: null,
        default: false,
      },
    ]);
    expect(withConfig("keys", "list").stdout).toMatch(/^\* me {2}3697-8b57/);
  });

  it("--default overrides, keys default switches, keys rm reassigns", () => {
    withConfig("keys", "add", "me", RECIPIENT_KEY);
    withConfig("keys", "add", "other", RECIPIENT_KEY, "--default");
    expect(JSON.parse(withConfig("keys", "list", "--json").stdout).default).toBe("other");

    expect(withConfig("keys", "default", "me").status).toBe(0);
    expect(JSON.parse(withConfig("keys", "list", "--json").stdout).default).toBe("me");

    expect(withConfig("keys", "rm", "me").status).toBe(0);
    const after = JSON.parse(withConfig("keys", "list", "--json").stdout);
    expect(after.default).toBe("other");
    expect(after.recipients).toHaveLength(1);
  });

  it("rejects an invalid public key and unknown names", () => {
    expect(withConfig("keys", "add", "me", "entz1pk_nope").status).toBe(5);
    withConfig("keys", "add", "me", RECIPIENT_KEY);
    expect(withConfig("keys", "default", "ghost").status).toBe(4);
    expect(withConfig("keys", "rm", "ghost").status).toBe(4);
    expect(withConfig("keys", "bogus").status).toBe(2);
  });

  it("warns when the config is group-readable", () => {
    withConfig("keys", "add", "me", RECIPIENT_KEY);
    chmodSync(config, 0o644);
    expect(withConfig("keys", "list").stderr).toContain("chmod 600");
    expect(withConfig("keys", "list", "--quiet").stderr).toBe("");
  });

  it("ignores an unknown config key with a warning", () => {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, JSON.stringify({ version: 1, marker: "hs.ENTZ1:", recipients: {} }));
    const result = withConfig("keys", "list");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("unknown config key 'marker'");
  });

  it("reports an invalid config with exit code 3", () => {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, '{"version":2}');
    const result = withConfig("keys", "list");
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("expected version 1");
  });
});
