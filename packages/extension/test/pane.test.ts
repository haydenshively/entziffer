import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_ATTR,
  COLLAPSE_ATTR,
  COUNT_ATTR,
  ENTRY_ATTR,
  INSERT_ATTR,
  PANE_ATTR,
  type PaneEntry,
  type PaneHandlers,
  PILL_ATTR,
  RECT_KEY,
  removePane,
  renderPane,
  setActive,
  UNLOCK_ATTR,
  WINDOW_ATTR,
} from "../src/content/pane.js";
import { HOST_ATTR } from "../src/content/shadow.js";

const handlers: PaneHandlers = {
  insert: vi.fn(() => true),
  edit: vi.fn(),
  hover: vi.fn(),
  typing: vi.fn(),
  unlock: vi.fn(),
};

const entry = (over: Partial<PaneEntry> & { key: string }): PaneEntry => ({
  text: "hello",
  fingerprint: null,
  editable: true,
  ...over,
});

function shadow(): ShadowRoot {
  const host = document.querySelector(`[${HOST_ATTR}]`);
  if (host?.shadowRoot == null) throw new Error("pane is not mounted");
  return host.shadowRoot;
}

const entries = (): Element[] => [...shadow().querySelectorAll(`[${ENTRY_ATTR}]`)];

const textareas = (): string[] =>
  [...shadow().querySelectorAll("textarea")].map((el) => (el as HTMLTextAreaElement).value);

const render = (list: PaneEntry[], locked = false, writable = true): void =>
  renderPane({ entries: list, locked, writable, handlers });

const textareaOf = (index: number): HTMLTextAreaElement =>
  shadow().querySelectorAll("textarea")[index] as HTMLTextAreaElement;

const type = (el: HTMLTextAreaElement, value: string): void => {
  el.value = value;
  el.dispatchEvent(new Event("input"));
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).chrome = {
    storage: { local: { get: async () => ({}), set: async () => undefined } },
  };
});

