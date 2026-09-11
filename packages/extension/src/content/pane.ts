import { attachLens } from "./lens.js";
import { createShadowHost } from "./shadow.js";

export const CARD_ATTR = "data-entz-card";
export const TEXT_ATTR = "data-entz-text";
/** Set while the card says the session is locked, which makes a click on it ask to unlock. */
export const LOCKED_ATTR = "data-entz-locked";

const EDGE_PX = 4;
const MARGIN_PX = 16;
/** The card never grows past this, whatever the token's own block measures. */
const MAX_CARD_WIDTH_PX = 720;
const MIN_CARD_WIDTH_PX = 160;
/** How far the card sits from the cursor, so the cursor never covers the first word. */
const CURSOR_GAP_PX = 14;

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Every longhand that shapes how text renders. Copied one by one because the `font` shorthand
 * serialises to "" as soon as any longhand (feature settings, variation settings, numeric
 * variants) is non-default, which is the norm on pages with a tuned type stack.
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

/** What the card shows for the token under the cursor. */
export interface Preview {
  key: string;
  /** The plaintext, or `null` when it cannot be shown: see {@link Preview.reason}. */
  text: string | null;
  /** Why there is no plaintext; `fingerprint` names the other recipient when the envelope parses. */
  reason: "locked" | "foreign" | "broken" | null;
  fingerprint: string | null;
  typography: Typography;
}

export interface PaneHandlers {
  /** Asked for by a click on the card, or the token, while the session is locked. */
  unlock(): void;
}

/** A viewport point the card should sit next to: the cursor, or a token's tag. */
export interface Point {
  x: number;
  y: number;
}

interface Pane {
  host: HTMLElement;
  card: HTMLElement;
  handlers: PaneHandlers;
  shown: string | null;
  /** What the card was built from, so a token whose result changed underneath it is redrawn. */
  signature: string | null;
  detachLens(): void;
}

let pane: Pane | null = null;

function svg(paths: string[], size: string): SVGSVGElement {
  const node = document.createElementNS(SVG_NS, "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", size);
  node.setAttribute("height", size);
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "2");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    node.appendChild(path);
  }
  return node;
}

const padlock = (): SVGSVGElement =>
  svg(
    [
      "M5 11h14a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z",
      "M7 11V7a5 5 0 0 1 10 0v4",
    ],
    "13",
  );

function mount(handlers: PaneHandlers): Pane {
  const { host, root } = createShadowHost();
  const card = document.createElement("div");
  card.className = "card";
  card.setAttribute(CARD_ATTR, "");
  card.hidden = true;
  card.addEventListener("click", (event) => {
    event.stopPropagation();
    if (pane?.card.hasAttribute(LOCKED_ATTR)) pane.handlers.unlock();
  });
  root.appendChild(card);
  const created: Pane = {
    host,
    card,
    handlers,
    shown: null,
    signature: null,
    detachLens: attachLens(root, card),
  };
  pane = created;
  return created;
}

function note(preview: Preview): HTMLElement {
  const el = document.createElement("div");
  el.className = "card-note";
  el.append(padlock());
  const label = document.createElement("span");
  label.textContent =
    preview.reason === "locked"
      ? "Locked · click to unlock"
      : preview.reason === "foreign"
        ? `Encrypted for someone else · ${preview.fingerprint ?? "unknown"}`
        : "Couldn't decrypt this token";
  el.appendChild(label);
  return el;
}

function plaintext(preview: Preview, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "card-text";
  el.setAttribute(TEXT_ATTR, "");
  el.textContent = text;
  for (const property of TYPOGRAPHY_PROPERTIES) {
    el.style.setProperty(property, preview.typography.styles[property]);
  }
  return el;
}

/**
 * Mounts the card's host for a page with tokens and unmounts it when the last one goes, so a
 * page without tokens carries nothing of entziffer's.
 */
export function renderPane(count: number, handlers: PaneHandlers): void {
  if (count === 0) {
    removePane();
    return;
  }
  const current = pane ?? mount(handlers);
  current.handlers = handlers;
}

/**
 * Puts the card beside `at`: above and to the right of it, flipping to the left or below when
 * that would leave the viewport, so the cursor never sits on the card it is dragging along.
 * Above rather than below because the browser draws a page's own `title` tooltip below and to
 * the right of a resting cursor, and it would otherwise cover the card.
 */
export function moveCard(at: Point): void {
  if (pane === null || pane.shown === null) return;
  const { offsetWidth: width, offsetHeight: height } = pane.card;
  let left = at.x + CURSOR_GAP_PX;
  if (left + width > window.innerWidth - EDGE_PX) left = at.x - CURSOR_GAP_PX - width;
  let top = at.y - CURSOR_GAP_PX - height;
  if (top < EDGE_PX) top = at.y + CURSOR_GAP_PX;
  pane.card.style.left = `${Math.max(EDGE_PX, left)}px`;
  pane.card.style.top = `${Math.max(EDGE_PX, top)}px`;
}

/**
 * Shows `preview` in the card beside `at`, in the typography of the text it was decrypted from
 * and wrapped at that text's width, or takes the card down for `null`. The card is the only place
 * that plaintext exists outside the extension's own pages.
 */
export function showPreview(preview: Preview | null, at?: Point): void {
  if (pane === null) return;
  if (preview === null) {
    if (pane.shown === null) return;
    pane.shown = null;
    pane.signature = null;
    pane.card.hidden = true;
    pane.card.replaceChildren();
    return;
  }
  const signature = JSON.stringify([
    preview.key,
    preview.text,
    preview.reason,
    preview.fingerprint,
  ]);
  if (pane.signature !== signature) {
    pane.shown = preview.key;
    pane.signature = signature;
    const width = Math.min(
      MAX_CARD_WIDTH_PX,
      window.innerWidth - 2 * MARGIN_PX,
      Math.max(MIN_CARD_WIDTH_PX, preview.typography.blockWidth),
    );
    pane.card.style.maxWidth = `${width}px`;
    pane.card.toggleAttribute(LOCKED_ATTR, preview.reason === "locked");
    pane.card.replaceChildren(
      preview.text === null ? note(preview) : plaintext(preview, preview.text),
    );
    pane.card.hidden = false;
  }
  if (at !== undefined) moveCard(at);
}

/** The key of the token the card is showing, if any. */
export function shownKey(): string | null {
  return pane?.shown ?? null;
}

/** True when `event` originated inside the card, whose shadow boundary retargets it to the host. */
export function isPaneEvent(event: Event): boolean {
  return pane !== null && event.composedPath().includes(pane.host);
}

export function removePane(): void {
  if (pane === null) return;
  pane.detachLens();
  pane.host.remove();
  pane = null;
}
