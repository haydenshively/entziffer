import { attachLens } from "./lens.js";
import { createShadowHost } from "./shadow.js";

export const PANE_ATTR = "data-entz-pane";
export const WINDOW_ATTR = "data-entz-window";
export const BODY_ATTR = "data-entz-body";
export const ENTRY_ATTR = "data-entz-entry";
export const INSERT_ATTR = "data-entz-insert";
export const COPY_ATTR = "data-entz-copy";
export const UNLOCK_ATTR = "data-entz-unlock";
export const COLLAPSE_ATTR = "data-entz-collapse";
export const PILL_ATTR = "data-entz-pill";
export const COUNT_ATTR = "data-entz-count";
export const ACTIVE_ATTR = "data-entz-active";

export const RECT_KEY = "paneRect";

const INSERT_LABEL = "Insert plaintext";
const INSERT_TITLE =
  "Replaces the ciphertext in this field with the text above. Saving the field afterwards stores it unencrypted.";
const FAILURE_LABEL = "Couldn't insert";
const FLASH_MS = 1_200;
const MARGIN_PX = 16;
const EDGE_PX = 4;
const SAVE_DEBOUNCE_MS = 250;
const EDIT_DEBOUNCE_MS = 600;
const MIN_WIDTH_PX = 240;
const MIN_HEIGHT_PX = 160;
const DEFAULT_WIDTH_PX = 380;
const MAX_TEXTAREA_PX = 220;

const SVG_NS = "http://www.w3.org/2000/svg";

export interface PaneEntry {
  key: string;
  /** The plaintext, or `null` when this key cannot open the token. */
  text: string | null;
  /** The recipient of a token that is not ours, when its envelope parses. */
  fingerprint: string | null;
  /** Whether the token sits in an editor, which is what makes the entry's text editable. */
  editable: boolean;
}

export interface PaneHandlers {
  /** Rewrites the token's editor with `value`; `false` leaves the entry in place. */
  insert(key: string, value: string): boolean;
  /** Re-encrypts `value` and writes the new ciphertext back over the token. */
  edit(key: string, value: string): void;
  /** The pointer entered (`key`) or left (`null`) an entry. */
  hover(key: string | null): void;
  /** Keyboard focus entered (`key`) or left (`null`) an entry's textarea. */
  typing(key: string | null): void;
  unlock(): void;
}

export interface PaneView {
  entries: PaneEntry[];
  locked: boolean;
  /** False without an identity to encrypt to, which makes every textarea read-only. */
  writable: boolean;
  handlers: PaneHandlers;
}

/** The pill's position, measured from the viewport's right and bottom edges, plus the body's size. */
interface PaneRect {
  right: number;
  bottom: number;
  width: number;
  height: number;
  collapsed: boolean;
}

interface Row {
  element: HTMLElement;
  textarea: HTMLTextAreaElement | null;
  insert: HTMLButtonElement | null;
  /** Adopts `text` as the value the page already holds, leaving the user's own typing alone. */
  sync(text: string): void;
  /** Sizes the textarea to its content; meaningful only once the row is attached and visible. */
  fit(): void;
}

interface Pane {
  host: HTMLElement;
  root: ShadowRoot;
  frame: HTMLElement;
  window: HTMLElement;
  body: HTMLElement;
  pill: HTMLButtonElement;
  count: HTMLElement;
  state: HTMLElement;
  rows: Map<string, Row>;
  handlers: PaneHandlers;
  collapsed: boolean;
  locked: boolean;
  total: number;
  detachPillLens(): void;
  saveTimer: number;
}

let pane: Pane | null = null;
/** Until the user drags it, the pane stays docked bottom-right. */
let pinned = false;

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

const PADLOCK_BODY = "M5 11h14a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z";
const SHACKLE_CLOSED = "M7 11V7a5 5 0 0 1 10 0v4";
const SHACKLE_OPEN = "M7 11V7a5 5 0 0 1 9.9-1";

