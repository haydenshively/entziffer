import {
  b64urlDecode,
  b64urlEncode,
  DERIVATION_VERSION,
  decryptMany,
  deriveKeyFromPrf,
  EntzifferError,
  formatFingerprint,
  PUBLIC_KEY_PREFIX,
} from "@entziffer/core";
import {
  isPrivileged,
  type KeyIdentity,
  type KeyStatus,
  type Request,
  type RequestType,
  type Response,
  type ResponseData,
} from "../shared/messages.js";
import { broadcastUnlocked } from "./broadcast.js";
import { clearKey, type KeyRecord, readKey, readSession, writeKey } from "./keystore.js";
import {
  installSessionListeners,
  lockNow,
  rememberUnlockTab,
  scheduleAutoLock,
  sessionKey,
  unlockSession,
  unlockTabId,
} from "./session.js";
import { getSettings, setSettings } from "./settings.js";

const UNLOCK_PAGE = "unlock/index.html";

const DYNAMIC_SCRIPT_ID = "entz-enabled-origins";
const ALL_URLS = "<all_urls>";

function identityOf(record: KeyRecord): KeyIdentity {
  return {
    publicKey: PUBLIC_KEY_PREFIX + b64urlEncode(new Uint8Array(record.publicRaw)),
    fingerprint: formatFingerprint(new Uint8Array(record.fpr)),
  };
}

async function statusOf(record?: KeyRecord): Promise<KeyStatus> {
  const found = record ?? (await readKey());
  if (found === undefined) {
    return { hasKey: false, locked: false, identity: null, enrolledAt: null };
  }
  return {
    hasKey: true,
    locked: (await sessionKey()) === undefined,
    identity: identityOf(found),
    enrolledAt: found.enrolledAt,
  };
}

async function openUnlockTab(): Promise<void> {
  const url = chrome.runtime.getURL(UNLOCK_PAGE);
  const existing = await unlockTabId();
  if (existing !== undefined) {
    const tab = await chrome.tabs.get(existing).catch(() => undefined);
    if (tab?.url === url && tab.id !== undefined) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
      return;
    }
  }
  const tab = await chrome.tabs.create({ url });
  if (tab.id !== undefined) await rememberUnlockTab(tab.id);
}

function sameKey(a: ArrayBuffer, b: Uint8Array): boolean {
  const left = new Uint8Array(a);
  return left.length === b.length && left.every((byte, i) => byte === b[i]);
}

type AnyResponseData = ResponseData[RequestType];

async function handle(request: Request): Promise<AnyResponseData> {
  switch (request.type) {
    case "getStatus":
      return { status: await statusOf() };
    case "getUnlockParams": {
      const record = await readKey();
      return {
        params: {
          credentialId:
            record === undefined ? null : b64urlEncode(new Uint8Array(record.credentialId)),
        },
      };
    }
    case "requestUnlock":
      await openUnlockTab();
      return {};
    case "setupKey": {
      const { privateKey, publicRaw, fpr } = await deriveKeyFromPrf(b64urlDecode(request.prf));
      const record = await writeKey(b64urlDecode(request.credentialId), publicRaw, fpr);
      await unlockSession(privateKey);
      await broadcastUnlocked();
      return { status: await statusOf(record) };
    }
    case "unlock": {
      const record = await readKey();
      if (record === undefined) throw new EntzifferError("NO_KEY", "no key in this browser");
      const { privateKey, publicRaw } = await deriveKeyFromPrf(b64urlDecode(request.prf));
      if (record.derivation !== DERIVATION_VERSION) {
        throw new EntzifferError(
          "PRF_UNSUPPORTED",
          `this key was enrolled with derivation v${record.derivation}, which this build cannot reproduce`,
        );
      }
      if (!sameKey(record.publicRaw, publicRaw)) {
        throw new EntzifferError(
          "KEY_MISMATCH",
          "that passkey belongs to a different entziffer key",
        );
      }
      // A ceremony that fell back to the browser picker can report a different credential id for
      // the same key; storing it keeps the next unlock a one-tap `allowCredentials` prompt.
      const stored =
        request.credentialId !== undefined &&
        !sameKey(record.credentialId, b64urlDecode(request.credentialId))
          ? await writeKey(
              b64urlDecode(request.credentialId),
              publicRaw,
              new Uint8Array(record.fpr),
              record.enrolledAt,
            )
          : record;
      await unlockSession(privateKey);
      await broadcastUnlocked();
      return { status: await statusOf(stored) };
    }
    case "lockNow":
      await lockNow();
      return {};
    case "decrypt": {
      const record = await readKey();
      if (!record) throw new EntzifferError("NO_KEY", "no key in this browser");
      const privateKey = await sessionKey();
      if (privateKey === undefined) {
        return { results: request.tokens.map(() => ({ ok: false, code: "LOCKED" }) as const) };
      }
      return { results: await decryptMany(request.tokens, privateKey, new Uint8Array(record.fpr)) };
    }
    case "getSettings":
      return { settings: await getSettings() };
    case "setSettings": {
      const settings = await setSettings(request.patch);
      await syncDynamicScripts();
      if (request.patch.autoLockMinutes !== undefined) await scheduleAutoLock();
      return { settings };
    }
    case "forgetKey":
      await clearKey();
      return {};
    default:
      throw new Error(`unknown message ${String((request as Request).type)}`);
  }
}

