/** Keys that edit through the editor's own key handling rather than `beforeinput`. */
const EDITING_KEYS = new Set(["Backspace", "Delete", "Enter", "Tab"]);

export interface GuardedToken {
  key: string;
  range: Range;
}

export interface GuardOptions {
  tokens(): GuardedToken[];
  /** Called with the token an edit would have touched, so the pane can take the edit instead. */
  onBlocked(key: string): void;
}

let writing = false;

/** Runs `apply`, whose own writes into the page's editors the guard must let through. */
export function allowingWrites<T>(apply: () => T): T {
  writing = true;
  try {
    return apply();
  } finally {
    writing = false;
  }
}

function toRange(source: AbstractRange): Range | null {
  if (source instanceof Range) return source;
  try {
    const range = document.createRange();
    range.setStart(source.startContainer, source.startOffset);
    range.setEnd(source.endContainer, source.endOffset);
    return range;
  } catch {
    return null;
  }
}

/** True when `edit` covers or borders `token`: typing at either edge would extend the ciphertext. */
function touches(edit: Range, token: Range): boolean {
  try {
    return (
      edit.compareBoundaryPoints(Range.END_TO_START, token) <= 0 &&
      edit.compareBoundaryPoints(Range.START_TO_END, token) >= 0
    );
  } catch {
    return false;
  }
}

function selectionRanges(): Range[] {
  const selection = document.getSelection();
  if (selection === null) return [];
  const out: Range[] = [];
  for (let i = 0; i < selection.rangeCount; i++) out.push(selection.getRangeAt(i));
  return out;
}

function touched(edits: Range[], tokens: GuardedToken[]): GuardedToken | null {
  for (const token of tokens) {
    if (edits.some((edit) => touches(edit, token.range))) return token;
  }
  return null;
}

/**
 * Keeps every edit of a token out of the page's editors: ciphertext is only ever rewritten through
 * the pane. Listeners run in the capture phase on the document, ahead of the editor's own, and
 * cancel the input before the browser or the editor acts on it; the token the edit touched is
 * handed to {@link GuardOptions.onBlocked} so the pane can take over. Copying and selecting are
 * left alone.
 */
export function installGuard(options: GuardOptions): void {
  const intercept = (event: Event, edits: Range[]): void => {
    if (writing || edits.length === 0) return;
    const hit = touched(edits, options.tokens());
    if (hit === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    options.onBlocked(hit.key);
  };

  document.addEventListener(
    "beforeinput",
    (event) => {
      const targets =
        typeof event.getTargetRanges === "function"
          ? event
              .getTargetRanges()
              .map(toRange)
              .filter((r): r is Range => r !== null)
          : [];
      intercept(event, targets.length > 0 ? targets : selectionRanges());
    },
    { capture: true },
  );

  document.addEventListener(
    "keydown",
    (event) => {
      const printable = event.key.length === 1 && !event.metaKey && !event.ctrlKey;
      if (!printable && !EDITING_KEYS.has(event.key)) return;
      intercept(event, selectionRanges());
    },
    { capture: true },
  );

  for (const type of ["paste", "cut", "drop"]) {
    document.addEventListener(type, (event) => intercept(event, selectionRanges()), {
      capture: true,
    });
  }
}
