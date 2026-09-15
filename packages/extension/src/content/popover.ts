import { CIPHERTEXT_ATTR } from "./render.js";
import { createShadowHost } from "./shadow.js";

/** Long enough that skimming the page does not open a popover on every decrypted span. */
const HOVER_DELAY_MS = 400;

interface Popover {
  anchor: Element;
  host: HTMLElement;
  element: HTMLElement;
}

let open: Popover | null = null;
let pending: { anchor: HTMLElement; timer: number } | null = null;

function cancelPending(): void {
  if (pending === null) return;
  clearTimeout(pending.timer);
  pending = null;
}

export function closePopover(): void {
  cancelPending();
  open?.host.remove();
  open = null;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  el.addEventListener("click", () => {
    onClick();
    el.textContent = "Copied";
    setTimeout(() => {
      el.textContent = label;
    }, 900);
  });
  return el;
}

export function showPopover(anchor: HTMLElement): void {
  if (open?.anchor === anchor) return;
  closePopover();

  const plaintext = anchor.textContent ?? "";
  const ciphertext = anchor.getAttribute(CIPHERTEXT_ATTR) ?? "";
  const { host, root } = createShadowHost();
  const element = document.createElement("div");
  element.className = "popover";

  const text = document.createElement("div");
  text.className = "text";
  text.textContent = plaintext;

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    button("Copy plaintext", () => void navigator.clipboard.writeText(plaintext)),
    button("Copy ciphertext", () => void navigator.clipboard.writeText(ciphertext)),
  );

  element.append(text, actions);
  root.appendChild(element);
  open = { anchor, host, element };

  const rect = anchor.getBoundingClientRect();
  element.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 440))}px`;
  const below = rect.bottom + 8;
  element.style.top =
    below + element.offsetHeight > window.innerHeight
      ? `${Math.max(8, rect.top - element.offsetHeight - 8)}px`
      : `${below}px`;
}

/**
 * Hover-driven popover for every in-place replacement; one instance is shared across the page.
 * Opening waits {@link HOVER_DELAY_MS} so a pointer crossing the text never flashes it.
 */
export function installPopover(): void {
  document.addEventListener("mouseover", (event) => {
    const target = (event.target as Element | null)?.closest?.(`[${CIPHERTEXT_ATTR}]`);
    if (!(target instanceof HTMLElement)) return;
    if (open?.anchor === target || pending?.anchor === target) return;
    cancelPending();
    pending = {
      anchor: target,
      timer: setTimeout(() => {
        pending = null;
        showPopover(target);
      }, HOVER_DELAY_MS) as unknown as number,
    };
  });
  document.addEventListener("mouseout", (event) => {
    const related = event.relatedTarget as Node | null;
    if (pending !== null && !(related !== null && pending.anchor.contains(related))) {
      cancelPending();
    }
    if (open === null) return;
    if (related !== null && (open.anchor.contains(related) || open.host.contains(related))) return;
    closePopover();
  });
  document.addEventListener("scroll", closePopover, { capture: true, passive: true });
}
