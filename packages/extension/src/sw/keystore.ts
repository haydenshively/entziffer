import { DERIVATION_VERSION } from "@entziffer/core";

const DB_NAME = "entziffer";
const DB_VERSION = 4;
const KEYS_STORE = "keys";
const SESSION_STORE = "session";
const RECORD_ID = "self";
const SESSION_ID = "unlocked";

/**
 * Public data plus the passkey that regenerates the private key. No private key is ever at rest:
 * the X25519 key is derived from the passkey's PRF output at every unlock.
 */
export interface KeyRecord {
  id: typeof RECORD_ID;
  credentialId: ArrayBuffer;
  publicRaw: ArrayBuffer;
  fpr: ArrayBuffer;
  enrolledAt: number;
  /** The `DERIVATION_VERSION` the stored public key was produced with. */
  derivation: number;
}

export interface SessionRecord {
  id: typeof SESSION_ID;
  privateKey: CryptoKey;
  unlockedAt: number;
}

/** Set when {@link openDb} drops pre-v3 records, so the options page can explain the reset once. */
export const RESET_NOTICE_KEY = "keyStorageReset";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (upgrade) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEYS_STORE)) {
        db.createObjectStore(KEYS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: "id" });
      }
      // Pre-v3 records hold a private key no passkey can reproduce, so they are unusable now.
      if (upgrade.oldVersion > 0 && upgrade.oldVersion < 3 && req.transaction !== null) {
        req.transaction.objectStore(KEYS_STORE).clear();
        req.transaction.objectStore(SESSION_STORE).clear();
        void globalThis.chrome?.storage?.local?.set({ [RESET_NOTICE_KEY]: true });
      }
      // v3 predates the stored derivation version; v1 is the only scheme it could have used.
      if (upgrade.oldVersion === 3 && req.transaction !== null) {
        const store = req.transaction.objectStore(KEYS_STORE);
        const existing = store.get(RECORD_ID);
        existing.onsuccess = () => {
          const record = existing.result as KeyRecord | undefined;
          if (record !== undefined) store.put({ ...record, derivation: DERIVATION_VERSION });
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Reads the single stored key. The record is never cached in a module global: the service
 * worker is evicted at will, and a stale handle would outlive a key deletion.
 */
export async function readKey(): Promise<KeyRecord | undefined> {
  const record = await withStore<KeyRecord | undefined>(KEYS_STORE, "readonly", (s) =>
    s.get(RECORD_ID),
  );
  return record?.credentialId === undefined ? undefined : record;
}

export async function writeKey(
  credentialId: Uint8Array,
  publicRaw: Uint8Array,
  fpr: Uint8Array,
  enrolledAt = Date.now(),
): Promise<KeyRecord> {
  await navigator.storage?.persist?.();
  const record: KeyRecord = {
    id: RECORD_ID,
    credentialId: toArrayBuffer(credentialId),
    publicRaw: toArrayBuffer(publicRaw),
    fpr: toArrayBuffer(fpr),
    enrolledAt,
    derivation: DERIVATION_VERSION,
  };
  await withStore(KEYS_STORE, "readwrite", (s) => s.put(record));
  return record;
}

export async function clearKey(): Promise<void> {
  await withStore(KEYS_STORE, "readwrite", (s) => s.delete(RECORD_ID));
  await clearSession();
}

export async function readSession(): Promise<SessionRecord | undefined> {
  return withStore<SessionRecord | undefined>(SESSION_STORE, "readonly", (s) => s.get(SESSION_ID));
}

export async function writeSession(privateKey: CryptoKey): Promise<SessionRecord> {
  const record: SessionRecord = { id: SESSION_ID, privateKey, unlockedAt: Date.now() };
  await withStore(SESSION_STORE, "readwrite", (s) => s.put(record));
  return record;
}

export async function clearSession(): Promise<void> {
  await withStore(SESSION_STORE, "readwrite", (s) => s.delete(SESSION_ID));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
