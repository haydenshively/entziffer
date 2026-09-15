import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncDynamicScripts } from "../src/sw/scripts.js";

const SCRIPT_ID = "entz-enabled-origins";

let granted: string[];
let registered: { id: string; matches: string[] }[];
let unregister: ReturnType<typeof vi.fn>;
let register: ReturnType<typeof vi.fn>;

beforeEach(() => {
  granted = [];
  registered = [];
  unregister = vi.fn(async ({ ids }: { ids: string[] }) => {
    registered = registered.filter((s) => !ids.includes(s.id));
  });
  register = vi.fn(async (scripts: { id: string; matches: string[] }[]) => {
    registered.push(...scripts);
  });
  (globalThis as Record<string, unknown>).chrome = {
    permissions: { getAll: async () => ({ origins: granted }) },
    scripting: {
      getRegisteredContentScripts: async ({ ids }: { ids: string[] }) =>
        registered.filter((s) => ids.includes(s.id)),
      unregisterContentScripts: unregister,
      registerContentScripts: register,
    },
  };
});

describe("syncDynamicScripts", () => {
  it("registers nothing when no origin is granted", async () => {
    await syncDynamicScripts();
    expect(register).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
  });

  it("registers exactly the granted origins", async () => {
    granted = ["https://tracker.example/*", "https://example.com/*"];
    await syncDynamicScripts();
    expect(registered).toEqual([
      expect.objectContaining({
        id: SCRIPT_ID,
        js: ["content.js"],
        matches: ["https://example.com/*", "https://tracker.example/*"],
      }),
    ]);
  });

  it("collapses to <all_urls> when it is granted", async () => {
    granted = ["<all_urls>", "https://tracker.example/*"];
    await syncDynamicScripts();
    expect(registered[0]?.matches).toEqual(["<all_urls>"]);
  });

  it("unregisters an origin whose permission was revoked elsewhere", async () => {
    granted = ["https://tracker.example/*", "https://example.com/*"];
    await syncDynamicScripts();
    granted = ["https://example.com/*"];
    await syncDynamicScripts();
    expect(unregister).toHaveBeenCalledWith({ ids: [SCRIPT_ID] });
    expect(registered).toHaveLength(1);
    expect(registered[0]?.matches).toEqual(["https://example.com/*"]);
  });

  it("drops the registration entirely once every permission is revoked", async () => {
    granted = ["https://tracker.example/*"];
    await syncDynamicScripts();
    granted = [];
    await syncDynamicScripts();
    expect(registered).toEqual([]);
    expect(register).toHaveBeenCalledTimes(1);
  });
});