chrome.runtime.onMessage.addListener(
  (request: Request, sender, sendResponse: (r: Response) => void) => {
    if (isPrivileged(request.type) && !sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, code: "FORBIDDEN", message: "extension pages only" });
      return false;
    }
    handle(request)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e: unknown) =>
        sendResponse({
          ok: false,
          code: e instanceof EntzifferError ? e.code : "INTERNAL",
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    return true;
  },
);

/**
 * The content script runs nowhere until an origin is enabled: this registration is the only
 * thing that injects it, and an origin whose host permission has been revoked is dropped.
 */
async function syncDynamicScripts(): Promise<void> {
  const { enabledOrigins, allSites } = await getSettings();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
  if (existing.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
  }
  const matches: string[] = [];
  if (allSites && (await chrome.permissions.contains({ origins: [ALL_URLS] }))) {
    matches.push(ALL_URLS);
  } else {
    for (const origin of enabledOrigins) {
      const pattern = `${origin}/*`;
      if (await chrome.permissions.contains({ origins: [pattern] })) matches.push(pattern);
    }
  }
  if (matches.length === 0) return;
  await chrome.scripting.registerContentScripts([
    {
      id: DYNAMIC_SCRIPT_ID,
      js: ["content.js"],
      matches,
      runAt: "document_idle",
      persistAcrossSessions: false,
    },
  ]);
}

chrome.runtime.onStartup.addListener(() => void syncDynamicScripts());
chrome.runtime.onInstalled.addListener(() => void syncDynamicScripts());
chrome.permissions.onAdded.addListener(() => void syncDynamicScripts());
chrome.permissions.onRemoved.addListener(() => void syncDynamicScripts());

installSessionListeners();

if (import.meta.env.VITE_E2E === "1") {
  const hexToBytes = (hex: string): Uint8Array =>
    Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
  /** Stands in for a real ceremony: the same PRF bytes a virtual authenticator would return. */
  (globalThis as Record<string, unknown>).__entzSeedFromPrf = async (
    prfHex: string,
  ): Promise<unknown> =>
    handle({
      type: "setupKey",
      credentialId: b64urlEncode(new Uint8Array([1, 2, 3, 4])),
      prf: b64urlEncode(hexToBytes(prfHex)),
    });
  (globalThis as Record<string, unknown>).__entzSetSettings = (patch: unknown) =>
    setSettings(patch as Parameters<typeof setSettings>[0]);
  (globalThis as Record<string, unknown>).__entzClearKey = clearKey;
  (globalThis as Record<string, unknown>).__entzGetLocal = async (key: string): Promise<unknown> =>
    (await chrome.storage.local.get(key))[key];
  (globalThis as Record<string, unknown>).__entzClearLocal = (key: string) =>
    chrome.storage.local.remove(key);
  (globalThis as Record<string, unknown>).__entzKeyRecordMeta = async () => {
    const record = await readKey();
    if (record === null || record === undefined) return null;
    return {
      credentialIdBytes: new Uint8Array(record.credentialId).length,
      fields: Object.keys(record).sort(),
      enrolledAt: record.enrolledAt,
    };
  };
  (globalThis as Record<string, unknown>).__entzUnlockWithPrf = (prfHex: string) =>
    handle({ type: "unlock", prf: b64urlEncode(hexToBytes(prfHex)) });
  (globalThis as Record<string, unknown>).__entzLockNow = lockNow;
  (globalThis as Record<string, unknown>).__entzStatus = () => handle({ type: "getStatus" });
  /** The exact function the `onStartup` listener runs, so the E2E can exercise it in one browser. */
  (globalThis as Record<string, unknown>).__entzRunStartupHandler = lockNow;
  (globalThis as Record<string, unknown>).__entzHasSessionRecord = async () =>
    (await readSession()) !== undefined;
  (globalThis as Record<string, unknown>).__entzClearSessionSentinel = () =>
    chrome.storage.session.clear();
}
