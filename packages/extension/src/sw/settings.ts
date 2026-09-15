import {
  AUTO_LOCK_CHOICES,
  type AutoLockMinutes,
  DEFAULT_SETTINGS,
  type Settings,
} from "../shared/messages.js";

const STORAGE_KEY = "settings";

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEY] as Partial<Settings> | undefined) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next: Settings = { ...(await getSettings()), ...patch };
  if (!isAutoLockChoice(next.autoLockMinutes)) {
    throw new Error(`invalid autoLockMinutes: ${String(next.autoLockMinutes)}`);
  }
  next.enabledOrigins = unique(next.enabledOrigins);
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

function isAutoLockChoice(value: number): value is AutoLockMinutes {
  return (AUTO_LOCK_CHOICES as readonly number[]).includes(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
