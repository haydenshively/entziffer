import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CARD_ATTR,
  LOCKED_ATTR,
  moveCard,
  type PaneHandlers,
  type Preview,
  removePane,
  renderPane,
  shownKey,
  showPreview,
  TEXT_ATTR,
  TYPOGRAPHY_PROPERTIES,
} from "../src/content/pane.js";
import { HOST_ATTR } from "../src/content/shadow.js";

const handlers: PaneHandlers = {
  unlock: vi.fn(),
};

const typography: Preview["typography"] = {
  styles: {
    ...(Object.fromEntries(
      TYPOGRAPHY_PROPERTIES.map((p) => [p, ""]),
    ) as Preview["typography"]["styles"]),
    "font-family": "Georgia, serif",
    "font-size": "18px",
    "font-weight": "700",
    "font-style": "italic",
    "font-feature-settings": '"tnum"',
    "line-height": "27px",
    "letter-spacing": "0.5px",
    "text-transform": "uppercase",
    color: "rgb(10, 20, 30)",
  },
  blockWidth: 420,
};

const preview = (over: Partial<Preview> & { key: string }): Preview => ({
  text: "hello",
  reason: null,
  fingerprint: null,
  typography,
  ...over,
});

function shadow(): ShadowRoot {
  const host = document.querySelector(`[${HOST_ATTR}]`);
  if (host?.shadowRoot == null) throw new Error("pane is not mounted");
  return host.shadowRoot;
}

const card = (): HTMLElement => shadow().querySelector(`[${CARD_ATTR}]`) as HTMLElement;

beforeEach(() => {
  (globalThis as Record<string, unknown>).chrome = {};
});

afterEach(() => {
  removePane();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("renderPane", () => {
  it("mounts only a hidden card for a page with tokens", () => {
    renderPane(3, handlers);
    expect([...shadow().children].map((el) => el.tagName.toLowerCase())).toContain("div");
    expect(shadow().querySelectorAll("div")).toHaveLength(1);
    expect(card().hidden).toBe(true);
    expect(shownKey()).toBeNull();
  });

  it("unmounts entirely once the last token is gone", () => {
    renderPane(1, handlers);
    expect(document.querySelector(`[${HOST_ATTR}]`)).not.toBeNull();
    renderPane(0, handlers);
    expect(document.querySelector(`[${HOST_ATTR}]`)).toBeNull();
  });
});

describe("showPreview", () => {
  it("shows one plaintext in the token's own typography, then takes it down", () => {
    renderPane(2, handlers);
    showPreview(preview({ key: "a", text: "Fix the login redirect loop" }));
    expect(card().hidden).toBe(false);
    expect(shownKey()).toBe("a");
    const text = card().querySelector(`[${TEXT_ATTR}]`) as HTMLElement;
    expect(text.textContent).toBe("Fix the login redirect loop");
    expect(text.style.fontFamily).toBe("Georgia, serif");
    expect(text.style.fontSize).toBe("18px");
    expect(text.style.fontWeight).toBe("700");
    expect(text.style.fontStyle).toBe("italic");
    expect(text.style.getPropertyValue("font-feature-settings")).toBe('"tnum"');
    expect(text.style.lineHeight).toBe("27px");
    expect(text.style.letterSpacing).toBe("0.5px");
    expect(text.style.textTransform).toBe("uppercase");
    expect(text.style.color).toBe("rgb(10, 20, 30)");
    expect(card().style.maxWidth).toBe("420px");

    showPreview(null);
    expect(card().hidden).toBe(true);
    expect(card().childNodes).toHaveLength(0);
    expect(shownKey()).toBeNull();
  });

  it("sits beside the point it is shown at and flips to stay inside the viewport", () => {
    renderPane(1, handlers);
    // jsdom lays out nothing, so the card is 0×0: it sits 14px up and 14px right of the point.
    showPreview(preview({ key: "a" }), { x: 100, y: 200 });
    expect(card().style.left).toBe("114px");
    expect(card().style.top).toBe("186px");
    moveCard({ x: 150, y: 260 });
    expect(card().style.left).toBe("164px");
    expect(card().style.top).toBe("246px");
    // Too close to the top to fit above, it drops below the point instead.
    moveCard({ x: 150, y: 10 });
    expect(card().style.top).toBe("24px");
    moveCard({ x: window.innerWidth + 10, y: window.innerHeight + 10 });
    expect(Number.parseFloat(card().style.left)).toBeLessThan(window.innerWidth);
  });

  it("holds nothing but the plaintext: no buttons, no inputs", () => {
    renderPane(1, handlers);
    showPreview(preview({ key: "a" }));
    expect(card().querySelectorAll("button, input, textarea, a")).toHaveLength(0);
    expect(card().children).toHaveLength(1);
    expect(card().hasAttribute(LOCKED_ATTR)).toBe(false);
  });

  it("redraws when the same token's result changes underneath it", () => {
    renderPane(1, handlers);
    showPreview(preview({ key: "a", text: null, reason: "locked" }));
    expect(card().textContent).toContain("Locked");
    showPreview(preview({ key: "a", text: "now readable" }));
    expect(card().querySelector(`[${TEXT_ATTR}]`)?.textContent).toBe("now readable");
    expect(card().hasAttribute(LOCKED_ATTR)).toBe(false);
  });

  it("explains a token it cannot show, and unlocks on click only while locked", () => {
    renderPane(1, handlers);
    showPreview(preview({ key: "a", text: null, reason: "foreign", fingerprint: "1a2b-3c4d" }));
    expect(card().textContent).toContain("Encrypted for someone else · 1a2b-3c4d");
    expect(card().querySelector(`[${TEXT_ATTR}]`)).toBeNull();
    card().click();
    expect(handlers.unlock).not.toHaveBeenCalled();

    showPreview(preview({ key: "b", text: null, reason: "broken" }));
    expect(card().textContent).toContain("Couldn't decrypt this token");

    showPreview(preview({ key: "c", text: null, reason: "locked" }));
    expect(card().textContent).toContain("Locked · click to unlock");
    expect(card().hasAttribute(LOCKED_ATTR)).toBe(true);
    card().click();
    expect(handlers.unlock).toHaveBeenCalledOnce();
  });
});
