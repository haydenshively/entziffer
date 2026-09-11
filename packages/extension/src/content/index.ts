import { formatFingerprint, MARKER, parseEnvelope } from "@entziffer/core";
import { type Broadcast, send } from "../shared/messages.js";
import { installGuard } from "./guard.js";
import { allLayers, dimLayer, foreignLayer, tagLayer } from "./highlight.js";
import {
  isPaneEvent,
  moveCard,
  type PaneHandlers,
  type Point,
  type Preview,
  removePane,
  renderPane,
  shownKey,
  showPreview,
  TYPOGRAPHY_PROPERTIES,
  type Typography,
  type TypographyProperty,
} from "./pane.js";
import { isAttached, isOwnNode, rangeOf, scan, type TokenLocation } from "./scan.js";

const DEBOUNCE_MS = 100;
const CACHE_LIMIT = 2000;
const MAX_ROOTS = 32;
/** Slack a token's client rects get for hit-testing the pointer, in CSS pixels. */
const HIT_SLACK_PX = 2;

type CacheEntry = { ok: true; text: string } | { ok: false; code: string };

const LOCKED: CacheEntry = { ok: false, code: "LOCKED" };

/**
 * One token the card speaks for: `range` is the whole token, `tag` the marker the tag layer
 * styles, `body` the ciphertext after it that the dim layer fades.
 */
interface Known {
  key: string;
  loc: TokenLocation;
  range: Range;
  tag: Range;
  body: Range;
  result: CacheEntry;
}

const cache = new Map<string, CacheEntry>();
let known: Known[] = [];
let nextKey = 0;

/** The token under the cursor in the page, if any, and where the cursor last was. */
let hovered: string | null = null;
let cursor: Point = { x: 0, y: 0 };
/** A token shown until the cursor moves on: a click on it, or an edit the page refused. */
let pinnedKey: string | null = null;
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

function forget(k: Known): void {
  for (const layer of allLayers()) {
    layer.delete(k.tag);
    layer.delete(k.body);
  }
}

function clearHighlights(): void {
  for (const layer of allLayers()) layer.clear();
}

/** The colour the token's text is drawn in, which is what its fade must be mixed from. */
function textColorOf(k: Known): string {
  const el = k.range.startContainer.parentElement;
  return el === null ? "canvastext" : getComputedStyle(el).color;
}

/**
 * Every known token's marker is tagged in the accent, or in grey when this key cannot open it,
 * and every ciphertext body is faded except the one under the cursor.
 */
function paint(active: string | null): void {
  clearHighlights();
  for (const k of known) {
    (k.result.ok || locked ? tagLayer() : foreignLayer()).add(k.tag);
    if (k.key !== active) dimLayer(textColorOf(k)).add(k.body);
  }
}

/**
 * Splits a token's range at the end of its `ENTZ1:` marker into the tag and the ciphertext body.
 * A marker split across text nodes makes the whole token the tag and leaves an empty body.
 */
function split(loc: TokenLocation, range: Range): { tag: Range; body: Range } {
  const at = loc.token.indexOf(MARKER);
  const end = loc.startOffset + at + MARKER.length;
  const body = range.cloneRange();
  if (at < 0 || end > loc.startNode.length) {
    body.collapse(false);
    return { tag: range, body };
  }
  const tag = range.cloneRange();
  tag.setStart(loc.startNode, loc.startOffset + at);
  tag.setEnd(loc.startNode, end);
  body.setStart(loc.startNode, end);
  return { tag, body };
}

function typographyOf(k: Known): Typography {
  const el = k.range.startContainer.parentElement ?? document.body;
  const style = getComputedStyle(el);
  const block = el.closest("p, h1, h2, h3, h4, h5, h6, li, td, th, div, span") ?? el;
  const styles = {} as Record<TypographyProperty, string>;
  for (const property of TYPOGRAPHY_PROPERTIES) {
    styles[property] = style.getPropertyValue(property);
  }
  return { styles, blockWidth: block.getBoundingClientRect().width };
}

function toPreview(k: Known): Preview {
  return {
    key: k.key,
    text: k.result.ok ? k.result.text : null,
    reason: locked
      ? "locked"
      : k.result.ok
        ? null
        : k.result.code === "FPR_MISMATCH"
          ? "foreign"
          : "broken",
    fingerprint:
      !k.result.ok && k.result.code === "FPR_MISMATCH" ? fingerprintOf(k.loc.token) : null,
    typography: typographyOf(k),
  };
}

/**
 * One rule decides what the page lights up and what the card shows: the token under the cursor,
 * else the one it was pinned to, else nothing. The card sits by the cursor while it is over the
 * token, and by the token's tag when it was pinned from elsewhere.
 */
