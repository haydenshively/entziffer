import {
  type EntzPublicKey,
  encrypt,
  formatFingerprint,
  importPublicKey,
  MARKER,
  parseEnvelope,
} from "@entziffer/core";
import { type Broadcast, send } from "../shared/messages.js";
import { allowingWrites, installGuard } from "./guard.js";
import { activeLayer, dimLayer, foreignLayer, tagLayer } from "./highlight.js";
import { replaceInEditor } from "./insert.js";
import {
  focusEntry,
  isPaneEvent,
  type PaneEntry,
  type PaneHandlers,
  preservingPaneFocus,
  removePane,
  renderPane,
  setActive,
} from "./pane.js";
import { isAttached, isOwnNode, rangeOf, scan, type TokenLocation } from "./scan.js";

const DEBOUNCE_MS = 100;
const CACHE_LIMIT = 2000;
const MAX_ROOTS = 32;
/** Slack a token's client rects get for hit-testing the pointer, in CSS pixels. */
const HIT_SLACK_PX = 2;

type CacheEntry = { ok: true; text: string } | { ok: false; code: string };

const LOCKED: CacheEntry = { ok: false, code: "LOCKED" };

/** One token the pane speaks for: `range` is the whole token, `tag` the marker the layers style. */
interface Known {
  key: string;
  loc: TokenLocation;
  range: Range;
  tag: Range;
  result: CacheEntry;
}

const cache = new Map<string, CacheEntry>();
let known: Known[] = [];
let nextKey = 0;

let identity: string | null = null;
let recipient: EntzPublicKey | null = null;
/**
 * Ciphertext this content script just wrote into an editor, mapped to the pane entry that produced
 * it: the rescan sees a brand-new token where the old one was, and reusing the key keeps the row —
 * and the caret inside it — alive across the rewrite.
 */
const pendingRewrite = new Map<string, string>();
/** Where the cursor is and what it is over; `null` when it is over nothing of ours. */
let pointer: { source: "page" | "pane"; key: string } | null = null;
/** The entry whose textarea has keyboard focus, independent of where the cursor is. */
let typing: string | null = null;
let hoverFrame = 0;

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

function findKnown(loc: TokenLocation): Known | undefined {
  return known.find(
    (k) =>
      k.loc.token === loc.token &&
      k.loc.startNode === loc.startNode &&
      k.loc.startOffset === loc.startOffset,
  );
}

/** A range whose text is no longer its token belongs to an edit the page made underneath us. */
function isStale(k: Known): boolean {
  if (!isAttached(k.loc)) return true;
  try {
    return k.range.toString() !== k.loc.token;
  } catch {
    return true;
  }
}

const layers = () => [tagLayer(), activeLayer(), dimLayer(), foreignLayer()];

function forget(k: Known): void {
  for (const layer of layers()) layer.delete(k.tag);
}

function clearHighlights(): void {
  for (const layer of layers()) layer.clear();
}

/**
 * Every known token's marker is tagged, in exactly one layer: the plain tag, or the foreign tag
 * for a token this key cannot open. While `active` names an entry, its tag lights up and every
 * other one dims.
 */
function paint(active: string | null): void {
  clearHighlights();
  for (const k of known) {
    if (active === null) (k.result.ok || locked ? tagLayer() : foreignLayer()).add(k.tag);
    else (k.key === active ? activeLayer() : dimLayer()).add(k.tag);
  }
}

/** The `ENTZ1:` marker at the head of a token, or the whole token when the marker is split across nodes. */
function tagOf(loc: TokenLocation, range: Range): Range {
  const at = loc.token.indexOf(MARKER);
  const end = loc.startOffset + at + MARKER.length;
  if (at < 0 || end > loc.startNode.length) return range;
  const tag = range.cloneRange();
  tag.setStart(loc.startNode, loc.startOffset + at);
  tag.setEnd(loc.startNode, end);
  return tag;
}

/**
 * One rule decides what is highlighted on both sides: the cursor wins, then the textarea being
 * typed in. The pane only scrolls to an entry the cursor found in the page.
 */
function renderActive(): void {
  const active = pointer?.key ?? typing;
  paint(active);
  setActive(active, pointer?.source === "page");
}

function setPointer(next: typeof pointer): void {
  if (pointer?.source === next?.source && pointer?.key === next?.key) return;
  pointer = next;
  renderActive();
}

async function reencrypt(key: string, value: string): Promise<void> {
  const to = await recipientKey();
  if (to === null || value === "") return;
  const token = await encrypt(value, to);
  // Encrypting takes long enough for an Insert plaintext click, or the page itself, to have moved
  // the token out from under this range; writing through a stale one would corrupt the field.
  const k = known.find((entry) => entry.key === key);
  if (k === undefined || isStale(k)) return;
  cacheSet(token, { ok: true, text: value });
  pendingRewrite.set(token, key);
  const written = preservingPaneFocus(() => allowingWrites(() => replaceInEditor(k.loc, token)));
  if (!written) pendingRewrite.delete(token);
}

