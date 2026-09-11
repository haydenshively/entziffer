import {
  AUTO_LOCK_CHOICES,
  type AutoLockMinutes,
  DEFAULT_SETTINGS,
  type Settings,
} from "../shared/messages.js";

const STORAGE_KEY = "settings";

/** Rebuilt field by field, so fields older builds stored are dropped rather than carried forward. */
export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as unknown;
  const autoLockMinutes = (stored as Partial<Settings> | undefined)?.autoLockMinutes;
  return {
    autoLockMinutes: isAutoLockChoice(autoLockMinutes)
      ? autoLockMinutes
      : DEFAULT_SETTINGS.autoLockMinutes,
  };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next: Settings = { autoLockMinutes: patch.autoLockMinutes ?? current.autoLockMinutes };
  if (!isAutoLockChoice(next.autoLockMinutes)) {
    throw new Error(`invalid autoLockMinutes: ${String(next.autoLockMinutes)}`);
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

function isAutoLockChoice(value: unknown): value is AutoLockMinutes {
  return (AUTO_LOCK_CHOICES as readonly unknown[]).includes(value);
}
