import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, readSession, writeSession } from "../src/sw/keystore.js";
import {
  installSessionListeners,
  lockNow,
  scheduleAutoLock,
  sessionKey,
  unlockSession,
} from "../src/sw/session.js";

const key = (label: string): CryptoKey => ({ label }) as unknown as CryptoKey;

interface AlarmStub {
  create: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  onAlarm: { addListener: (fn: (alarm: { name: string }) => void) => void };
}

let sessionStorage: Record<string, unknown>;
let alarms: AlarmStub;
let alarmListeners: ((alarm: { name: string }) => void)[];
let startupListeners: (() => void)[];
let settings: Record<string, unknown>;
let sentMessages: unknown[];
let armed: { name: string; scheduledTime: number } | undefined;

beforeEach(() => {
  closeDb();
  globalThis.indexedDB = new IDBFactory();
  sessionStorage = {};
  alarmListeners = [];
  startupListeners = [];
  settings = { autoLockMinutes: 720 };
  sentMessages = [];
  armed = undefined;
  alarms = {
    create: vi.fn((name: string, info: { delayInMinutes: number }) => {
      armed = { name, scheduledTime: Date.now() + info.delayInMinutes * 60_000 };
    }),
    clear: vi.fn(async () => {
      armed = undefined;
      return true;
    }),
    get: vi.fn(async () => armed),
    onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
  };
  (globalThis as Record<string, unknown>).chrome = {
    alarms,
    tabs: {
      query: async () => [{ id: 1 }, { id: 2 }, {}],
      sendMessage: async (_id: number, message: unknown) => {
        sentMessages.push(message);
      },
    },
    runtime: {
      sendMessage: async (message: unknown) => {
        sentMessages.push(message);
      },
      onStartup: { addListener: (fn: () => void) => startupListeners.push(fn) },
      onInstalled: { addListener: (fn: () => void) => startupListeners.push(fn) },
    },
    storage: {
      local: {
        get: async () => ({ settings }),
        set: async (patch: Record<string, unknown>) => {
          settings = { ...settings, ...(patch.settings as Record<string, unknown>) };
        },
      },
      session: {
        get: async (k: string) => ({ [k]: sessionStorage[k] }),
        set: async (patch: Record<string, unknown>) => Object.assign(sessionStorage, patch),
        remove: async (k: string) => {
          delete sessionStorage[k];
        },
      },
    },
  };
});

describe("session lock", () => {
  it("unlock makes the key readable and arms the auto-lock alarm", async () => {
    await unlockSession(key("k"));
    expect(await sessionKey()).toMatchObject({ label: "k" });
    expect(alarms.create).toHaveBeenCalledWith("entz-auto-lock", { delayInMinutes: 720 });
  });

  it("lockNow drops the session record, the sentinel and the alarm", async () => {
    await unlockSession(key("k"));
    await lockNow();
    expect(await readSession()).toBeUndefined();
    expect(sessionStorage).toEqual({});
    expect(await sessionKey()).toBeUndefined();
    expect(alarms.clear).toHaveBeenCalledWith("entz-auto-lock");
  });

  it("lockNow tells every tab to drop the plaintext it is showing", async () => {
    await unlockSession(key("k"));
    await lockNow();
    expect(sentMessages).toEqual([{ type: "locked" }, { type: "locked" }, { type: "locked" }]);
  });

  it("a session record without its sentinel is stale and gets deleted", async () => {
    await writeSession(key("stale"));
    expect(await sessionKey()).toBeUndefined();
    expect(await readSession()).toBeUndefined();
  });

  it("the startup and install listeners lock", async () => {
    installSessionListeners();
    await unlockSession(key("k"));
    for (const listener of startupListeners) listener();
    await vi.waitFor(async () => expect(await readSession()).toBeUndefined());
  });

  it("the auto-lock alarm locks, and other alarms do not", async () => {
    installSessionListeners();
    await unlockSession(key("k"));
    for (const listener of alarmListeners) listener({ name: "something-else" });
    expect(await readSession()).toBeDefined();
    for (const listener of alarmListeners) listener({ name: "entz-auto-lock" });
    await vi.waitFor(async () => expect(await readSession()).toBeUndefined());
  });

  it("arms the alarm at the configured delay", async () => {
    settings = { autoLockMinutes: 60 };
    await scheduleAutoLock();
    expect(alarms.create).toHaveBeenCalledWith("entz-auto-lock", { delayInMinutes: 60 });
  });

  it("leaves an alarm already armed at the same target alone", async () => {
    await scheduleAutoLock();
    await scheduleAutoLock();
    expect(alarms.create).toHaveBeenCalledTimes(1);
  });

  it("rearms when the configured delay changes", async () => {
    await scheduleAutoLock();
    settings = { autoLockMinutes: 60 };
    await scheduleAutoLock();
    expect(alarms.create).toHaveBeenCalledTimes(2);
    expect(alarms.create).toHaveBeenLastCalledWith("entz-auto-lock", { delayInMinutes: 60 });
  });
});
