import { describe, expect, it } from "vitest";
import { findTokens } from "../src/index.js";

const T = "ENTZ1:AbC-_123";

describe("findTokens", () => {
  const table: Array<[string, string, string[]]> = [
    ["bare", T, [T]],
    ["mid-sentence", `see ${T} for details`, [T]],
    ["trailing period", `see ${T}.`, [T]],
    ["trailing comma and paren", `(${T}), ok`, [T]],
    ["markdown link text", `[${T}](https://linear.app/x)`, [T]],
    ["multiple", `${T} and ${T}`, [T, T]],
    ["a prefix is not part of the token", `hs.${T}`, [T]],
    ["no body", "ENTZ1:", []],
    ["no marker", "nothing here", []],
    ["newline terminates", `${T}\nnext`, [T]],
    ["quoted", `"${T}"`, [T]],
  ];

  it.each(table)("%s", (_name, text, expected) => {
    expect(findTokens(text).map((m) => m.token)).toEqual(expected);
  });

  it("reports offsets that slice back to the token", () => {
    const text = `a ${T} b ${T}`;
    for (const m of findTokens(text)) expect(text.slice(m.start, m.end)).toBe(m.token);
  });
});