const padlock = (open: boolean, size = "13"): SVGSVGElement =>
  svg([PADLOCK_BODY, open ? SHACKLE_OPEN : SHACKLE_CLOSED], size);

const copyGlyph = (): SVGSVGElement =>
  svg(
    [
      "M9 9h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2z",
      "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
    ],
    "13",
  );

const checkGlyph = (): SVGSVGElement => svg(["M20 6 9 17l-5-5"], "13");

function button(attribute: string, label: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.setAttribute(attribute, "");
  el.textContent = label;
  el.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return el;
}

function flash(el: HTMLButtonElement, label: string, restore: string): void {
  el.textContent = label;
  setTimeout(() => {
    el.textContent = restore;
  }, FLASH_MS);
}

function grow(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_PX)}px`;
}

function storage(): chrome.storage.StorageArea | null {
  try {
    return chrome.storage?.local ?? null;
  } catch {
    return null;
  }
}

function position(): { right: number; bottom: number } {
  if (pane === null) return { right: 0, bottom: 0 };
  return {
    right: Number.parseFloat(pane.frame.style.right) || 0,
    bottom: Number.parseFloat(pane.frame.style.bottom) || 0,
  };
}

function save(): void {
  if (pane === null) return;
  clearTimeout(pane.saveTimer);
  pane.saveTimer = setTimeout(() => {
    if (pane === null) return;
    const rect: PaneRect = {
      ...position(),
      width: pane.body.offsetWidth,
      height: pane.body.offsetHeight,
      collapsed: pane.collapsed,
    };
    void storage()?.set({ [RECT_KEY]: rect });
  }, SAVE_DEBOUNCE_MS) as unknown as number;
}

/** Puts the pill's bottom-right corner `right`/`bottom` from the viewport's, keeping the frame on screen. */
function place(right: number, bottom: number): void {
  if (pane === null) return;
  const width = pane.frame.offsetWidth || DEFAULT_WIDTH_PX;
  const height = pane.frame.offsetHeight || MIN_HEIGHT_PX;
  const maxRight = Math.max(EDGE_PX, window.innerWidth - width - EDGE_PX);
  const maxBottom = Math.max(EDGE_PX, window.innerHeight - height - EDGE_PX);
  pane.frame.style.right = `${Math.max(EDGE_PX, Math.min(right, maxRight))}px`;
  pane.frame.style.bottom = `${Math.max(EDGE_PX, Math.min(bottom, maxBottom))}px`;
}

/** Bottom-right, {@link MARGIN_PX} clear of both edges. */
function placeDefault(): void {
  place(MARGIN_PX, MARGIN_PX);
}

/** Keeps the pane on screen: clamped where the user put it, or re-docked if they never moved it. */
function settle(): void {
  if (pane === null) return;
  if (pinned) {
    const { right, bottom } = position();
    place(right, bottom);
  } else placeDefault();
}

/**
 * The pill never moves: the window opens above it and closes back into it, so collapsing only
 * changes what hangs off the pill's top edge.
 */
function setCollapsed(collapsed: boolean): void {
  if (pane === null || pane.collapsed === collapsed) return;
  pane.window.hidden = collapsed;
  pane.collapsed = collapsed;
  if (!collapsed) for (const row of pane.rows.values()) row.fit();
  renderPill(pane);
  settle();
  save();
}

/** Pointer travel below this is a click, not a drag: the pill must still toggle on a plain tap. */
const DRAG_THRESHOLD_PX = 3;

function installDrag(handle: HTMLElement): void {
  let dr = 0;
  let db = 0;
  let startX = 0;
  let startY = 0;
  let dragged = false;
  handle.addEventListener("pointerdown", (event) => {
    if (pane === null || event.button !== 0) return;
    const button = (event.target as Element).closest("button");
    if (button !== null && button !== handle) return;
    const frame = pane.frame.getBoundingClientRect();
    dr = frame.right - event.clientX;
    db = frame.bottom - event.clientY;
    startX = event.clientX;
    startY = event.clientY;
    dragged = false;
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    if (
      !dragged &&
      Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD_PX
    ) {
      return;
    }
    dragged = true;
    place(window.innerWidth - (event.clientX + dr), window.innerHeight - (event.clientY + db));
  });
  handle.addEventListener("pointerup", (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    handle.releasePointerCapture(event.pointerId);
    if (!dragged) return;
    pinned = true;
    save();
  });
  handle.addEventListener(
    "click",
    (event) => {
      if (!dragged) return;
      dragged = false;
      event.stopImmediatePropagation();
    },
    { capture: true },
  );
}

function restore(): void {
  placeDefault();
  const area = storage();
  if (pane === null || area === null) return;
  void area.get(RECT_KEY).then((stored: Record<string, unknown>) => {
    const rect = stored[RECT_KEY] as Partial<PaneRect> | undefined;
    if (pane === null || rect === undefined) return;
    if (typeof rect.width === "number" && rect.width >= MIN_WIDTH_PX) {
      pane.body.style.width = `${rect.width}px`;
    }
    if (typeof rect.height === "number" && rect.height >= MIN_HEIGHT_PX) {
      pane.body.style.height = `${rect.height}px`;
    }
    if (rect.collapsed === true) setCollapsed(true);
    if (typeof rect.right === "number" && typeof rect.bottom === "number") {
      pinned = true;
      place(rect.right, rect.bottom);
    } else placeDefault();
  });
}

function mount(handlers: PaneHandlers): Pane {
  const { host, root } = createShadowHost();

  const frame = document.createElement("div");
  frame.className = "pane";
  frame.setAttribute(PANE_ATTR, "");

  const window = document.createElement("div");
  window.className = "pane-window";
  window.setAttribute(WINDOW_ATTR, "");

  const header = document.createElement("div");
  header.className = "pane-head";

  const title = document.createElement("span");
  title.className = "pane-title";
  title.textContent = "entziffer";

  const count = document.createElement("span");
  count.className = "chip";
  count.setAttribute(COUNT_ATTR, "");

  const state = document.createElement("span");
  state.className = "chip warn";
  state.hidden = true;

  const collapse = button(COLLAPSE_ATTR, "", () => setCollapsed(true));
  collapse.className = "icon";
  collapse.title = "Collapse";
  collapse.setAttribute("aria-label", "Collapse");
  collapse.appendChild(svg(["M5 12h14"], "14"));

  header.append(title, count, state, collapse);

  const body = document.createElement("div");
  body.className = "pane-body";
  body.setAttribute(BODY_ATTR, "");

  window.append(header, body);

  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "pane-pill";
  pill.setAttribute(PILL_ATTR, "");
  pill.addEventListener("click", () => {
    if (pane === null) return;
    if (pane.locked && pane.collapsed) pane.handlers.unlock();
    else setCollapsed(!pane.collapsed);
  });

  frame.append(window, pill);
  root.appendChild(frame);

  const created: Pane = {
    host,
    root,
    frame,
    window,
    body,
    pill,
    count,
    state,
    rows: new Map(),
    handlers,
    collapsed: false,
    locked: false,
    total: 0,
    detachPillLens: attachLens(root, pill),
    saveTimer: 0,
  };
  pane = created;

  installDrag(header);
  installDrag(pill);

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setCollapsed(true);
  });
  isolate(host);

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      settle();
      save();
    }).observe(body);
  }
  globalThis.addEventListener("resize", settle);

  restore();
  return created;
}

/**
 * Keeps the pane's own input out of the host page. Events crossing a shadow boundary are
 * retargeted to the host element, so a page-level shortcut handler (Linear's single-letter keys)
 * would see a plain `<div>` rather than a textarea and fire while the user types; a click would
 * likewise read as a click outside the page's editor. Stopping propagation at the host is still
 * after every listener inside the shadow root, and leaves selection and drag defaults intact.
 */
function isolate(host: HTMLElement): void {
  const swallow = (event: Event): void => event.stopPropagation();
  for (const type of ["keydown", "keypress", "keyup", "pointerdown", "mousedown", "click"]) {
    host.addEventListener(type, swallow);
  }
}

function buildRow(entry: PaneEntry, handlers: PaneHandlers): Row {
  const element = document.createElement("div");
  element.className = "entry";
  element.setAttribute(ENTRY_ATTR, "");

  let textarea: HTMLTextAreaElement | null = null;
  let insert: HTMLButtonElement | null = null;
  let editTimer = 0;
  let applied = entry.text;
  let sync = (text: string): void => {
    applied = text;
  };

  if (entry.text === null) {
    const foreign = document.createElement("div");
    foreign.className = "entry-foreign";
    foreign.append(padlock(false));
    const label = document.createElement("span");
    label.textContent =
      entry.fingerprint === null
        ? "Couldn't decrypt this token"
        : `Encrypted for someone else · ${entry.fingerprint}`;
    foreign.appendChild(label);
    element.appendChild(foreign);
  } else {
    textarea = document.createElement("textarea");
    textarea.className = "entry-text";
    textarea.rows = 1;
    textarea.spellcheck = false;
    textarea.value = entry.text;
    const box = textarea;
    const flush = (): void => {
      clearTimeout(editTimer);
      editTimer = 0;
      if (box.readOnly || box.value === "" || box.value === applied) return;
      applied = box.value;
      handlers.edit(entry.key, box.value);
    };
    // Insert plaintext replaces the token outright, superseding an edit still waiting to be sent.
    const cancelEdit = (): void => {
      clearTimeout(editTimer);
      applied = box.value;
    };
    sync = (text) => {
      applied = text;
      if (box.value !== text && pane?.root.activeElement !== box) box.value = text;
      grow(box);
    };
    textarea.addEventListener("input", () => {
      grow(box);
      if (box.readOnly) return;
      clearTimeout(editTimer);
      editTimer = setTimeout(flush, EDIT_DEBOUNCE_MS) as unknown as number;
    });
    textarea.addEventListener("focus", () => handlers.typing(entry.key));
    textarea.addEventListener("blur", () => {
      flush();
      handlers.typing(null);
    });

    const field = document.createElement("div");
    field.className = "entry-field";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "entry-copy";
    copy.setAttribute(COPY_ATTR, "");
    copy.title = "Copy";
    copy.setAttribute("aria-label", "Copy");
    copy.appendChild(copyGlyph());
    copy.addEventListener("click", (event) => {
      event.stopPropagation();
      void navigator.clipboard?.writeText(textarea?.value ?? "");
      copy.replaceChildren(checkGlyph());
      setTimeout(() => copy.replaceChildren(copyGlyph()), FLASH_MS);
    });
    field.append(textarea, copy);
    element.appendChild(field);

    if (entry.editable) {
      const actions = document.createElement("div");
      actions.className = "entry-actions";
      insert = button(INSERT_ATTR, INSERT_LABEL, () => {
        const value = textarea?.value ?? "";
        if (!handlers.insert(entry.key, value) && insert !== null) {
          flash(insert, FAILURE_LABEL, INSERT_LABEL);
        }
      });
      insert.addEventListener("mousedown", cancelEdit);
      insert.className = "primary";
      insert.title = INSERT_TITLE;
      actions.appendChild(insert);
      element.appendChild(actions);
    }
  }

  element.addEventListener("mouseenter", () => handlers.hover(entry.key));
  element.addEventListener("mouseleave", () => handlers.hover(null));

  return {
    element,
    textarea,
    insert,
    sync: (text) => sync(text),
    fit: () => {
      if (textarea !== null) grow(textarea);
    },
  };
}

function renderEntries(current: Pane, entries: PaneEntry[], writable: boolean): void {
  const next = new Map<string, Row>();
  for (const entry of entries) {
    const row = current.rows.get(entry.key) ?? buildRow(entry, current.handlers);
    if (row.textarea !== null) row.textarea.readOnly = !writable || !entry.editable;
    if (entry.text !== null) row.sync(entry.text);
    next.set(entry.key, row);
  }
  for (const [key, row] of current.rows) {
    if (!next.has(key)) row.element.remove();
  }
  current.rows = next;
  // Re-inserting a node blurs it, so the body is only rebuilt when the order actually changed.
  const wanted = [...next.values()].map((r) => r.element);
  const unchanged =
    current.body.childNodes.length === wanted.length &&
    wanted.every((el, i) => current.body.childNodes[i] === el);
  if (!unchanged) current.body.replaceChildren(...wanted);
  for (const row of next.values()) row.fit();
}

function renderLocked(current: Pane, waiting: number): void {
  current.rows.clear();
  const box = document.createElement("div");
  box.className = "pane-locked";
  const unlock = button(UNLOCK_ATTR, "Unlock", () => current.handlers.unlock());
  unlock.className = "primary wide";
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = `${waiting} encrypted ${waiting === 1 ? "token" : "tokens"} waiting`;
  box.append(unlock, note);
  current.body.replaceChildren(box);
}

/** The pill reads as the page's lock: shut while everything is masked, open while the pane shows it. */
function renderPill(current: Pane): void {
  const open = !current.locked && !current.collapsed;
  current.pill.replaceChildren(
    padlock(open),
    document.createTextNode(current.locked ? "Locked" : String(current.total)),
  );
  current.pill.title = current.locked
    ? "Unlock entziffer"
    : current.collapsed
      ? "Show decrypted text"
      : "Hide decrypted text";
  current.pill.setAttribute("aria-expanded", String(!current.collapsed));
}

/**
 * Shows the plaintext for every token on the page. The pane is the only place that plaintext
 * exists outside the extension's own pages: it lives in a shadow root, never in the page or its
 * editors. Mounts on the first entry and unmounts when the last one goes.
 */
export function renderPane(view: PaneView): void {
  const n = view.entries.length;
  if (n === 0) {
    removePane();
    return;
  }
  const current = pane ?? mount(view.handlers);
  current.handlers = view.handlers;
  current.locked = view.locked;
  current.total = n;

  current.count.textContent = `${n} encrypted`;
  current.state.hidden = !view.locked;
  current.state.textContent = "Locked";

  if (view.locked) renderLocked(current, n);
  else renderEntries(current, view.entries, view.writable);
  renderPill(current);

  settle();
}

/**
 * Marks the one entry the page and pane are agreeing on. Scrolling only ever moves the pane body,
 * never the page, and keyboard focus is never touched.
 */
export function setActive(key: string | null, scrollIntoView: boolean): void {
  if (pane === null) return;
  for (const [rowKey, row] of pane.rows) {
    if (rowKey !== key) row.element.removeAttribute(ACTIVE_ATTR);
    else if (!row.element.hasAttribute(ACTIVE_ATTR)) {
      row.element.setAttribute(ACTIVE_ATTR, "");
      if (scrollIntoView) row.element.scrollIntoView?.({ block: "nearest" });
    }
  }
}

/** True when `event` originated inside the pane, whose shadow boundary retargets it to the host. */
export function isPaneEvent(event: Event): boolean {
  return pane !== null && event.composedPath().includes(pane.host);
}

/**
 * Runs `apply`, which focuses the page's editor to make its edit, and hands focus and caret
 * straight back to the textarea the user is typing in. See {@link replaceInEditor}.
 */
export function preservingPaneFocus<T>(apply: () => T): T {
  const active = pane?.root.activeElement;
  if (!(active instanceof HTMLTextAreaElement)) return apply();
  const { selectionStart, selectionEnd } = active;
  try {
    return apply();
  } finally {
    active.focus({ preventScroll: true });
    active.setSelectionRange(selectionStart, selectionEnd);
  }
}

export function removePane(): void {
  if (pane === null) return;
  clearTimeout(pane.saveTimer);
  pane.detachPillLens();
  pane.host.remove();
  globalThis.removeEventListener("resize", settle);
  pane = null;
  pinned = false;
}
