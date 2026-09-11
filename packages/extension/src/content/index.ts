import { formatFingerprint, MARKER, parseEnvelope } from "@entziffer/core";
import { type Broadcast, send } from "../shared/messages.js";
import { createLru } from "./cache.js";
import { installGuard } from "./guard.js";
import { allLayers, dimLayer, foreignLayer, type HighlightLayer, tagLayer } from "./highlight.js";
import { hits, sortedRects } from "./hit.js";
import {
  ensurePane,
  isPaneEvent,
  moveCard,
  type PaneHandlers,
  type Point,
  type Preview,
  removePane,
  shownKey,
  showPreview,
  TYPOGRAPHY_PROPERTIES,
  type Typography,
  type TypographyProperty,
} from "./pane.js";
import { isAttached, isOwnNode, rangeOf, scan, splitToken, type TokenLocation } from "./scan.js";

const DEBOUNCE_MS = 100;
const CACHE_LIMIT = 256;
const MAX_ROOTS = 32;

type CacheEntry = { ok: true; text: string } | { ok: false; code: string };

const LOCKED: CacheEntry = { ok: false, code: "LOCKED" };

/**
 * One token the card speaks for: `range` is the whole token, `tag` the marker the tag layer
 * styles, `body` the ciphertext after it that the dim layer fades. Everything from `typography`
 * down is measured once per scan — `rects` again on scroll and resize — since the pointer is
 * hit-tested against every token on every frame it moves.
 */
interface Known {
  key: string;
  loc: TokenLocation;
  range: Range;
  tag: Range;
  body: Range;
  result: CacheEntry;
  typography: Typography;
  textColor: string;
  rects: DOMRect[] | null;
  tagIn: HighlightLayer | null;
  dimIn: HighlightLayer | null;
}

const cache = createLru<CacheEntry>(CACHE_LIMIT);
let known: Known[] = [];
let knownNodes = new Set<Text>();
let nextKey = 0;

let hovered: string | null = null;
let cursor: Point = { x: 0, y: 0 };
let pinnedKey: string | null = null;
let hoverFrame = 0;

let locked = false;
/**
 * Bumped whenever every answer the page holds stops being valid. A decrypt that was in flight
 * across the bump drops its reply rather than repopulating the cache behind a lock.
 */
let generation = 0;
let observer: MutationObserver | null = null;
let pending = new Set<Node>();
let timer = 0;
const listeners = new AbortController();
let removeGuard: (() => void) | null = null;

function findKnown(index: Map<Text, Known[]>, loc: TokenLocation): Known | undefined {
  return index
    .get(loc.startNode)
    ?.find((k) => k.loc.token === loc.token && k.loc.startOffset === loc.startOffset);
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
  k.tagIn?.delete(k.tag);
  k.dimIn?.delete(k.body);
  k.tagIn = null;
  k.dimIn = null;
}

function clearHighlights(): void {
  for (const layer of allLayers()) layer.clear();
  for (const k of known) {
    k.tagIn = null;
    k.dimIn = null;
  }
}

/**
 * The typography the card renders the plaintext in, and the colour the token's text is drawn in,
 * which is what its fade must be mixed from.
 */
function measure(range: Range): { typography: Typography; textColor: string } {
  const el = range.startContainer.parentElement ?? document.body;
  const style = getComputedStyle(el);
  const block = el.closest("p, h1, h2, h3, h4, h5, h6, li, td, th, div, span") ?? el;
  const styles = {} as Record<TypographyProperty, string>;
  for (const property of TYPOGRAPHY_PROPERTIES) {
    styles[property] = style.getPropertyValue(property);
  }
  return {
    typography: { styles, blockWidth: block.getBoundingClientRect().width },
    textColor: style.color,
  };
}

/**
 * Every known token's marker is tagged in the accent, or in grey when this key cannot open it,
 * and every ciphertext body is faded except the one under the cursor. Only the memberships that
 * differ from the last paint are touched, so a pointer moving between tokens costs two edits.
 */
