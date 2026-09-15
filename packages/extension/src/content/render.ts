import { isRangeEditable, type TokenLocation } from "./scan.js";

export const PLAIN_ATTR = "data-entz-plain";
export const CIPHERTEXT_ATTR = "data-entz-ct";
export const BADGE_ATTR = "data-entz-badge";
export const LOCK_BADGE_ATTR = "data-entz-locked";

/**
 * The whole visual difference between decrypted text and the prose around it: a thin dotted
 * underline in the text's own colour, so the span inherits the page's typography exactly.
 */
const PLAIN_INDICATOR: Record<string, string> = {
  "text-decoration-line": "underline",
  "text-decoration-style": "dotted",
  "text-decoration-thickness": "1px",
  "text-decoration-color": "color-mix(in srgb, currentColor 45%, transparent)",
  "text-underline-offset": "2px",
};

export function rangeOf(loc: TokenLocation): Range {
  const doc = loc.startNode.ownerDocument as Document;
  const range = doc.createRange();
  range.setStart(loc.startNode, loc.startOffset);
  range.setEnd(loc.endNode, loc.endOffset);
  return range;
}

export function isAttached(loc: TokenLocation): boolean {
  return loc.startNode.isConnected && loc.endNode.isConnected;
}

/**
 * Swaps the ciphertext range for a `<span data-entz-plain>` that inherits the surrounding
 * typography and carries only {@link PLAIN_INDICATOR} to mark it as decrypted. Throws if the
 * range sits inside an editor: replacing text there can round-trip plaintext into the host
 * application's document.
 */
export function replaceInPlace(loc: TokenLocation, plaintext: string): HTMLElement {
  if (loc.editable || isRangeEditable(loc.startNode, loc.endNode)) {
    throw new Error("refusing to replace ciphertext inside an editable region");
  }
  const doc = loc.startNode.ownerDocument as Document;
  const span = doc.createElement("span");
  span.setAttribute(PLAIN_ATTR, "");
  span.setAttribute(CIPHERTEXT_ATTR, loc.token);
  span.style.whiteSpace = "pre-wrap";
  for (const [property, value] of Object.entries(PLAIN_INDICATOR)) {
    span.style.setProperty(property, value);
  }
  span.textContent = plaintext;

  const range = rangeOf(loc);
  range.deleteContents();
  range.insertNode(span);
  return span;
}

/** Marks a token encrypted to somebody else. Never inserted inside an editable region. */
export function insertBadge(loc: TokenLocation, fingerprint: string): HTMLElement | null {
  if (loc.editable || isRangeEditable(loc.startNode, loc.endNode)) return null;
  const doc = loc.startNode.ownerDocument as Document;
  const badge = doc.createElement("span");
  badge.setAttribute(BADGE_ATTR, "");
  badge.title = `Encrypted for someone else (fingerprint ${fingerprint})`;
  badge.textContent = "\u{1F512}";
  badge.style.cssText = "opacity:.6;font-size:.9em;margin-right:.15em;cursor:default";

  const range = rangeOf(loc);
  range.collapse(true);
  range.insertNode(badge);
  return badge;
}

/**
 * The one "click to unlock" affordance for the page. Never inserted inside an editable region, and
 * never more than once: the badge is about the extension's state, not about any single token.
 */
export function insertLockBadge(loc: TokenLocation, onClick: () => void): HTMLElement | null {
  if (loc.editable || isRangeEditable(loc.startNode, loc.endNode)) return null;
  const doc = loc.startNode.ownerDocument as Document;
  const badge = doc.createElement("span");
  badge.setAttribute(LOCK_BADGE_ATTR, "");
  badge.setAttribute(BADGE_ATTR, "");
  badge.title = "Click to unlock entziffer";
  badge.textContent = "\u{1F510}";
  badge.style.cssText = "font-size:.9em;margin-right:.15em;cursor:pointer";
  badge.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });

  const range = rangeOf(loc);
  range.collapse(true);
  range.insertNode(badge);
  return badge;
}

export function removeLockBadges(root: ParentNode = document): void {
  for (const badge of root.querySelectorAll(`[${LOCK_BADGE_ATTR}]`)) badge.remove();
}

/**
 * Undoes every in-place replacement under `root`, putting the ciphertext back and merging the
 * text nodes it was split out of. Lets settings changes restore the page without a reload.
 */
export function revertAll(root: ParentNode = document): number {
  const spans = root.querySelectorAll(`[${PLAIN_ATTR}][${CIPHERTEXT_ATTR}]`);
  for (const span of spans) {
    const parent = span.parentNode;
    if (parent === null) continue;
    const doc = span.ownerDocument;
    parent.replaceChild(doc.createTextNode(span.getAttribute(CIPHERTEXT_ATTR) ?? ""), span);
    parent.normalize();
  }
  for (const badge of root.querySelectorAll(`[${BADGE_ATTR}]`)) badge.remove();
  return spans.length;
}
