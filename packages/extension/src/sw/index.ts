import {
  b64urlDecode,
  b64urlEncode,
  DERIVATION_VERSION,
  decryptMany,
  deriveKeyFromPrf,
  EntzifferError,
  formatFingerprint,
  PUBLIC_KEY_PREFIX,
  parseEnvelope,
} from "@entziffer/core";
import {
  isPrivileged,
  type KeyIdentity,
  type KeyStatus,
  type Request,
  type RequestType,
  type Response,
  type ResponseData,
  type TokenResult,
} from "../shared/messages.js";
import { changedPeople, lookupByFingerprint, setPeople } from "../shared/people.js";
import { broadcastPeople, broadcastUnlocked } from "./broadcast.js";
import { clearKey, type KeyRecord, readKey, readSession, writeKey } from "./keystore.js";
import { syncDynamicScripts } from "./scripts.js";
import {
  installSessionListeners,
  lockNow,
  rememberUnlockWindow,
  scheduleAutoLock,
  sessionKey,
  unlockSession,
  unlockWindowId,
} from "./session.js";
import { getSettings, setSettings } from "./settings.js";

const UNLOCK_PAGE = "unlock/index.html";
const UNLOCK_WINDOW = { width: 440, height: 400 };

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

/**
 * Runs the passkey ceremony in a small popup window centred on the caller's window rather than in
 * a tab: the page has to be extension-origin for WebAuthn, and a popup that closes itself hands
 * focus straight back to the tab the user was on. One popup at a time; a second request refocuses it.
 */
async function openUnlockWindow(sender: chrome.runtime.MessageSender): Promise<void> {
  const url = chrome.runtime.getURL(UNLOCK_PAGE);
  const existing = await unlockWindowId();
  if (existing !== undefined) {
    const open = await chrome.windows.get(existing, { populate: true }).catch(() => undefined);
    if (open?.tabs?.some((tab) => tab.url === url)) {
      await chrome.windows.update(existing, { focused: true, drawAttention: true });
      return;
    }
  }
  const parent =
    sender.tab === undefined
      ? await chrome.windows.getLastFocused().catch(() => undefined)
      : await chrome.windows.get(sender.tab.windowId).catch(() => undefined);
  const centred =
    parent?.left !== undefined &&
    parent.width !== undefined &&
    parent.top !== undefined &&
    parent.height !== undefined
      ? {
          left: Math.round(parent.left + (parent.width - UNLOCK_WINDOW.width) / 2),
          top: Math.round(parent.top + (parent.height - UNLOCK_WINDOW.height) / 2),
        }
      : {};
  const created = await chrome.windows.create({
    url,
    type: "popup",
    focused: true,
    ...UNLOCK_WINDOW,
    ...centred,
  });
  if (created?.id !== undefined) await rememberUnlockWindow(created.id);
}

/**
 * Names the recipient of every token this key could not open, so the card can say whose a foreign
 * token is. One lookup per distinct fingerprint, and none at all for a page of readable tokens.
 */
async function withRecipients(results: TokenResult[], tokens: string[]): Promise<TokenResult[]> {
  const names = new Map<string, string | null>();
  const out: TokenResult[] = [];
  for (const [i, result] of results.entries()) {
    if (result.ok || result.code !== "FPR_MISMATCH") {
      out.push(result);
      continue;
    }
    let fpr: string;
    try {
      fpr = formatFingerprint(parseEnvelope(tokens[i] as string).fpr);
    } catch {
      out.push(result);
      continue;
    }
    if (!names.has(fpr)) names.set(fpr, await lookupByFingerprint(fpr));
    const name = names.get(fpr) ?? null;
    out.push(name === null ? result : { ...result, recipient: name });
  }
  return out;
}

function sameKey(a: ArrayBuffer, b: Uint8Array): boolean {
  const left = new Uint8Array(a);
  return left.length === b.length && left.every((byte, i) => byte === b[i]);
}

type AnyResponseData = ResponseData[RequestType];

async function handle(
  request: Request,
  sender: chrome.runtime.MessageSender = {},
): Promise<AnyResponseData> {
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
      await openUnlockWindow(sender);
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
      const results = await decryptMany(request.tokens, privateKey, new Uint8Array(record.fpr));
      return { results: await withRecipients(results, request.tokens) };
    }
    case "getSettings":
      return { settings: await getSettings() };
    case "setSettings": {
      const settings = await setSettings(request.patch);
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
    handle(request, sender)
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changedPeople(changes)) void broadcastPeople();
});

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
  (globalThis as Record<string, unknown>).__entzSetPeople = (people: unknown) =>
    setPeople(people as Parameters<typeof setPeople>[0]);
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