function paint(active: string | null): void {
  for (const k of known) {
    const tag = k.result.ok || locked ? tagLayer() : foreignLayer();
    if (k.tagIn !== tag) {
      k.tagIn?.delete(k.tag);
      tag.add(k.tag);
      k.tagIn = tag;
    }
    const dim = k.key === active ? null : dimLayer(k.textColor);
    if (k.dimIn !== dim) {
      k.dimIn?.delete(k.body);
      dim?.add(k.body);
      k.dimIn = dim;
    }
  }
}

/** A locked session has no plaintext to show, whatever the token's last result was. */
function toPreview(k: Known): Preview {
  const base = { key: k.key, typography: k.typography };
  if (locked) return { ...base, reason: "locked" };
  if (k.result.ok) return { ...base, text: k.result.text };
  if (k.result.code === "FPR_MISMATCH")
    return { ...base, reason: "foreign", fingerprint: fingerprintOf(k.loc.token) };
  return { ...base, reason: "broken" };
}

/**
 * One rule decides what the page lights up and what the card shows: the token under the cursor,
 * else the one it was pinned to, else nothing. A token is pinned by a click on it or by an edit
 * the page refused, and stays pinned until the cursor finds another token or Escape is pressed.
 * The card sits by the cursor while it is over the token, and by the token's tag when it was
 * pinned from elsewhere.
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

function rectsOf(k: Known): DOMRect[] {
  k.rects ??= sortedRects(k.range);
  return k.rects;
}

function invalidateRects(): void {
  for (const k of known) k.rects = null;
}

function hitTest(x: number, y: number): string | null {
  return known.find((k) => hits(rectsOf(k), x, y))?.key ?? null;
}

function onPointerMove(event: MouseEvent): void {
  if (known.length === 0) return;
  if (isPaneEvent(event)) {
    setHovered(null);
    return;
  }
  cursor = { x: event.clientX, y: event.clientY };
  if (hoverFrame !== 0) return;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    const key = hitTest(cursor.x, cursor.y);
    setHovered(key);
    if (key !== null && key === shownKey()) moveCard(cursor);
  });
}

function onPointerLeave(): void {
  setHovered(null);
}

/** A modified or non-primary press keeps whatever the page means by it, links included. */
function isPlainPrimary(event: MouseEvent): boolean {
  return event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}

