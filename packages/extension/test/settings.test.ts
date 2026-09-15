import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/messages.js";
import { getSettings, setSettings } from "../src/sw/settings.js";

let stored: Record<string, unknown>;

beforeEach(() => {
  stored = {};
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: stored[key] }),
        set: async (patch: Record<string, unknown>) => Object.assign(stored, patch),
      },
    },
  };
});

describe("settings", () => {
  it("returns the defaults when nothing is stored", async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("drops fields older builds stored alongside the auto-lock delay", async () => {
    stored.settings = { autoLockMinutes: 60, enabledOrigins: ["https://example.com"] };
    expect(await getSettings()).toEqual({ autoLockMinutes: 60 });
    expect(await setSettings({})).toEqual({ autoLockMinutes: 60 });
    expect(stored.settings).toEqual({ autoLockMinutes: 60 });
  });

  it("falls back to the default when the stored delay is not a choice", async () => {
    stored.settings = { autoLockMinutes: 7 };
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("rejects a delay outside the offered choices", async () => {
    await expect(setSettings({ autoLockMinutes: 7 as never })).rejects.toThrow("autoLockMinutes");
    expect(stored.settings).toBeUndefined();
  });

  it("round trips an offered delay", async () => {
    expect(await setSettings({ autoLockMinutes: 1440 })).toEqual({ autoLockMinutes: 1440 });
    expect(await getSettings()).toEqual({ autoLockMinutes: 1440 });
  });
});
