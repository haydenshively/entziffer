import "fake-indexeddb/auto";
import { DERIVATION_VERSION } from "@entziffer/core";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearKey,
  clearSession,
  RESET_NOTICE_KEY,
  readKey,
  readSession,
  writeKey,
  writeSession,
} from "../src/sw/keystore.js";

const key = (label: string): CryptoKey => ({ label }) as unknown as CryptoKey;

const credentialId = new Uint8Array([1, 2, 3]);
const publicRaw = new Uint8Array(32).fill(1);
const fpr = new Uint8Array(4).fill(2);

let localStorageSet: ReturnType<typeof vi.fn>;

/** Recreates the shape the extension shipped before the key became passkey-derived. */
function seedOldDatabase(version: number, record: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("entziffer", version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("keys")) db.createObjectStore("keys", { keyPath: "id" });
      if (version > 1 && !db.objectStoreNames.contains("session")) {
        db.createObjectStore("session", { keyPath: "id" });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("keys", "readwrite");
      tx.objectStore("keys").put(record);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  localStorageSet = vi.fn();
  (globalThis as Record<string, unknown>).chrome = { storage: { local: { set: localStorageSet } } };
});

describe("keystore v4", () => {
  it.each([1, 2])("discards a v%i record and flags the reset", async (version) => {
    await seedOldDatabase(version, {
      id: "self",
      privateKey: key("old"),
      publicRaw: publicRaw.buffer,
      fpr: fpr.buffer,
      backup: "entz1sk_old",
      createdAt: 42,
    });

    expect(await readKey()).toBeUndefined();
    expect(localStorageSet).toHaveBeenCalledWith({ [RESET_NOTICE_KEY]: true });
  });

  it("stamps a v3 record with the derivation version instead of discarding it", async () => {
    await seedOldDatabase(3, {
      id: "self",
      credentialId: credentialId.buffer,
      publicRaw: publicRaw.buffer,
      fpr: fpr.buffer,
      enrolledAt: 7,
    });

    expect(await readKey()).toMatchObject({ enrolledAt: 7, derivation: DERIVATION_VERSION });
    expect(localStorageSet).not.toHaveBeenCalled();
  });

  it("round trips a record and stores no private key", async () => {
    const written = await writeKey(credentialId, publicRaw, fpr, 7);
    expect(written.enrolledAt).toBe(7);
    const record = await readKey();
    expect(record).not.toHaveProperty("privateKey");
    expect(record && new Uint8Array(record.credentialId)).toEqual(credentialId);
    expect(Object.keys(record ?? {}).sort()).toEqual([
      "credentialId",
      "derivation",
      "enrolledAt",
      "fpr",
      "id",
      "publicRaw",
    ]);
    expect(record?.derivation).toBe(DERIVATION_VERSION);
    expect(localStorageSet).not.toHaveBeenCalled();
  });

  it("clearing the key also clears the session", async () => {
    await writeKey(credentialId, publicRaw, fpr);
    await writeSession(key("session"));
    expect(await readSession()).toBeDefined();
    await clearKey();
    expect(await readKey()).toBeUndefined();
    expect(await readSession()).toBeUndefined();
  });

  it("clearSession leaves the key alone", async () => {
    await writeKey(credentialId, publicRaw, fpr);
    await writeSession(key("session"));
    await clearSession();
    expect(await readSession()).toBeUndefined();
    expect(await readKey()).toBeDefined();
  });
});
