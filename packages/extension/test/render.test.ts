import { describe, expect, it } from "vitest";
import vectors from "../../core/test/vectors.json" with { type: "json" };
import {
  BADGE_ATTR,
  CIPHERTEXT_ATTR,
  insertBadge,
  replaceInPlace,
  revertAll,
} from "../src/content/render.js";
import { scan, type TokenLocation } from "../src/content/scan.js";

const first = (root: Node): TokenLocation => scan(root)[0] as TokenLocation;

function vector(name: string): { token: string; plaintext: string } {
  const found = vectors.vectors.find((v) => v.name === name);
  if (found === undefined) throw new Error(`missing vector ${name}`);
  return found;
}

const { token: TOKEN, plaintext: PLAINTEXT } = vector("ascii-title");

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

const $ = (selector: string): Element => document.querySelector(selector) as Element;

describe("replaceInPlace", () => {
  it("swaps only the token and keeps the surrounding text", () => {
    const root = mount(`<p>before ${TOKEN} after</p>`);
    const span = replaceInPlace(first(root), PLAINTEXT);
    expect(root.textContent).toBe(`before ${PLAINTEXT} after`);
    expect(span.getAttribute(CIPHERTEXT_ATTR)).toBe(TOKEN);
    expect(span.style.whiteSpace).toBe("pre-wrap");
  });

  it("renders multi-line plaintext without collapsing newlines", () => {
    const root = mount(`<div>${TOKEN}</div>`);
    const span = replaceInPlace(first(root), "line 1\nline 2");
    expect(span.textContent).toBe("line 1\nline 2");
  });

  it("joins a token split across text nodes into one span", () => {
    const root = mount("<p></p>");
    const p = root.querySelector("p") as HTMLParagraphElement;
    p.append(
      document.createTextNode(`a ${TOKEN.slice(0, 12)}`),
      document.createTextNode(`${TOKEN.slice(12)} b`),
    );
    replaceInPlace(first(root), PLAINTEXT);
    expect(root.textContent).toBe(`a ${PLAINTEXT} b`);
    expect(root.querySelectorAll(`[${CIPHERTEXT_ATTR}]`)).toHaveLength(1);
  });

  it("refuses to touch a contenteditable and leaves its text byte-identical", () => {
    const original = `Ship it ${TOKEN} today`;
    const root = mount(`<div class="ProseMirror" contenteditable><p>${original}</p></div>`);
    const loc = first(root);
    expect(() => replaceInPlace(loc, PLAINTEXT)).toThrow(/editable/);
    expect(root.textContent).toBe(original);
  });

  it("refuses even when the caller mislabels the location as inert", () => {
    const root = mount(`<div contenteditable><p>${TOKEN}</p></div>`);
    const loc = { ...first(root), editable: false };
    expect(() => replaceInPlace(loc, PLAINTEXT)).toThrow(/editable/);
    expect(root.textContent).toBe(TOKEN);
  });
});

describe("editable ranges", () => {
  it("refuses a token running from inert text into an inline contenteditable", () => {
    const root = mount(
      `<p><span>a ${TOKEN.slice(0, 12)}</span><span contenteditable id="e">${TOKEN.slice(12)}</span></p>`,
    );
    const loc = first(root);
    expect(loc.token).toBe(TOKEN);
    expect(loc.editable).toBe(true);
    expect(() => replaceInPlace({ ...loc, editable: false }, PLAINTEXT)).toThrow(/editable/);
    expect(($("#e") as HTMLElement).textContent).toBe(TOKEN.slice(12));
    expect(root.textContent).toBe(`a ${TOKEN}`);
  });

  it("refuses a token that merely crosses an editable node between its endpoints", () => {
    const root = mount(
      `<p><span>${TOKEN.slice(0, 8)}</span><span contenteditable id="e">${TOKEN.slice(8, 20)}</span><span>${TOKEN.slice(20)}</span></p>`,
    );
    const loc = first(root);
    expect(loc.editable).toBe(true);
    expect(() => replaceInPlace({ ...loc, editable: false }, PLAINTEXT)).toThrow(/editable/);
    expect(($("#e") as HTMLElement).textContent).toBe(TOKEN.slice(8, 20));
    expect(insertBadge({ ...loc, editable: false }, "33cf-ef49")).toBeNull();
    expect(root.textContent).toBe(TOKEN);
  });
});

describe("revertAll", () => {
  it("restores the ciphertext and merges the text node back together", () => {
    const root = mount(`<p>before ${TOKEN} after</p>`);
    replaceInPlace(first(root), PLAINTEXT);
    expect(revertAll(root)).toBe(1);
    const p = root.querySelector("p") as HTMLParagraphElement;
    expect(p.childNodes).toHaveLength(1);
    expect(root.textContent).toBe(`before ${TOKEN} after`);
    expect(scan(root)[0]?.token).toBe(TOKEN);
  });

  it("removes badges as well", () => {
    const root = mount(`<p>x ${TOKEN} y</p>`);
    insertBadge(first(root), "33cf-ef49");
    revertAll(root);
    expect(root.querySelectorAll(`[${BADGE_ATTR}]`)).toHaveLength(0);
    expect(root.textContent).toBe(`x ${TOKEN} y`);
  });
});

describe("insertBadge", () => {
  it("puts a titled badge before the ciphertext without changing it", () => {
    const root = mount(`<p>x ${TOKEN} y</p>`);
    const badge = insertBadge(first(root), "33cf-ef49");
    expect(badge?.title).toBe("Encrypted for someone else (fingerprint 33cf-ef49)");
    expect(root.textContent).toBe(`x \u{1F512}${TOKEN} y`);
  });

  it("never appears inside an editor", () => {
    const root = mount(`<div contenteditable><p>${TOKEN}</p></div>`);
    expect(insertBadge(first(root), "33cf-ef49")).toBeNull();
    expect(root.textContent).toBe(TOKEN);
  });
});
