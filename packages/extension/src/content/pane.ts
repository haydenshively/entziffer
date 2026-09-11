import { attachLens, el } from "./lens.js";
import { type Corner, createMotion, type Motion } from "./motion.js";
import { createShadowHost } from "./shadow.js";

export const CARD_ATTR = "data-entz-card";
/** The glass surface inside the card; the card itself is the shell that is clipped and sprung. */
export const GLASS_ATTR = "data-entz-glass";
export const TEXT_ATTR = "data-entz-text";
/** Set while the card says the session is locked, which makes a click on it ask to unlock. */
export const LOCKED_ATTR = "data-entz-locked";

const EDGE_PX = 4;
const MARGIN_PX = 16;
const MAX_CARD_WIDTH_PX = 720;
const MIN_CARD_WIDTH_PX = 160;
/** How far the card sits from the cursor, so the cursor never covers the first word. */
const CURSOR_GAP_PX = 14;

/**
 * Every longhand that shapes how text renders. Copied one by one because the `font` shorthand
 * serialises to "" as soon as any longhand is non-default, which is the norm on a tuned type
 * stack: https://drafts.csswg.org/cssom/#serialize-a-css-value
 */
export const TYPOGRAPHY_PROPERTIES = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-variant-caps",
  "font-variant-numeric",
  "font-variant-ligatures",
  "font-feature-settings",
  "font-variation-settings",
  "font-kerning",
  "font-optical-sizing",
  "-webkit-font-smoothing",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-transform",
  "text-rendering",
  "color",
] as const;

export type TypographyProperty = (typeof TYPOGRAPHY_PROPERTIES)[number];

/** The computed typography of the text a token sits in, so its plaintext renders the same way. */
export interface Typography {
  styles: Record<TypographyProperty, string>;
  /** Width of the block the token wraps in; the card wraps the plaintext at the same width. */
  blockWidth: number;
}

/** What the card shows for the token under the cursor: its plaintext, or why there is none. */
export type Preview = { key: string; typography: Typography } & (
  | { text: string }
  | { reason: "locked" | "broken" }
  | { reason: "foreign"; fingerprint: string | null }
);

export interface PaneHandlers {
  /** Asked for by a click on the card, or the token, while the session is locked. */
  unlock(): void;
}

/** A viewport point the card should sit next to: the cursor, or a token's tag. */
export interface Point {
  x: number;
  y: number;
}

interface Shown {
  preview: Preview;
  /** Where the card was last placed, and the corner it grew from; `null` until it is placed. */
  placed: Point | null;
  corner: Corner | null;
}

interface Pane {
  host: HTMLElement;
  card: HTMLElement;
  glass: HTMLElement;
  handlers: PaneHandlers;
  motion: Motion;
  showing: Shown | null;
  detachLens(): void;
}

let pane: Pane | null = null;

const textOf = (preview: Preview): string | null => ("text" in preview ? preview.text : null);
const reasonOf = (preview: Preview): string | null => ("reason" in preview ? preview.reason : null);
const fingerprintOf = (preview: Preview): string | null =>
  "reason" in preview && preview.reason === "foreign" ? preview.fingerprint : null;

function sameContent(a: Preview, b: Preview): boolean {
  return (
    a.key === b.key &&
    textOf(a) === textOf(b) &&
    reasonOf(a) === reasonOf(b) &&
    fingerprintOf(a) === fingerprintOf(b)
  );
}

const PADLOCK_PATHS = [
  "M5 11h14a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z",
  "M7 11V7a5 5 0 0 1 10 0v4",
];

function padlock(): SVGSVGElement {
  const node = el("svg", {
    viewBox: "0 0 24 24",
    width: "13",
    height: "13",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  });
  for (const d of PADLOCK_PATHS) node.appendChild(el("path", { d }));
  return node;
}

function mount(handlers: PaneHandlers): Pane {
  const { host, root } = createShadowHost();
  const card = document.createElement("div");
  card.className = "card";
  card.setAttribute(CARD_ATTR, "");
  card.hidden = true;
  const glass = document.createElement("div");
  glass.className = "card-glass";
  glass.setAttribute(GLASS_ATTR, "");
  card.appendChild(glass);
  root.appendChild(card);
  const created: Pane = {
    host,
    card,
    glass,
    handlers,
    motion: createMotion(card, glass),
    showing: null,
    detachLens: attachLens(root, glass),
  };
  card.addEventListener("click", (event) => {
    event.stopPropagation();
    if (card.hasAttribute(LOCKED_ATTR)) created.handlers.unlock();
  });
  return created;
}