afterEach(() => {
  removePane();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("renderPane", () => {
  it("mounts one entry per token with its plaintext in a textarea", () => {
    render([
      entry({ key: "a", text: "first" }),
      entry({ key: "b", text: "second" }),
      entry({ key: "c", text: "third" }),
    ]);
    expect(entries()).toHaveLength(3);
    expect(textareas()).toEqual(["first", "second", "third"]);
    expect(shadow().querySelector(`[${COUNT_ATTR}]`)?.textContent).toBe("3 encrypted");
    expect(shadow().querySelector(`[${PANE_ATTR}]`)).not.toBeNull();
  });

  it("offers editing and Insert plaintext only for tokens sitting in an editable region", () => {
    render([entry({ key: "a", editable: true }), entry({ key: "b", editable: false })]);
    const [editable, inert] = entries();
    expect(editable?.querySelector(`[${INSERT_ATTR}]`)).not.toBeNull();
    expect(editable?.querySelector("textarea")?.readOnly).toBe(false);
    expect(inert?.querySelector(`[${INSERT_ATTR}]`)).toBeNull();
    expect(inert?.querySelector("[data-entz-copy]")).not.toBeNull();
    expect(inert?.querySelector("textarea")?.readOnly).toBe(true);
    expect(inert?.querySelector("textarea")?.value).toBe("hello");
  });

  it("labels a token that fails to decrypt for a reason other than its recipient", () => {
    render([entry({ key: "a", text: null, fingerprint: null, editable: false })]);
    expect(entries()[0]?.textContent).toContain("Couldn't decrypt this token");
  });

  it("keeps the pill through collapse and expand, flipping its lock open only while expanded", () => {
    render([entry({ key: "a" }), entry({ key: "b" })]);
    const pill = shadow().querySelector(`[${PILL_ATTR}]`) as HTMLButtonElement;
    const window = shadow().querySelector(`[${WINDOW_ATTR}]`) as HTMLElement;
    const shackle = (): string | null =>
      pill.querySelectorAll("path")[1]?.getAttribute("d") ?? null;
    expect(pill.textContent).toBe("2");
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    const open = shackle();

    (shadow().querySelector(`[${COLLAPSE_ATTR}]`) as HTMLButtonElement).click();
    expect(window.hidden).toBe(true);
    expect(pill.isConnected).toBe(true);
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(shackle()).not.toBe(open);

    pill.click();
    expect(window.hidden).toBe(false);
    expect(shackle()).toBe(open);

    render([entry({ key: "a" }), entry({ key: "b" })], true);
    expect(pill.textContent).toBe("Locked");
    expect(shackle()).not.toBe(open);
    pill.click();
    expect(window.hidden).toBe(true);
    pill.click();
    expect(handlers.unlock).toHaveBeenCalledOnce();
    expect(window.hidden).toBe(true);
  });

  it("inserts the edited textarea value rather than the original plaintext", () => {
    render([entry({ key: "a", text: "hello" })]);
    const textarea = shadow().querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "edited";
    (shadow().querySelector(`[${INSERT_ATTR}]`) as HTMLButtonElement).click();
    expect(handlers.insert).toHaveBeenCalledWith("a", "edited");
  });

  it("names the other recipient for a token it cannot decrypt", () => {
    render([entry({ key: "a", text: null, fingerprint: "1a2b-3c4d", editable: false })]);
    expect(entries()[0]?.textContent).toContain("Encrypted for someone else · 1a2b-3c4d");
    expect(shadow().querySelectorAll("textarea")).toHaveLength(0);
  });

  it("shows one Unlock button and no entries while the session is locked", () => {
    render([entry({ key: "a" }), entry({ key: "b" })], true);
    expect(entries()).toHaveLength(0);
    const unlock = shadow().querySelector(`[${UNLOCK_ATTR}]`) as HTMLButtonElement;
    expect(unlock.textContent).toBe("Unlock");
    expect(shadow().textContent).toContain("2 encrypted tokens waiting");
    unlock.click();
    expect(handlers.unlock).toHaveBeenCalled();
  });

  it("hovering an entry focuses its token and leaving clears the layers", () => {
    render([entry({ key: "a" }), entry({ key: "b" })]);
    entries()[1]?.dispatchEvent(new MouseEvent("mouseenter"));
    expect(handlers.hover).toHaveBeenLastCalledWith("b");
    entries()[1]?.dispatchEvent(new MouseEvent("mouseleave"));
    expect(handlers.hover).toHaveBeenLastCalledWith(null);
  });

  it("unmounts entirely once the last token is gone", () => {
    render([entry({ key: "a" })]);
    expect(document.querySelector(`[${HOST_ATTR}]`)).not.toBeNull();
    render([]);
    expect(document.querySelector(`[${HOST_ATTR}]`)).toBeNull();
  });

  it("keeps a row's textarea across a rerender of the same keys", () => {
    render([entry({ key: "a", text: "first" }), entry({ key: "b", text: "second" })]);
    const [first, second] = [textareaOf(0), textareaOf(1)];
    render([entry({ key: "a", text: "first" }), entry({ key: "b", text: "second" })]);
    expect(textareaOf(0)).toBe(first);
    expect(textareaOf(1)).toBe(second);
  });

  it("never overwrites the value of a focused textarea", () => {
    render([entry({ key: "a", text: "hello" })]);
    const textarea = textareaOf(0);
    textarea.focus();
    type(textarea, "half-typed");
    render([entry({ key: "a", text: "hello" })]);
    expect(textareaOf(0)).toBe(textarea);
    expect(textarea.value).toBe("half-typed");
  });

  it("re-encrypts an edited entry once the user stops typing", () => {
    vi.useFakeTimers();
    try {
      render([entry({ key: "a", text: "hello" })]);
      const textarea = textareaOf(0);
      type(textarea, "hell");
      type(textarea, "hello there");
      vi.advanceTimersByTime(599);
      expect(handlers.edit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(handlers.edit).toHaveBeenCalledExactlyOnceWith("a", "hello there");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes the pending edit on blur and never encrypts an emptied entry", () => {
    vi.useFakeTimers();
    try {
      render([entry({ key: "a", text: "hello" })]);
      const textarea = textareaOf(0);
      type(textarea, "edited");
      textarea.dispatchEvent(new FocusEvent("blur"));
      expect(handlers.edit).toHaveBeenCalledExactlyOnceWith("a", "edited");

      type(textarea, "");
      vi.advanceTimersByTime(1_000);
      expect(handlers.edit).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes every textarea read-only when there is no key to encrypt to", () => {
    vi.useFakeTimers();
    try {
      render([entry({ key: "a", text: "hello" })], false, false);
      const textarea = textareaOf(0);
      expect(textarea.readOnly).toBe(true);
      type(textarea, "edited");
      vi.advanceTimersByTime(1_000);
      expect(handlers.edit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the entry the page pointer is over", () => {
    render([entry({ key: "a" }), entry({ key: "b" })]);
    setActive("b", true);
    expect(entries()[0]?.hasAttribute(ACTIVE_ATTR)).toBe(false);
    expect(entries()[1]?.hasAttribute(ACTIVE_ATTR)).toBe(true);
    setActive(null, false);
    expect(entries().some((el) => el.hasAttribute(ACTIVE_ATTR))).toBe(false);
  });

  it("restores the stored rect on mount", async () => {
    const stored = { right: 40, bottom: 60, width: 300, height: 200, collapsed: false };
    const get = vi.fn(async () => ({ [RECT_KEY]: stored }));
    (globalThis as Record<string, unknown>).chrome = {
      storage: { local: { get, set: async () => undefined } },
    };
    render([entry({ key: "a" })]);
    await vi.waitFor(() => {
      expect((shadow().querySelector(`[${PANE_ATTR}]`) as HTMLElement).style.right).toBe("40px");
    });
    expect((shadow().querySelector(`[${PANE_ATTR}]`) as HTMLElement).style.bottom).toBe("60px");
    expect(get).toHaveBeenCalledWith(RECT_KEY);
  });
});
