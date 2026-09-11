import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import vectors from "../../core/test/vectors.json" with { type: "json" };
import { createLru } from "../src/content/cache.js";
import { type Box, hits } from "../src/content/hit.js";
import { rangeOf, scan, splitToken } from "../src/content/scan.js";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  showPreview: vi.fn(),
  shownKey: vi.fn(() => null as string | null),
  /** jsdom lays nothing out, so a test that needs the pointer over a token says so here. */
  hitEverything: { value: false },
}));

vi.mock("../src/shared/messages.js", () => ({ send: mocks.send }));
vi.mock("../src/content/hit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/content/hit.js")>();
  return {
    ...actual,
    hits: (...args: Parameters<typeof actual.hits>) =>
      mocks.hitEverything.value || actual.hits(...args),
  };
});
vi.mock("../src/content/pane.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensurePane: vi.fn(),
  showPreview: mocks.showPreview,
  moveCard: vi.fn(),
  shownKey: mocks.shownKey,
  isPaneEvent: vi.fn(() => false),
  removePane: vi.fn(),
}));

function vector(name: string): { token: string; plaintext: string } {
  const found = vectors.vectors.find((v) => v.name === name);
  if (found === undefined) throw new Error(`missing vector ${name}`);
  return found;
}

const { token: TOKEN, plaintext: PLAINTEXT } = vector("ascii-title");

describe("createLru", () => {
  it("drops the least recently used entry past its limit", () => {
    const lru = createLru<number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("b")).toBe(2);
    expect(lru.size).toBe(2);
  });

  it("renews an entry on read, so it outlives a newer one", () => {
    const lru = createLru<number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("a")).toBe(1);
    lru.set("c", 3);
    expect(lru.get("a")).toBe(1);
    expect(lru.get("b")).toBeUndefined();
  });

  it("overwrites without growing, and clears", () => {
    const lru = createLru<number>(2);
    lru.set("a", 1);
    lru.set("a", 2);
    expect(lru.size).toBe(1);
    expect(lru.get("a")).toBe(2);
    lru.clear();
    expect(lru.size).toBe(0);
    expect(lru.get("a")).toBeUndefined();
  });
});

describe("splitToken", () => {
  it("splits a token into its marker and its ciphertext body", () => {
    document.body.innerHTML = `<p>before ${TOKEN} after</p>`;
    const [loc] = scan(document.body);
    if (loc === undefined) throw new Error("no token");
    const { tag, body } = splitToken(loc, rangeOf(loc));
    expect(tag.toString()).toBe("ENTZ1:");
    expect(body.toString()).toBe(TOKEN.slice("ENTZ1:".length));
  });

  it("makes the whole token the tag when its marker is split across nodes", () => {
    document.body.innerHTML = "<p></p>";
    const p = document.body.querySelector("p") as HTMLParagraphElement;
    p.append(document.createTextNode("ENT"), document.createTextNode(TOKEN.slice(3)));
    const [loc] = scan(document.body);
    if (loc === undefined) throw new Error("no token");
    const range = rangeOf(loc);
    const { tag, body } = splitToken(loc, range);
    expect(tag).toBe(range);
    expect(body.toString()).toBe("");
  });
});

describe("hits", () => {
  const line = (top: number, bottom: number, left = 0, right = 100): Box => ({
    top,
    bottom,
    left,
    right,
  });

  it("hits a rect, with a little slack around it", () => {
    const rects = [line(10, 20)];
    expect(hits(rects, 50, 15)).toBe(true);
    expect(hits(rects, 50, 21)).toBe(true);
    expect(hits(rects, 50, 24)).toBe(false);
    expect(hits(rects, 103, 15)).toBe(false);
  });

  it("covers the gap between two lines of a wrapped token", () => {
    const rects = [line(10, 20), line(30, 40)];
    expect(hits(rects, 50, 25)).toBe(true);
    expect(hits(rects, 50, 26)).toBe(true);
    expect(hits(rects, 50, 5)).toBe(false);
    expect(hits(rects, 50, 45)).toBe(false);
  });

  it("does not let a second rect on the same line shrink that line", () => {
    const rects = [line(10, 20, 0, 40), line(10, 20, 40, 100), line(30, 40)];
    expect(hits(rects, 60, 12)).toBe(true);
    expect(hits(rects, 60, 25)).toBe(true);
  });
});

/**
 * A `locked` broadcast arriving while a decrypt is in flight must win: the reply that lands after
 * it may not be cached, shown, or held for the next scan.
 */
