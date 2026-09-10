import { EDITABLE_SELECTOR, rangeOf, type TokenLocation } from "./scan.js";

function selectToken(loc: TokenLocation, root: HTMLElement): void {
  const selection = root.ownerDocument.defaultView?.getSelection();
  if (selection == null) return;
  const range = rangeOf(loc);
  if (typeof selection.setBaseAndExtent === "function") {
    selection.setBaseAndExtent(
      range.startContainer,
      range.startOffset,
      range.endContainer,
      range.endOffset,
    );
    return;
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function isWritable(root: Element): boolean {
  if (root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement) return false;
  const host = root.closest("[contenteditable]");
  return host !== null && host.getAttribute("contenteditable") !== "false";
}

function paste(root: HTMLElement, text: string): void {
  if (typeof DataTransfer !== "function" || typeof ClipboardEvent !== "function") return;
  const data = new DataTransfer();
  data.setData("text/plain", text);
  root.dispatchEvent(
    new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
  );
}

/**
 * Replaces one token with `text` inside the editor that contains it, at the user's explicit
 * request. With the plaintext this is the one path where entziffer puts cleartext into an editable
 * region, after which saving the field persists it to the host application; with a fresh token it
 * writes ciphertext back. See docs/threat-model.md.
 *
 * The edit is driven through the selection and `document.execCommand("insertText")` rather than by
 * writing `textContent`, so it reaches the editor's own input pipeline (ProseMirror's
 * `DOMObserver`/`beforeinput` handling, React's synthetic events) and the editor's state stays in
 * sync with its DOM; a synthetic `paste` is the fallback. `input` and `textarea` values are not
 * text nodes, are never scanned, and are refused here. Focusing the editor is unavoidable, so
 * callers that hold focus elsewhere must restore it themselves.
 */
export function replaceInEditor(loc: TokenLocation, text: string): boolean {
  const root = loc.startNode.parentElement?.closest(EDITABLE_SELECTOR);
  if (!(root instanceof HTMLElement) || !isWritable(root)) return false;

  const done = (): boolean => !(root.textContent ?? "").includes(loc.token);

  root.focus({ preventScroll: true });
  selectToken(loc, root);
  try {
    root.ownerDocument.execCommand("insertText", false, text);
  } catch {
    // execCommand is absent or throws outside a user gesture; the paste fallback still applies.
  }
  if (done()) return true;

  selectToken(loc, root);
  paste(root, text);
  return done();
}
