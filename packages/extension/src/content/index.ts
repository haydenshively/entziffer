import { formatFingerprint, parseEnvelope } from "@entziffer/core";
import { type Broadcast, DEFAULT_SETTINGS, type Settings, send } from "../shared/messages.js";
import { mountOverlay, type Overlay } from "./overlay.js";
import { installPopover } from "./popover.js";
import {
  BADGE_ATTR,
  insertBadge,
  insertLockBadge,
  isAttached,
  LOCK_BADGE_ATTR,
  removeLockBadges,
  replaceInPlace,
  revertAll,
} from "./render.js";
import { isEditable, isOwnNode, scan, type TokenLocation } from "./scan.js";

const DEBOUNCE_MS = 100;
const CACHE_LIMIT = 2000;
const MAX_ROOTS = 32;

type CacheEntry = { ok: true; text: string } | { ok: false; code: string };

const cache = new Map<string, CacheEntry>();
const ownNodes = new WeakSet<Node>();
const dismissed = new WeakMap<Text, { data: string; tokens: Set<string> }>();
let overlays: Overlay[] = [];

let settings: Settings = DEFAULT_SETTINGS;
/** Set as soon as one token comes back `LOCKED`, so overlay-only pages can still report the state. */
let locked = false;
let observer: MutationObserver | null = null;
let pending = new Set<Node>();
let timer = 0;

function cacheGet(token: string): CacheEntry | undefined {
  const hit = cache.get(token);
  if (hit !== undefined) {
    cache.delete(token);
    cache.set(token, hit);
  }
  return hit;
}

