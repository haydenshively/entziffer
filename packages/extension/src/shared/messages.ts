import type { DecryptResult, EntzifferErrorCode } from "@entziffer/core";

/** The only auto-lock delays the UI offers, in minutes: 1h, 4h, 12h, 24h. */
export const AUTO_LOCK_CHOICES = [60, 240, 720, 1440] as const;

export type AutoLockMinutes = (typeof AUTO_LOCK_CHOICES)[number];

export interface Settings {
  overlayOnly: boolean;
  /** Origins (`https://example.com`) the user enabled; each one holds its own host permission. */
  enabledOrigins: string[];
  /** Set by "Enable on all sites", which requests `<all_urls>`. */
  allSites: boolean;
  /** Minutes of inactivity before the derived key is dropped. */
  autoLockMinutes: AutoLockMinutes;
}

export interface KeyIdentity {
  publicKey: string;
  fingerprint: string;
}

export interface KeyStatus {
  hasKey: boolean;
  locked: boolean;
  identity: KeyIdentity | null;
  /** Epoch millis of the passkey set-up. */
  enrolledAt: number | null;
}

/**
 * The credential to ask for, base64url-encoded. `null` means run a discoverable-credential
 * ceremony with an empty `allowCredentials` — the new-Mac case.
 */
export interface UnlockParams {
  credentialId: string | null;
}

export type Request =
  | { type: "getStatus" }
  | { type: "getUnlockParams" }
  | { type: "requestUnlock" }
  | { type: "setupKey"; credentialId: string; prf: string }
  | { type: "unlock"; credentialId?: string; prf: string }
  | { type: "lockNow" }
  | { type: "decrypt"; tokens: string[] }
  | { type: "getSettings" }
  | { type: "setSettings"; patch: Partial<Settings> }
  | { type: "forgetKey" };

export type RequestType = Request["type"];

/** Message types the service worker only honours from extension pages (options, popup). */
export const PRIVILEGED_TYPES = [
  "getUnlockParams",
  "setupKey",
  "unlock",
  "lockNow",
  "forgetKey",
] as const satisfies readonly RequestType[];

export type PrivilegedType = (typeof PRIVILEGED_TYPES)[number];

export function isPrivileged(type: RequestType): type is PrivilegedType {
  return (PRIVILEGED_TYPES as readonly RequestType[]).includes(type);
}

export interface ResponseData {
  getStatus: { status: KeyStatus };
  getUnlockParams: { params: UnlockParams };
  requestUnlock: Record<string, never>;
  setupKey: { status: KeyStatus };
  unlock: { status: KeyStatus };
  lockNow: Record<string, never>;
  decrypt: { results: DecryptResult[] };
  getSettings: { settings: Settings };
  setSettings: { settings: Settings };
  forgetKey: Record<string, never>;
}

export type ErrorCode = EntzifferErrorCode | "FORBIDDEN" | "INTERNAL";

/** Broadcast to every tab after a successful unlock so content scripts can retry their tokens. */
export interface UnlockedBroadcast {
  type: "unlocked";
}

/**
 * Broadcast on every lock, including the auto-lock alarm. Receiving it obliges a content script to
 * remove the plaintext it is showing, not merely to stop asking for more.
 */
export interface LockedBroadcast {
  type: "locked";
}

export type Broadcast = UnlockedBroadcast | LockedBroadcast;

export type Response<K extends RequestType = RequestType> =
  | { ok: true; data: ResponseData[K] }
  | { ok: false; code: ErrorCode; message: string };

export const DEFAULT_SETTINGS: Settings = {
  overlayOnly: false,
  enabledOrigins: [],
  allSites: false,
  autoLockMinutes: 720,
};

/**
 * Resolves rather than rejects on a dead service worker, so callers on a page always get a
 * `Response` and never an unhandled rejection during extension reloads.
 */
export async function send<K extends RequestType>(
  request: Extract<Request, { type: K }>,
): Promise<Response<K>> {
  try {
    const reply = (await chrome.runtime.sendMessage(request)) as Response<K> | undefined;
    return reply ?? { ok: false, code: "INTERNAL", message: "no response" };
  } catch (e) {
    return { ok: false, code: "INTERNAL", message: e instanceof Error ? e.message : String(e) };
  }
}
