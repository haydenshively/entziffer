import {
  b64urlDecode,
  fingerprint,
  formatFingerprint,
  PUBLIC_KEY_PREFIX,
  RAW_KEY_BYTES,
} from "@entziffer/core";

/** One address-book entry. The fingerprint is derived from `publicKey`, never stored. */
export interface Person {
  name: string;
  publicKey: string;
}

const STORAGE_KEY = "people";

function isKeyString(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith(PUBLIC_KEY_PREFIX)) return false;
  try {
    return b64urlDecode(value.slice(PUBLIC_KEY_PREFIX.length)).length === RAW_KEY_BYTES;
  } catch {
    return false;
  }
}

/** Rebuilt entry by entry, so anything another build or a bad sync left behind is dropped. */
function sanitize(value: unknown): Person[] {
  if (!Array.isArray(value)) return [];
  const people: Person[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, publicKey } = entry as Partial<Person>;
    if (typeof name !== "string" || name.trim() === "" || !isKeyString(publicKey)) continue;
    if (people.some((p) => p.publicKey === publicKey)) continue;
    people.push({ name: name.trim(), publicKey });
  }
  return people;
}

export async function getPeople(): Promise<Person[]> {
  return sanitize((await chrome.storage.sync.get(STORAGE_KEY))[STORAGE_KEY]);
}

export async function setPeople(people: Person[]): Promise<Person[]> {
  const next = sanitize(people);
  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  return next;
}

/** True for a `chrome.storage.onChanged` record that touched the address book. */
export const changedPeople = (changes: Record<string, unknown>): boolean => STORAGE_KEY in changes;

export async function fingerprintOf(publicKey: string): Promise<string> {
  const raw = b64urlDecode(publicKey.slice(PUBLIC_KEY_PREFIX.length));
  return formatFingerprint(await fingerprint(raw));
}

/**
 * The address book's name for whoever a token is encrypted *to*, or `null`. Names sharing a
 * fingerprint are joined with " or ".
 *
 * A token's fingerprint is a routing hint its sender chose, not authentication: anyone can label a
 * token with any fingerprint and four bytes collide, so a name from here may only ever be shown as
 * whose the token is, never as who it came from.
 */
export async function lookupByFingerprint(fpr: string): Promise<string | null> {
  const people = await getPeople();
  const fprs = await Promise.all(people.map((p) => fingerprintOf(p.publicKey)));
  const names = people.filter((_, i) => fprs[i] === fpr).map((p) => p.name);
  return names.length === 0 ? null : names.join(" or ");
}

/**
 * The entries of a pasted `~/.config/entziffer/config.json`, or `null` when the text is not one.
 * Entries the file names but cannot be read as a key are skipped, as {@link getPeople} would.
 */
export function parseConfigRecipients(text: string): Person[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const recipients = (parsed as { recipients?: unknown } | null)?.recipients;
  if (typeof recipients !== "object" || recipients === null || Array.isArray(recipients)) {
    return null;
  }
  return sanitize(
    Object.entries(recipients as Record<string, { publicKey?: unknown }>).map(([name, entry]) => ({
      name,
      publicKey: entry?.publicKey,
    })),
  );
}