function renderActive(): void {
  show(hovered ?? pinnedKey);
}

function show(key: string | null): void {
  const k = key === null ? undefined : known.find((entry) => entry.key === key);
  paint(k?.key ?? null);
  if (k === undefined) {
    showPreview(null);
    return;
  }
  const already = shownKey() === k.key;
  if (hovered === k.key) showPreview(toPreview(k), cursor);
  else if (already) showPreview(toPreview(k));
  else {
    const rect = k.tag.getClientRects()[0];
    showPreview(toPreview(k), rect === undefined ? cursor : { x: rect.left, y: rect.bottom });
  }
}

function setHovered(key: string | null): void {
  if (hovered === key) return;
  hovered = key;
  if (key !== null && key !== pinnedKey) pinnedKey = null;
  renderActive();
}

const handlers: PaneHandlers = {
  unlock() {
    void send({ type: "requestUnlock" });
  },
};

/**
 * Whether (`x`, `y`) is over `range`. A range's client rects cover only the glyph boxes, so a
 * wrapped token has a dead strip between its lines wherever the line height exceeds the font;
 * each line's hit area therefore reaches to the midpoint of the gap to the line above and below.
 */
function hits(range: Range, x: number, y: number): boolean {
  const rects = [...range.getClientRects()].sort((a, b) => a.top - b.top);
  for (const [i, rect] of rects.entries()) {
    if (x < rect.left - HIT_SLACK_PX || x > rect.right + HIT_SLACK_PX) continue;
    const above = rects
      .slice(0, i)
      .reverse()
      .find((r) => r.bottom <= rect.top);
    const below = rects.slice(i + 1).find((r) => r.top >= rect.bottom);
    const top = above === undefined ? rect.top - HIT_SLACK_PX : (above.bottom + rect.top) / 2;
    const bottom = below === undefined ? rect.bottom + HIT_SLACK_PX : (rect.bottom + below.top) / 2;
    if (y >= top && y <= bottom) return true;
  }
  return false;
}

function hitTest(x: number, y: number): string | null {
  return known.find((k) => hits(k.range, x, y))?.key ?? null;
}

function onPointerMove(event: MouseEvent): void {
  if (known.length === 0 || hoverFrame !== 0) return;
  if (isPaneEvent(event)) {
    setHovered(null);
    return;
  }
  const { clientX, clientY } = event;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    cursor = { x: clientX, y: clientY };
    const key = hitTest(clientX, clientY);
    setHovered(key);
    if (key !== null && key === shownKey()) moveCard(cursor);
  });
}

function onPointerLeave(): void {
  setHovered(null);
}

/**
 * A click on a token keeps its card up until the cursor finds another token or Escape is pressed;
 * while the session is locked it asks to unlock instead.
 */
function onClick(event: MouseEvent): void {
  if (isPaneEvent(event)) return;
  const key = hitTest(event.clientX, event.clientY);
  if (key !== null && locked) {
    handlers.unlock();
    return;
  }
  pinnedKey = key;
  renderActive();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || pinnedKey === null) return;
  pinnedKey = null;
  renderActive();
}

function pin(key: string): void {
  pinnedKey = key;
  renderActive();
}

function fingerprintOf(token: string): string | null {
  try {
    return formatFingerprint(parseEnvelope(token).fpr);
  } catch {
    return null;
  }
}

function refreshPane(): void {
  if (known.length === 0) {
    removePane();
    return;
  }
  known.sort((a, b) => a.range.compareBoundaryPoints(Range.START_TO_START, b.range));
  renderPane(known.length, handlers);
  if (pinnedKey !== null && !known.some((k) => k.key === pinnedKey)) pinnedKey = null;
  renderActive();
}

function remember(loc: TokenLocation, result: CacheEntry): void {
  const existing = findKnown(loc);
  if (existing !== undefined) {
    existing.result = result;
    return;
  }
  const range = rangeOf(loc);
  known.push({ key: `entz-${nextKey++}`, loc, range, ...split(loc, range), result });
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
  hovered = null;
  pinnedKey = null;
  removePane();
}

function start(): void {
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
    schedule(document.body);
    return;
  }
  if (message.type !== "locked") return;
  locked = true;
  cache.clear();
  stop();
  start();
});

document.addEventListener("mousemove", onPointerMove, { passive: true });
document.addEventListener("mouseleave", onPointerLeave);
document.addEventListener("click", onClick);
document.addEventListener("keydown", onKeyDown);
installGuard({
  tokens: () => known.filter((k) => k.loc.editable),
  onBlocked: pin,
});
start();
