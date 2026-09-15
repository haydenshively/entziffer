import { rangeOf } from "./render.js";
import type { TokenLocation } from "./scan.js";
import { copyTypography, createShadowHost } from "./shadow.js";

export const OVERLAY_ATTR = "data-entz-overlay";
export const OVERLAY_LINE_ATTR = "data-entz-overlay-line";

export interface Overlay {
  readonly loc: TokenLocation;
  readonly token: string;
  readonly element: HTMLElement;
  reposition(): void;
  destroy(): void;
}

/**
 * Draws `plaintext` on top of a ciphertext range without touching the range itself. Used for
 * editable regions, and for every token in overlay-only mode. A wrapped token covers several
 * lines, so one masking box is drawn per {@link Range.getClientRects} rect and the plaintext is
 * laid over the first of them.
 */
export function mountOverlay(
  loc: TokenLocation,
  plaintext: string,
  onDismiss: (overlay: Overlay) => void,
): Overlay {
  const { host, root } = createShadowHost();
  const lines = document.createElement("div");
  const element = document.createElement("span");
  element.className = "overlay";
  element.setAttribute(OVERLAY_ATTR, "");
  element.textContent = plaintext;
  element.title = "Click or press Esc to reveal the ciphertext";
  root.append(lines, element);

  const anchor = loc.startNode.parentElement;
  if (anchor !== null) copyTypography(anchor, element);

  let visible = true;
  let frame = 0;

  const overlay: Overlay = {
    loc,
    token: loc.token,
    element,
    reposition,
    destroy,
  };

  function stillAnchored(): boolean {
    if (!loc.startNode.isConnected || !loc.endNode.isConnected) return false;
    try {
      return rangeOf(loc).toString() === loc.token;
    } catch {
      return false;
    }
  }

  function drawLines(rects: DOMRect[]): void {
    while (lines.childElementCount > rects.length) lines.lastElementChild?.remove();
    while (lines.childElementCount < rects.length) {
      const box = document.createElement("span");
      box.className = "overlay-line";
      box.setAttribute(OVERLAY_LINE_ATTR, "");
      box.addEventListener("click", () => onDismiss(overlay));
      lines.appendChild(box);
    }
    rects.forEach((rect, i) => {
      const box = lines.children[i] as HTMLElement;
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
    });
  }

  function reposition(): void {
    if (!stillAnchored()) {
      destroy();
      return;
    }
    const range = rangeOf(loc);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const first = rects[0];
    if (first === undefined) {
      element.style.visibility = "hidden";
      drawLines([]);
      return;
    }
    drawLines(rects);
    const bounds = range.getBoundingClientRect();
    element.style.visibility = "visible";
    element.style.left = `${first.left}px`;
    element.style.top = `${first.top}px`;
    element.style.minHeight = `${first.height}px`;
    element.style.maxWidth = `${Math.max(bounds.width, window.innerWidth - first.left - 8)}px`;
  }

  function tick(): void {
    if (!visible) return;
    reposition();
    frame = requestAnimationFrame(tick);
  }

  function destroy(): void {
    visible = false;
    cancelAnimationFrame(frame);
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition);
    resizeObserver.disconnect();
    intersectionObserver.disconnect();
    host.remove();
  }

  const resizeObserver = new ResizeObserver(reposition);
  if (anchor !== null) resizeObserver.observe(anchor);

  const intersectionObserver = new IntersectionObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (entry === undefined) return;
    if (entry.isIntersecting && !visible) {
      visible = true;
      tick();
    } else if (!entry.isIntersecting) {
      visible = false;
      cancelAnimationFrame(frame);
      element.style.visibility = "hidden";
    }
  });
  if (anchor !== null) intersectionObserver.observe(anchor);

  window.addEventListener("scroll", reposition, { capture: true, passive: true });
  window.addEventListener("resize", reposition);
  element.addEventListener("click", () => onDismiss(overlay));

  reposition();
  tick();
  return overlay;
}
