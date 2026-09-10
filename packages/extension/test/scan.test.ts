import { describe, expect, it } from "vitest";
import vectors from "../../core/test/vectors.json" with { type: "json" };
import { isEditable, isOwnNode, scan } from "../src/content/scan.js";

function vector(name: string): { token: string; plaintext: string } {
  const found = vectors.vectors.find((v) => v.name === name);
  if (found === undefined) throw new Error(`missing vector ${name}`);
  return found;
}

const { token: TOKEN } = vector("ascii-title");
const { token: SECOND } = vector("title-60");

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe("scan", () => {
  it("finds a token mid-sentence and reports its exact range", () => {
    const root = mount(`<p>before ${TOKEN} after</p>`);
    const [loc] = scan(root);
    expect(loc?.token).toBe(TOKEN);
    expect(loc?.startOffset).toBe("before ".length);
    expect(loc?.endOffset).toBe("before ".length + TOKEN.length);
    expect(loc?.editable).toBe(false);
  });

  it("stops the token at trailing punctuation", () => {
    const root = mount(`<p>see ${TOKEN}, then stop</p>`);
    expect(scan(root)[0]?.token).toBe(TOKEN);
  });

  it("joins a token split across adjacent text nodes", () => {
    const root = mount("<p></p>");
    const p = root.querySelector("p") as HTMLParagraphElement;
    p.append(
      document.createTextNode(`lead ${TOKEN.slice(0, 10)}`),
      document.createTextNode(TOKEN.slice(10, 30)),
      document.createTextNode(`${TOKEN.slice(30)} tail`),
    );
    const [loc] = scan(root);
    expect(loc?.token).toBe(TOKEN);
    expect(loc?.startNode).toBe(p.childNodes[0]);
    expect(loc?.endNode).toBe(p.childNodes[2]);
    expect(loc?.endOffset).toBe(TOKEN.slice(30).length);
  });

  it("joins a token split across inline elements", () => {
    const root = mount(`<p>x ${TOKEN.slice(0, 8)}<b>${TOKEN.slice(8)}</b> y</p>`);
    expect(scan(root)[0]?.token).toBe(TOKEN);
  });

  it("does not join across a block boundary", () => {
    const root = mount(`<div><p>${TOKEN.slice(0, 8)}</p><p>${TOKEN.slice(8)}</p></div>`);
    expect(scan(root).map((l) => l.token)).not.toContain(TOKEN);
  });

  it("finds several tokens in one node", () => {
    const root = mount(`<p>${TOKEN} and ${SECOND}</p>`);
    expect(scan(root).map((l) => l.token)).toEqual([TOKEN, SECOND]);
  });

  it("ignores anything before the ENTZ1: marker", () => {
    const root = mount(`<p>${TOKEN.replace("ENTZ1:", "hs.ENTZ1:")}</p>`);
    expect(scan(root)[0]?.token).toBe(TOKEN);
  });

  it("never scans script or style text", () => {
    const root = mount(`<script>const t = "${TOKEN}";</script><style>/* ${TOKEN} */</style>`);
    expect(scan(root)).toEqual([]);
  });

  it("skips the extension's own shadow host", () => {
    const root = mount(`<p><div data-entz-host>${TOKEN}</div></p>`);
    expect(scan(root)).toEqual([]);
  });
});

describe("isEditable", () => {
  const cases: Array<[string, boolean]> = [
    ['<p id="t">x</p>', false],
    ['<div contenteditable><p id="t">x</p></div>', true],
    ['<div contenteditable="true"><p id="t">x</p></div>', true],
    ['<div contenteditable="false"><p id="t">x</p></div>', false],
    ['<div class="ProseMirror"><p id="t">x</p></div>', true],
    ['<div role="textbox"><p id="t">x</p></div>', true],
    ['<form><textarea id="t"></textarea></form>', true],
    ['<form><input id="t" /></form>', true],
  ];

  for (const [html, expected] of cases) {
    it(`${expected ? "treats as editable" : "treats as inert"}: ${html}`, () => {
      const root = mount(html);
      expect(isEditable(root.querySelector("#t") as Element)).toBe(expected);
    });
  }

  it("marks tokens inside a ProseMirror editor as editable", () => {
    const root = mount(`<div class="ProseMirror" contenteditable><p>${TOKEN}</p></div>`);
    expect(scan(root)[0]?.editable).toBe(true);
  });
});

describe("isOwnNode", () => {
  it("recognises the extension's shadow hosts and nothing else", () => {
    const root = mount("<div data-entz-host><b>a</b></div><i>b</i>");
    expect(isOwnNode(root.children[0] as Element)).toBe(true);
    expect(isOwnNode(root.children[0]?.firstChild as Element)).toBe(true);
    expect(isOwnNode(root.children[1] as Element)).toBe(false);
  });
});
