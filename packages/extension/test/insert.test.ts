import { afterEach, describe, expect, it, vi } from "vitest";
import vectors from "../../core/test/vectors.json" with { type: "json" };
import { replaceInEditor } from "../src/content/insert.js";
import { scan, type TokenLocation } from "../src/content/scan.js";

function vector(name: string): { token: string; plaintext: string } {
  const found = vectors.vectors.find((v) => v.name === name);
  if (found === undefined) throw new Error(`missing vector ${name}`);
  return found;
}

const { token: TOKEN, plaintext: PLAINTEXT } = vector("ascii-title");

function mount(html: string): TokenLocation {
  document.body.innerHTML = html;
  return scan(document.body)[0] as TokenLocation;
}

/** jsdom has no `execCommand`; this stands in for the editor applying the browser's edit. */
function stubExecCommand(): void {
  vi.stubGlobal("getSelection", () => null);
  Reflect.set(document, "execCommand", (_command: string, _ui: boolean, text: string) => {
    const target = document.querySelector("[contenteditable] p") as HTMLElement;
    target.textContent = (target.textContent ?? "").replace(TOKEN, text);
    return true;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "execCommand");
});

describe("replaceInEditor", () => {
  it("refuses a range that is not inside a writable editor", () => {
    const loc = mount(`<p>Draft: ${TOKEN} (still editing)</p>`);
    expect(replaceInEditor(loc, PLAINTEXT)).toBe(false);
    expect(document.body.textContent).toBe(`Draft: ${TOKEN} (still editing)`);
  });

  it("refuses a role=textbox that is not contenteditable", () => {
    const loc = mount(`<div role="textbox"><p>${TOKEN}</p></div>`);
    expect(replaceInEditor(loc, PLAINTEXT)).toBe(false);
    expect(document.body.textContent).toBe(TOKEN);
  });

  it("writes a fresh token back over the old one", () => {
    const loc = mount(
      `<div class="ProseMirror" contenteditable="true"><p>Draft: ${TOKEN} (still editing)</p></div>`,
    );
    stubExecCommand();
    expect(replaceInEditor(loc, "ENTZ1:rewritten")).toBe(true);
    const root = document.querySelector("[contenteditable]") as HTMLElement;
    expect(root.textContent).toBe("Draft: ENTZ1:rewritten (still editing)");
  });

  it("replaces the token through the editor's own input pipeline", () => {
    const loc = mount(
      `<div class="ProseMirror" contenteditable="true"><p>Draft: ${TOKEN} (still editing)</p></div>`,
    );
    stubExecCommand();
    expect(replaceInEditor(loc, PLAINTEXT)).toBe(true);
    const root = document.querySelector("[contenteditable]") as HTMLElement;
    expect(root.textContent).toBe(`Draft: ${PLAINTEXT} (still editing)`);
  });
});