describe("locking while a decrypt is in flight", () => {
  let broadcast: (message: { type: string }) => void;

  beforeEach(() => {
    vi.resetModules();
    mocks.send.mockReset();
    mocks.showPreview.mockReset();
    vi.useFakeTimers();
    document.body.innerHTML = `<p>Heads up: ${TOKEN} today.</p>`;
    broadcast = () => undefined;
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension",
        onMessage: {
          addListener: (fn: (message: { type: string }) => void) => {
            broadcast = fn;
          },
        },
      },
    });
  });

  /** Leaves the imported module inert, so its observer cannot outlive the test environment. */
  async function invalidateContext(): Promise<void> {
    mocks.send.mockReset();
    mocks.send.mockResolvedValue({ ok: false, code: "INTERNAL", message: "context invalidated" });
    (globalThis.chrome as { runtime: { id?: string } }).runtime.id = undefined;
    document.body.innerHTML = `<p>Late: ${TOKEN}</p>`;
    await flush();
  }

  afterEach(async () => {
    await invalidateContext();
    document.body.innerHTML = "";
    await flush();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(200);
  };

  it("drops the reply, caches nothing, and shows no plaintext", async () => {
    let settle: (value: unknown) => void = () => undefined;
    mocks.send.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    await import("../src/content/index.js");
    await flush();
    expect(mocks.send).toHaveBeenCalledWith({ type: "decrypt", tokens: [TOKEN] });

    broadcast({ type: "locked" });
    settle({ ok: true, data: { results: [{ ok: true, text: PLAINTEXT }] } });
    await flush();

    for (const call of mocks.showPreview.mock.calls) {
      expect(JSON.stringify(call[0] ?? null)).not.toContain(PLAINTEXT);
    }
    expect(document.body.textContent).not.toContain(PLAINTEXT);
    expect(document.querySelector("[data-entz-host]")).toBeNull();

    // Nothing was cached, so the token has to be asked for again once the session is back.
    mocks.send.mockResolvedValue({ ok: true, data: { results: [{ ok: true, text: PLAINTEXT }] } });
    broadcast({ type: "unlocked" });
    await flush();
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send).toHaveBeenLastCalledWith({ type: "decrypt", tokens: [TOKEN] });
  });

  it("tears itself down when the extension's context is gone", async () => {
    mocks.send.mockResolvedValue({ ok: true, data: { results: [{ ok: true, text: PLAINTEXT }] } });
    await import("../src/content/index.js");
    await flush();
    expect(mocks.send).toHaveBeenCalledTimes(1);

    await invalidateContext();
    mocks.send.mockClear();
    document.body.innerHTML = `<p>Later still: ${TOKEN}</p>`;
    await flush();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.showPreview).toHaveBeenLastCalledWith(null);
  });
});

/**
 * A token inside something the page makes clickable: while the session is locked the click has to
 * reach the unlock request instead of the link.
 */
describe("clicking a token the page has made clickable", () => {
  let broadcast: (message: { type: string }) => void;
  let anchor: HTMLAnchorElement;
  let pageClick: Mock<(event: Event) => void>;
  let pagePress: Mock<(event: Event) => void>;

  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(200);
  };

  beforeEach(async () => {
    vi.resetModules();
    mocks.send.mockReset();
    mocks.showPreview.mockReset();
    mocks.hitEverything.value = true;
    // jsdom implements no layout, and the content script asks every token for its rects.
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    vi.useFakeTimers();
    document.body.innerHTML = `<p><a id="linked" href="#somewhere">${TOKEN}</a></p>`;
    anchor = document.getElementById("linked") as HTMLAnchorElement;
    pageClick = vi.fn<(event: Event) => void>();
    pagePress = vi.fn<(event: Event) => void>();
    anchor.addEventListener("click", pageClick);
    anchor.addEventListener("mousedown", pagePress);
    broadcast = () => undefined;
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension",
        onMessage: {
          addListener: (fn: (message: { type: string }) => void) => {
            broadcast = fn;
          },
        },
      },
    });
    mocks.send.mockResolvedValue({ ok: true, data: { results: [{ ok: true, text: PLAINTEXT }] } });
    await import("../src/content/index.js");
    await flush();
  });

  afterEach(async () => {
    mocks.send.mockReset();
    mocks.send.mockResolvedValue({ ok: false, code: "INTERNAL", message: "context invalidated" });
    (globalThis.chrome as { runtime: { id?: string } }).runtime.id = undefined;
    document.body.innerHTML = `<p>Late: ${TOKEN}</p>`;
    await flush();
    document.body.innerHTML = "";
    await flush();
    mocks.hitEverything.value = false;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const click = (init: MouseEventInit = {}): MouseEvent => {
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 5,
      clientY: 5,
      ...init,
    });
    anchor.dispatchEvent(event);
    return event;
  };

  const press = (init: MouseEventInit = {}): MouseEvent => {
    const event = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 5,
      clientY: 5,
      ...init,
    });
    anchor.dispatchEvent(event);
    return event;
  };

  it("takes the click off the link and asks to unlock while locked", () => {
    broadcast({ type: "locked" });
    mocks.send.mockClear();

    const pressed = press();
    expect(pressed.defaultPrevented).toBe(true);
    expect(pagePress).not.toHaveBeenCalled();

    const clicked = click();
    expect(clicked.defaultPrevented).toBe(true);
    expect(pageClick).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledWith({ type: "requestUnlock" });
  });

  it("leaves a modified click to the page while locked", () => {
    broadcast({ type: "locked" });
    mocks.send.mockClear();

    const pressed = press({ metaKey: true });
    expect(pressed.defaultPrevented).toBe(false);
    expect(pagePress).toHaveBeenCalledTimes(1);

    const clicked = click({ metaKey: true });
    expect(clicked.defaultPrevented).toBe(false);
    expect(pageClick).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("leaves the link alone while unlocked", () => {
    mocks.send.mockClear();

    const pressed = press();
    expect(pressed.defaultPrevented).toBe(false);
    expect(pagePress).toHaveBeenCalledTimes(1);

    const clicked = click();
    expect(clicked.defaultPrevented).toBe(false);
    expect(pageClick).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
