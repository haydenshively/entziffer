import { afterAll, beforeAll, describe, expect, it } from "vitest";
import vectors from "../../core/test/vectors.json" with { type: "json" };
import { CIPHERTEXT_ATTR, PLAIN_ATTR } from "../src/content/render.js";
import { DEFAULT_SETTINGS, type Request } from "../src/shared/messages.js";

const TOKEN = vectors.vectors[0]?.token as string;
const PLAINTEXT = vectors.vectors[0]?.plaintext as string;

async function reply(request: Request): Promise<unknown> {
  if (request.type === "getSettings") return { ok: true, data: { settings: DEFAULT_SETTINGS } };
  return { ok: false, code: "NO_KEY", message: "no key in this browser" };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}

beforeAll(async () => {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: { sendMessage: reply, onMessage: { addListener: () => {} } },
    storage: { onChanged: { addListener: () => {} } },
  };
  await import("../src/content/index.js");
  // The content script installs its observer only after the first settings round trip resolves.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

// The content script debounces its rescan; let its timer and observer drain before jsdom goes away.
afterAll(async () => {
  document.body.innerHTML = "";
  await new Promise((resolve) => setTimeout(resolve, 200));
});

describe("contenteditable mutations", () => {
  it("reverts a plaintext span as soon as an ancestor becomes editable", async () => {
    document.body.innerHTML = `<div id="host"><p><span ${PLAIN_ATTR} ${CIPHERTEXT_ATTR}="${TOKEN}">${PLAINTEXT}</span></p></div>`;
    const host = document.getElementById("host") as HTMLElement;
    expect(document.querySelector(`[${PLAIN_ATTR}]`)).not.toBeNull();

    host.setAttribute("contenteditable", "true");

    await waitFor(() => document.querySelector(`[${PLAIN_ATTR}]`) === null);
    expect(host.textContent).toBe(TOKEN);
  });
});