function note(preview: Preview): HTMLElement {
  const node = document.createElement("div");
  node.className = "card-note";
  node.append(padlock());
  const label = document.createElement("span");
  label.textContent =
    reasonOf(preview) === "locked"
      ? "Locked · click to unlock"
      : reasonOf(preview) === "foreign"
        ? `Encrypted for someone else · ${fingerprintOf(preview) ?? "unknown"}`
        : "Couldn't decrypt this token";
  node.appendChild(label);
  return node;
}

function plaintext(preview: Preview, text: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "card-text";
  node.setAttribute(TEXT_ATTR, "");
  node.textContent = text;
  for (const property of TYPOGRAPHY_PROPERTIES) {
    node.style.setProperty(property, preview.typography.styles[property]);
  }
  return node;
}

/** Mounts the card's host on first use, so a page without tokens carries nothing of entziffer's. */
export function ensurePane(handlers: PaneHandlers): void {
  pane = pane ?? mount(handlers);
  pane.handlers = handlers;
}

/**
 * Puts the card beside `at`: above and to the right of it, flipping to the left or below when
 * that would leave the viewport, so the cursor never sits on the card it is dragging along.
 * Above rather than below because the browser draws a page's own `title` tooltip below and to
 * the right of a resting cursor, and it would otherwise cover the card. The card itself lags the
 * new spot on a spring: see {@link Motion.shift}.
 */
export function moveCard(at: Point): void {
  if (pane === null || pane.showing === null) return;
  const { offsetWidth: width, offsetHeight: height } = pane.card;
  let left = at.x + CURSOR_GAP_PX;
  let horizontal: "left" | "right" = "left";
  if (left + width > window.innerWidth - EDGE_PX) {
    left = at.x - CURSOR_GAP_PX - width;
    horizontal = "right";
  }
  let top = at.y - CURSOR_GAP_PX - height;
  let vertical: "top" | "bottom" = "bottom";
  if (top < EDGE_PX) {
    top = at.y + CURSOR_GAP_PX;
    vertical = "top";
  }
  left = Math.max(EDGE_PX, left);
  top = Math.max(EDGE_PX, Math.min(top, window.innerHeight - EDGE_PX - height));
  const corner: Corner = `${vertical}-${horizontal}`;
  const { placed, corner: was } = pane.showing;
  if (placed !== null) {
    if (was !== null && was !== corner) pane.motion.jump(corner);
    else pane.motion.shift(left - placed.x, top - placed.y);
  }
  pane.showing.placed = { x: left, y: top };
  pane.showing.corner = corner;
  pane.card.style.left = `${left}px`;
  pane.card.style.top = `${top}px`;
}

/**
 * Shows `preview` in the card beside `at`, in the typography of the text it was decrypted from
 * and wrapped at that text's width, or takes the card down for `null`. The card keeps where it
 * sits when `at` is omitted. The card is the only place that plaintext exists outside the
 * extension's own pages.
 */
export function showPreview(preview: Preview | null, at?: Point): void {
  if (pane === null) return;
  const self = pane;
  if (preview === null) {
    if (self.showing === null) return;
    self.showing = null;
    self.motion.close(() => {
      if (pane !== self || self.showing !== null) return;
      self.card.hidden = true;
      self.glass.replaceChildren();
    });
    return;
  }
  const current = self.showing;
  const fresh = current === null;
  if (current === null || !sameContent(current.preview, preview)) {
    self.showing = { preview, placed: current?.placed ?? null, corner: current?.corner ?? null };
    const width = Math.min(
      MAX_CARD_WIDTH_PX,
      window.innerWidth - 2 * MARGIN_PX,
      Math.max(MIN_CARD_WIDTH_PX, preview.typography.blockWidth),
    );
    const text = textOf(preview);
    self.card.style.maxWidth = `${width}px`;
    self.card.toggleAttribute(LOCKED_ATTR, reasonOf(preview) === "locked");
    self.glass.replaceChildren(text === null ? note(preview) : plaintext(preview, text));
    self.card.hidden = false;
  }
  if (fresh) self.motion.reset();
  if (at !== undefined) moveCard(at);
  if (fresh) self.motion.open(self.showing?.corner ?? undefined);
}

/** The key of the token the card is showing, if any. */
export function shownKey(): string | null {
  return pane?.showing?.preview.key ?? null;
}

/** True when `event` originated inside the card, whose shadow boundary retargets it to the host. */
export function isPaneEvent(event: Event): boolean {
  return pane !== null && event.composedPath().includes(pane.host);
}

export function removePane(): void {
  if (pane === null) return;
  pane.motion.reset();
  pane.detachLens();
  pane.host.remove();
  pane = null;
}
