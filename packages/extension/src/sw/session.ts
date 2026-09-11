import { broadcastLocked } from "./broadcast.js";
import { clearSession, readSession, writeSession } from "./keystore.js";
import { getSettings } from "./settings.js";

const SENTINEL_KEY = "sessionAlive";
const UNLOCK_WINDOW_KEY = "unlockWindowId";
const AUTO_LOCK_ALARM = "entz-auto-lock";
const AUTO_LOCK_SLACK_MS = 60_000;

/**
 * `storage.session` is cleared by a browser restart and by an extension reload, neither of which
 * reliably fires `onStartup`; IndexedDB survives both. A session record without its sentinel is
 * therefore stale and must never unlock anything.
 */
async function sentinelPresent(): Promise<boolean> {
  const stored = await chrome.storage.session.get(SENTINEL_KEY);
  return stored[SENTINEL_KEY] === true;
}

/** The unlocked private key, or `undefined` when locked. Reschedules the inactivity alarm on use. */
export async function sessionKey(): Promise<CryptoKey | undefined> {
  if (!(await sentinelPresent())) {
    await clearSession();
    return undefined;
  }
  const record = await readSession();
  if (record === undefined) return undefined;
  await scheduleAutoLock();
  return record.privateKey;
}

export async function unlockSession(privateKey: CryptoKey): Promise<void> {
  await writeSession(privateKey);
  await chrome.storage.session.set({ [SENTINEL_KEY]: true });
  await scheduleAutoLock();
}

/** Drops the key and tells every tab to throw away the plaintext it is already showing. */
export async function lockNow(): Promise<void> {
  await clearSession();
  await chrome.storage.session.remove(SENTINEL_KEY);
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
  await broadcastLocked();
}

/** Rearms only when the armed alarm has drifted past {@link AUTO_LOCK_SLACK_MS}, so a burst of
 * decrypts costs one `alarms.get` rather than a clear-and-create each. */
export async function scheduleAutoLock(): Promise<void> {
  const { autoLockMinutes } = await getSettings();
  const target = Date.now() + autoLockMinutes * 60_000;
  const armed = await chrome.alarms.get(AUTO_LOCK_ALARM);
  if (armed !== undefined && Math.abs(target - armed.scheduledTime) < AUTO_LOCK_SLACK_MS) return;
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
  chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: autoLockMinutes });
}

export async function rememberUnlockWindow(windowId: number): Promise<void> {
  await chrome.storage.session.set({ [UNLOCK_WINDOW_KEY]: windowId });
}

export async function unlockWindowId(): Promise<number | undefined> {
  const stored = await chrome.storage.session.get(UNLOCK_WINDOW_KEY);
  const id = stored[UNLOCK_WINDOW_KEY];
  return typeof id === "number" ? id : undefined;
}

export function installSessionListeners(): void {
  chrome.runtime.onStartup.addListener(() => void lockNow());
  chrome.runtime.onInstalled.addListener(() => void lockNow());
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_LOCK_ALARM) void lockNow();
  });
}