function cacheSet(token: string, entry: CacheEntry): void {
  cache.set(token, entry);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

function isDismissed(loc: TokenLocation): boolean {
  const state = dismissed.get(loc.startNode);
  if (state === undefined) return false;
  if (state.data !== loc.startNode.data) {
    dismissed.delete(loc.startNode);
    return false;
  }
  return state.tokens.has(loc.token);
}

function dismiss(overlay: Overlay): void {
  const state = dismissed.get(overlay.loc.startNode) ?? {
    data: overlay.loc.startNode.data,
    tokens: new Set<string>(),
  };
  state.data = overlay.loc.startNode.data;
  state.tokens.add(overlay.token);
  dismissed.set(overlay.loc.startNode, state);
  overlay.destroy();
  overlays = overlays.filter((o) => o !== overlay);
}

function findOverlay(loc: TokenLocation): Overlay | undefined {
  return overlays.find(
    (o) =>
      o.token === loc.token &&
      o.loc.startNode === loc.startNode &&
      o.loc.startOffset === loc.startOffset,
  );
}

function hasBadgeBefore(loc: TokenLocation): boolean {
  if (loc.startOffset !== 0) return false;
  const previous = loc.startNode.previousSibling;
  return previous instanceof Element && previous.hasAttribute(BADGE_ATTR);
}

function renderToken(loc: TokenLocation, entry: CacheEntry): void {
  if (!isAttached(loc) || isDismissed(loc)) return;

  if (!entry.ok) {
    if (entry.code === "LOCKED") {
      locked = true;
      if (loc.editable || settings.overlayOnly || document.querySelector(`[${LOCK_BADGE_ATTR}]`)) {
        return;
      }
      const badge = insertLockBadge(loc, () => void send({ type: "requestUnlock" }));
      if (badge !== null) ownNodes.add(badge);
      return;
    }
    if (entry.code !== "FPR_MISMATCH") return;
    if (loc.editable || settings.overlayOnly || hasBadgeBefore(loc)) return;
    let label = "unknown";
    try {
      label = formatFingerprint(parseEnvelope(loc.token).fpr);
    } catch {
      return;
    }
    const badge = insertBadge(loc, label);
    if (badge !== null) ownNodes.add(badge);
    return;
  }

  if (!loc.editable && !settings.overlayOnly) {
    ownNodes.add(replaceInPlace(loc, entry.text));
    return;
  }

  const existing = findOverlay(loc);
  if (existing !== undefined) {
    existing.reposition();
    return;
  }
  const overlay = mountOverlay(loc, entry.text, dismiss);
  ownNodes.add(overlay.element);
  overlays.push(overlay);
}

async function processPendingRoots(): Promise<void> {
  const roots = pending.size > MAX_ROOTS ? [document.body] : [...pending];
  pending = new Set();

  const seen = new Map<Text, Set<string>>();
  const locations: TokenLocation[] = [];
  for (const root of roots) {
    if (!root.isConnected) continue;
    for (const loc of scan(root)) {
      const key = `${loc.startOffset}|${loc.token}`;
      let keys = seen.get(loc.startNode);
      if (keys === undefined) {
        keys = new Set();
        seen.set(loc.startNode, keys);
      }
      if (keys.has(key)) continue;
      keys.add(key);
      locations.push(loc);
    }
  }
  overlays = overlays.filter((o) => {
    if (isAttached(o.loc)) return true;
    o.destroy();
    return false;
  });
  if (locations.length === 0) return;

  const missing = [...new Set(locations.map((l) => l.token))].filter(
    (t) => cacheGet(t) === undefined,
  );
  if (missing.length > 0) {
    const reply = await send({ type: "decrypt", tokens: missing });
    if (!reply.ok) return;
    for (const [i, result] of reply.data.results.entries()) {
      // A LOCKED result is about the session, not the token: caching it would survive the unlock.
      if (!result.ok && result.code === "LOCKED") locked = true;
      else cacheSet(missing[i] as string, result);
    }
  }
  // Reverse document order: an in-place replacement shifts the offsets of every later token
  // that shares its text node, but never those of an earlier one.
  for (let i = locations.length - 1; i >= 0; i--) {
    const loc = locations[i] as TokenLocation;
    const entry =
      cacheGet(loc.token) ?? (locked ? ({ ok: false, code: "LOCKED" } as const) : undefined);
    if (entry !== undefined) renderToken(loc, entry);
  }
}

function schedule(root: Node): void {
  pending.add(root);
  clearTimeout(timer);
  timer = setTimeout(() => void processPendingRoots(), DEBOUNCE_MS) as unknown as number;
}

function onMutations(records: MutationRecord[]): void {
  for (const record of records) {
    const target =
      record.type === "characterData" ? (record.target.parentNode ?? record.target) : record.target;
    if (ownNodes.has(record.target) || isOwnNode(target)) continue;
    if (record.type === "attributes") {
      if (isEditable(target)) revertAll(target as Element);
      schedule(target);
      continue;
    }
    if (record.type === "childList") {
      const touched = [...record.addedNodes, ...record.removedNodes];
      if (touched.length > 0 && touched.every((n) => ownNodes.has(n) || isOwnNode(n))) continue;
    }
    schedule(target);
  }
}

/** Leaves the page as entziffer found it: no overlays, and ciphertext back in every text node. */
function stop(): void {
  observer?.disconnect();
  observer = null;
  for (const overlay of overlays) overlay.destroy();
  overlays = [];
  revertAll(document);
}

async function start(): Promise<void> {
  const reply = await send({ type: "getSettings" });
  const next = reply.ok ? reply.data.settings : settings;
  const rendersDifferently = next.overlayOnly !== settings.overlayOnly;
  settings = next;
  if (rendersDifferently) stop();
  if (observer === null) {
    observer = new MutationObserver(onMutations);
    observer.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["contenteditable"],
    });
  }
  cache.clear();
  schedule(document.body);
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || overlays.length === 0) return;
  for (const overlay of [...overlays]) dismiss(overlay);
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") void start();
});

chrome.runtime.onMessage.addListener((message: Broadcast) => {
  if (message.type === "unlocked") {
    locked = false;
    removeLockBadges();
    schedule(document.body);
    return;
  }
  if (message.type !== "locked") return;
  locked = true;
  cache.clear();
  stop();
  void start();
});

installPopover();
void start();