const handlers: PaneHandlers = {
  insert(key, value) {
    const k = known.find((entry) => entry.key === key);
    if (k === undefined || isStale(k)) return false;
    if (!allowingWrites(() => replaceInEditor(k.loc, value))) return false;
    forget(k);
    known = known.filter((entry) => entry !== k);
    refreshPane();
    return true;
  },
  edit(key, value) {
    void reencrypt(key, value);
  },
  hover(key) {
    setPointer(key === null ? null : { source: "pane", key });
  },
  typing(key) {
    typing = key;
    renderActive();
  },
  unlock() {
    void send({ type: "requestUnlock" });
  },
};

async function recipientKey(): Promise<EntzPublicKey | null> {
  if (identity === null) return null;
  if (recipient !== null) return recipient;
  try {
    recipient = await importPublicKey(identity);
  } catch {
    recipient = null;
  }
  return recipient;
}

async function refreshIdentity(): Promise<void> {
  const reply = await send({ type: "getStatus" });
  const next = reply.ok ? (reply.data.status.identity?.publicKey ?? null) : null;
  if (next === identity) return;
  identity = next;
  recipient = null;
}

function hitTest(x: number, y: number): string | null {
  for (const k of known) {
    for (const rect of k.range.getClientRects()) {
      if (
        x >= rect.left - HIT_SLACK_PX &&
        x <= rect.right + HIT_SLACK_PX &&
        y >= rect.top - HIT_SLACK_PX &&
        y <= rect.bottom + HIT_SLACK_PX
      ) {
        return k.key;
      }
    }
  }
  return null;
}

function onPointerMove(event: MouseEvent): void {
  if (known.length === 0 || hoverFrame !== 0) return;
  if (isPaneEvent(event)) {
    if (pointer?.source === "page") setPointer(null);
    return;
  }
  const { clientX, clientY } = event;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    if (pointer?.source === "pane") return;
    const key = hitTest(clientX, clientY);
    setPointer(key === null ? null : { source: "page", key });
  });
}

function onPointerLeave(): void {
  if (pointer?.source === "page") setPointer(null);
}

/** A click on a token's tag opens its entry in the pane, where the editing happens. */
function onClick(event: MouseEvent): void {
  if (isPaneEvent(event)) return;
  const key = hitTest(event.clientX, event.clientY);
  if (key !== null) focusEntry(key);
}

function fingerprintOf(token: string): string | null {
  try {
    return formatFingerprint(parseEnvelope(token).fpr);
  } catch {
    return null;
  }
}

function toEntry(k: Known): PaneEntry {
  return {
    key: k.key,
    text: k.result.ok ? k.result.text : null,
    fingerprint:
      !k.result.ok && k.result.code === "FPR_MISMATCH" ? fingerprintOf(k.loc.token) : null,
    editable: k.loc.editable,
  };
}

function refreshPane(): void {
  if (known.length === 0) {
    removePane();
    return;
  }
  known.sort((a, b) => a.range.compareBoundaryPoints(Range.START_TO_START, b.range));
  renderPane({ entries: known.map(toEntry), locked, writable: identity !== null, handlers });
  paint(pointer?.key ?? typing);
}

function remember(loc: TokenLocation, result: CacheEntry): void {
  const existing = findKnown(loc);
  if (existing !== undefined) {
    existing.result = result;
    return;
  }
  const reused = pendingRewrite.get(loc.token);
  pendingRewrite.delete(loc.token);
  const range = rangeOf(loc);
  known.push({ key: reused ?? `entz-${nextKey++}`, loc, range, tag: tagOf(loc, range), result });
}

async function processPendingRoots(): Promise<void> {
  const roots: Node[] = pending.size > MAX_ROOTS ? [document.body] : [...pending];
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
  known = known.filter((k) => {
    if (!isStale(k)) return true;
    forget(k);
    return false;
  });
  if (locations.length === 0) {
    refreshPane();
    return;
  }

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
  for (const loc of locations) {
    if (!isAttached(loc)) continue;
    const entry = cacheGet(loc.token) ?? (locked ? LOCKED : undefined);
    if (entry !== undefined) remember(loc, entry);
  }
  refreshPane();
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
    if (isOwnNode(target)) continue;
    if (record.type === "childList") {
      const touched = [...record.addedNodes, ...record.removedNodes];
      if (touched.length > 0 && touched.every((n) => isOwnNode(n))) continue;
    }
    schedule(target);
  }
}

/** Leaves the page as entziffer found it: no pane and no highlights; the text was never touched. */
function stop(): void {
  observer?.disconnect();
  observer = null;
  clearHighlights();
  known = [];
  pendingRewrite.clear();
  pointer = null;
  typing = null;
  removePane();
}

async function start(): Promise<void> {
  await refreshIdentity();
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

chrome.runtime.onMessage.addListener((message: Broadcast) => {
  if (message.type === "unlocked") {
    locked = false;
    void refreshIdentity();
    schedule(document.body);
    return;
  }
  if (message.type !== "locked") return;
  locked = true;
  cache.clear();
  stop();
  void start();
});

document.addEventListener("mousemove", onPointerMove, { passive: true });
document.addEventListener("mouseleave", onPointerLeave);
document.addEventListener("click", onClick);
installGuard({
  tokens: () => known.filter((k) => k.loc.editable),
  onBlocked: (key) => void focusEntry(key),
});
void start();