function onPress(event: MouseEvent): void {
  if (!locked || !isPlainPrimary(event) || isPaneEvent(event)) return;
  if (hitTest(event.clientX, event.clientY) === null) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

/**
 * While the session is locked, a click on a token asks to unlock instead of pinning it, and the
 * page never sees it: a token inside a link or a row that navigates would otherwise take the
 * click away before the unlock is asked for. Listeners run in the capture phase, ahead of the
 * page's own, and cancel the press as well as the click, since apps navigate on either. An
 * unlocked session pins the token and leaves the page's own handling untouched. See
 * {@link isPlainPrimary}.
 */
function onClick(event: MouseEvent): void {
  if (isPaneEvent(event)) return;
  const key = hitTest(event.clientX, event.clientY);
  if (key !== null && locked) {
    if (!isPlainPrimary(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
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
  invalidateRects();
  knownNodes = new Set();
  for (const k of known) {
    knownNodes.add(k.loc.startNode);
    knownNodes.add(k.loc.endNode);
  }
  if (known.length === 0) {
    removePane();
    return;
  }
  known.sort((a, b) => a.range.compareBoundaryPoints(Range.START_TO_START, b.range));
  ensurePane(handlers);
  if (pinnedKey !== null && !known.some((k) => k.key === pinnedKey)) pinnedKey = null;
  renderActive();
}

function remember(index: Map<Text, Known[]>, loc: TokenLocation, result: CacheEntry): void {
  const range = rangeOf(loc);
  const existing = findKnown(index, loc);
  if (existing !== undefined) {
    forget(existing);
    const { typography, textColor } = measure(range);
    Object.assign(existing, {
      loc,
      range,
      ...splitToken(loc, range),
      result,
      typography,
      textColor,
    });
    existing.rects = null;
    return;
  }
  known.push({
    key: `entz-${nextKey++}`,
    loc,
    range,
    ...splitToken(loc, range),
    result,
    ...measure(range),
    rects: null,
    tagIn: null,
    dimIn: null,
  });
}

/** Every answer the page holds is void: the session locked while they were on screen. */
function lockDown(): void {
  generation++;
  locked = true;
  cache.clear();
  for (const k of known) k.result = LOCKED;
  hovered = null;
  pinnedKey = null;
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
    (t) => cache.get(t) === undefined,
  );
  if (missing.length > 0) {
    const mine = generation;
    const reply = await send({ type: "decrypt", tokens: missing });
    if (!reply.ok) {
      if (chrome.runtime?.id === undefined) teardown();
      return;
    }
    if (mine !== generation) return;
    const { results } = reply.data;
    // A LOCKED result is about the session, not the token: caching it would survive the unlock.
    if (results.some((r) => !r.ok && r.code === "LOCKED")) lockDown();
    else for (const [i, result] of results.entries()) cache.set(missing[i] as string, result);
  }
  const index = new Map<Text, Known[]>();
  for (const k of known) {
    const bucket = index.get(k.loc.startNode);
    if (bucket === undefined) index.set(k.loc.startNode, [k]);
    else bucket.push(k);
  }
  for (const loc of locations) {
    if (!isAttached(loc)) continue;
    const entry = cache.get(loc.token) ?? (locked ? LOCKED : undefined);
    if (entry !== undefined) remember(index, loc, entry);
  }
  refreshPane();
}

function schedule(root: Node): void {
  pending.add(root);
  clearTimeout(timer);
  timer = setTimeout(() => void processPendingRoots(), DEBOUNCE_MS) as unknown as number;
}

function carriesToken(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node as Text;
    return text.data.includes(MARKER) || knownNodes.has(text);
  }
  return (node.textContent ?? "").includes(MARKER);
}

/**
 * Whether a record could have added, changed or removed a token. An app rewriting hundreds of
 * unrelated nodes is dropped here rather than counted towards {@link MAX_ROOTS}, which would
 * escalate the next scan to a walk of the whole body.
 */
function isInteresting(record: MutationRecord): boolean {
  if (record.type === "attributes") return true;
  if (record.type === "characterData") return carriesToken(record.target);
  for (const node of record.addedNodes) if (carriesToken(node)) return true;
  for (const node of record.removedNodes) if (carriesToken(node)) return true;
  return false;
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
    if (!isInteresting(record)) continue;
    schedule(target);
  }
}

/**
 * Drops everything entziffer derived from the page: pending work, known tokens, highlights and
 * the pane. The page's own text was never touched.
 */
function stop(): void {
  generation++;
  observer?.disconnect();
  observer = null;
  clearTimeout(timer);
  timer = 0;
  pending = new Set();
  cancelAnimationFrame(hoverFrame);
  hoverFrame = 0;
  clearHighlights();
  known = [];
  knownNodes = new Set();
  hovered = null;
  pinnedKey = null;
  removePane();
}

/**
 * Leaves the page as entziffer found it, listeners included. Used when the extension's context is
 * gone — reloaded, disabled, or its permission for this origin revoked — after which an orphaned
 * content script could still serve the plaintext it holds. See {@link stop}.
 */
function teardown(): void {
  stop();
  cache.clear();
  removeGuard?.();
  removeGuard = null;
  listeners.abort();
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
  schedule(document.body);
}

chrome.runtime.onMessage.addListener((message: Broadcast) => {
  if (message.type === "unlocked") {
    generation++;
    locked = false;
    schedule(document.body);
    return;
  }
  if (message.type !== "locked") return;
  lockDown();
  renderActive();
});

const { signal } = listeners;
document.addEventListener("mousemove", onPointerMove, { passive: true, signal });
document.addEventListener("mouseleave", onPointerLeave, { signal });
document.addEventListener("pointerdown", onPress, { capture: true, signal });
document.addEventListener("mousedown", onPress, { capture: true, signal });
document.addEventListener("click", onClick, { capture: true, signal });
document.addEventListener("keydown", onKeyDown, { signal });
document.addEventListener("scroll", invalidateRects, { capture: true, passive: true, signal });
window.addEventListener("resize", invalidateRects, { passive: true, signal });
removeGuard = installGuard({
  tokens: () => known.filter((k) => k.loc.editable),
  onBlocked: pin,
});
start();
