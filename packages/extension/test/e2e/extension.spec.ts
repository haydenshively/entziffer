import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrowserContext,
  chromium,
  expect,
  type Locator,
  type Page,
  test,
  type Worker,
} from "@playwright/test";
import { EXTENSION_ID } from "../../src/shared/identity.js";
import {
  E2E_PRF_HEX,
  type FixtureServer,
  foreign,
  plaintext,
  recipient,
  startFixtureServer,
  token,
} from "./fixture-server.js";

const DIST = fileURLToPath(new URL("../../dist-e2e", import.meta.url));

interface KeyRecordMeta {
  credentialIdBytes: number;
  fields: string[];
  enrolledAt: number;
}

interface KeyStatus {
  hasKey: boolean;
  locked: boolean;
  identity: { publicKey: string; fingerprint: string } | null;
  enrolledAt: number | null;
}

interface E2EHooks {
  __entzSeedFromPrf(prfHex: string): Promise<unknown>;
  __entzSetSettings(patch: Record<string, unknown>): Promise<unknown>;
  __entzKeyRecordMeta(): Promise<KeyRecordMeta | null>;
  __entzClearKey(): Promise<void>;
  __entzUnlockWithPrf(prfHex: string): Promise<unknown>;
  __entzLockNow(): Promise<void>;
  __entzStatus(): Promise<{ status: KeyStatus }>;
  __entzRunStartupHandler(): Promise<void>;
  __entzHasSessionRecord(): Promise<boolean>;
  __entzClearSessionSentinel(): Promise<void>;
  __entzGetLocal(key: string): Promise<unknown>;
  __entzClearLocal(key: string): Promise<void>;
}

const OTHER_PRF_HEX = "bb".repeat(32);

let context: BrowserContext;
let worker: Worker;
let server: FixtureServer;
let profile: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  server = await startFixtureServer();
  profile = mkdtempSync(join(tmpdir(), "entz-e2e-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await seedFromPrf();
});

test.afterAll(async () => {
  await context?.close();
  await server?.close();
  if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
});

async function seedFromPrf(): Promise<void> {
  await worker.evaluate(
    (prf) => (globalThis as unknown as E2EHooks).__entzSeedFromPrf(prf),
    E2E_PRF_HEX,
  );
}

async function status(): Promise<KeyStatus> {
  const reply = await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzStatus());
  return reply.status;
}

async function openFixture(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(server.url);
  return page;
}

/** Playwright's CSS engine pierces the pane's open shadow root, so these need no host hop. */
const card = (page: Page): Locator => page.locator("[data-entz-card]");
const cardText = (page: Page): Locator => card(page).locator("[data-entz-text]");

/** How many tokens the content script has tagged, ours and other people's alike. */
const tokenCount = async (page: Page): Promise<number> =>
  (await highlighted(page, "entz-tag")).length + (await highlighted(page, "entz-foreign")).length;

/** Waits for the first scan of the fixture to have tagged every token. */
const scanned = (page: Page, count = 6): Promise<void> =>
  expect.poll(() => tokenCount(page)).toBe(count);

/**
 * The tokens whose `ENTZ1:` marker is painted by the highlight layer named `family`, sorted.
 */
const highlighted = (page: Page, family: string): Promise<string[]> =>
  page.evaluate((name) => {
    const out: string[] = [];
    for (const [layer, highlight] of CSS.highlights) {
      if (layer !== name && !new RegExp(`^${name}-\\d+$`).test(layer)) continue;
      for (const r of highlight) {
        const range = r as Range;
        const text = (range.startContainer as Text).data.slice(range.startOffset);
        const match = /^(ENTZ1:)?([A-Za-z0-9_-]+)/.exec(text);
        // A body range starts just after the marker; name it by its whole token either way.
        out.push(match === null ? range.toString() : `ENTZ1:${match[2]}`);
      }
    }
    return out.sort();
  }, family);

const sorted = (...tokens: string[]): string[] => [...tokens].sort();

const textOf = (page: Page, selector: string): Promise<string | null> =>
  page.locator(selector).evaluate((el) => el.textContent);

const box = async (
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> => {
  const rect = await locator.boundingBox();
  if (rect === null) throw new Error("element has no box");
  return rect;
};

/** The centre of the `ENTZ1:` tag of the first token inside `selector`. */
async function tagPoint(page: Page, selector: string): Promise<{ x: number; y: number }> {
  await expect.poll(() => tokenCount(page)).toBeGreaterThan(0);
  await page.locator(selector).scrollIntoViewIfNeeded();
  const point = await page.evaluate((sel) => {
    for (const [name, highlight] of CSS.highlights) {
      if (name !== "entz-tag" && name !== "entz-foreign") continue;
      for (const r of highlight) {
        const range = r as Range;
        if (range.startContainer.parentElement?.closest(sel) == null) continue;
        const rect = range.getClientRects()[0];
        if (rect === undefined) return null;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    }
    return null;
  }, selector);
  if (point === null) throw new Error(`no tag inside ${selector}`);
  return point;
}

/** The token whose tag is painted inside `selector`, if any. */
const taggedToken = (page: Page, selector: string): Promise<string | null> =>
  page.evaluate((sel) => {
    for (const [name, highlight] of CSS.highlights) {
      if (name !== "entz-tag") continue;
      for (const r of highlight) {
        const range = r as Range;
        if (range.startContainer.parentElement?.closest(sel) == null) continue;
        const text = (range.startContainer as Text).data.slice(range.startOffset);
        return /^ENTZ1:[A-Za-z0-9_-]+/.exec(text)?.[0] ?? null;
      }
    }
    return null;
  }, selector);

/** Moves the cursor onto the token inside `selector` and waits for its card. */
async function hoverToken(page: Page, selector: string): Promise<void> {
  const point = await tagPoint(page, selector);
  await page.mouse.move(point.x, point.y);
  await expect(card(page)).toBeVisible();
}

/** Parks the cursor on the fixture heading, away from every token and from the pane. */
const hoverNothing = (page: Page): Promise<void> => page.locator("h1").hover();

const DRAFT = (body: string): string => `Draft: ${body} (still editing)`;

test("loads under the extension id the manifest key pins", async () => {
  expect(await worker.evaluate(() => chrome.runtime.id)).toBe(EXTENSION_ID);
});

test("derives the vector's recipient key from the seeded PRF output", async () => {
  expect((await status()).identity?.publicKey).toBe(recipient.publicKey);
});

test("leaves every text node byte-identical to the ciphertext, editable or not", async () => {
  const page = await openFixture();
  await scanned(page);

  expect(await textOf(page, "#para")).toBe(
    `Heads up: ${token("ascii-title")} — please review today.`,
  );
  expect(await textOf(page, "#row")).toBe(token("with-newline"));
  expect(await textOf(page, "#editable-para")).toBe(DRAFT(token("ascii-title")));
  expect(await page.locator("#editable").evaluate((el) => el.textContent?.trim())).toBe(
    DRAFT(token("ascii-title")),
  );
  expect(await textOf(page, "#foreign")).toBe(`Someone else's: ${token("foreign")}`);
  // The pane's shadow host is the only node entziffer adds to the page.
  await expect(page.locator("[data-entz-host]")).toHaveCount(1);
  expect(
    await page.evaluate(
      () =>
        [...document.querySelectorAll("body *")].filter((el) =>
          [...el.attributes].some((a) => a.name.startsWith("data-entz-")),
        ).length,
    ),
  ).toBe(1);
  await page.close();
});

test("shows no plaintext at all until a token is hovered", async () => {
  const page = await openFixture();
  await scanned(page);
  await expect(card(page)).toBeHidden();
  await expect(cardText(page)).toHaveCount(0);
  await expect(page.locator("[data-entz-host] textarea, [data-entz-host] input")).toHaveCount(0);
  await page.close();
});

test("tags every token's marker with a highlight and leaves the ciphertext as rendered", async () => {
  const page = await openFixture();
  await scanned(page);

  expect(await highlighted(page, "entz-tag")).toEqual(
    sorted(
      token("ascii-title"),
      token("with-newline"),
      token("ascii-title"),
      token("title-60"),
      token("ascii-title"),
    ),
  );
  expect(await highlighted(page, "entz-foreign")).toEqual([token("foreign")]);
  expect(await textOf(page, "#editable-multiline")).toBe(token("title-60"));
  expect(
    await page.evaluate(() => {
      for (const sheet of document.adoptedStyleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule.cssText.startsWith("::highlight(entz-tag)")) return rule.cssText;
        }
      }
      return null;
    }),
  ).toMatch(/background-color: color-mix\(/);
  expect(
    await page.evaluate(() => {
      for (const sheet of document.adoptedStyleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule.cssText.startsWith("::highlight(entz-dim-0)")) return rule.cssText;
        }
      }
      return null;
    }),
  ).toMatch(/color: color-mix\(in srgb, rgb\(0, 0, 0\) 65%, transparent/);
  expect(await highlighted(page, "entz-dim")).toHaveLength(6);
  expect(
    await page.evaluate(() =>
      [...CSS.highlights]
        .filter(([name]) => name === "entz-tag")
        .flatMap(([, h]) => [...h].map((r) => (r as Range).toString())),
    ),
  ).toEqual(Array(5).fill("ENTZ1:"));
  await page.close();
});

test("hovering a token shows its plaintext in the token's own typography, then hides it", async () => {
  const page = await openFixture();
  await hoverToken(page, "#editable-para");
  await expect(cardText(page)).toHaveText(plaintext("ascii-title"));

  const typeOf = (el: Element): Record<string, string> => {
    const s = getComputedStyle(el);
    return Object.fromEntries(
      [
        "font-family",
        "font-size",
        "font-weight",
        "font-style",
        "font-feature-settings",
        "font-variant-numeric",
        "line-height",
        "letter-spacing",
        "color",
      ].map((p) => [p, s.getPropertyValue(p)]),
    );
  };
  const expected = await page.locator("#editable-para").evaluate(typeOf);
  const width = await page
    .locator("#editable-para")
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(await cardText(page).evaluate(typeOf)).toEqual(expected);
  // The fixture's editor has a tuned type stack, which is what defeats the `font` shorthand.
  expect(expected["font-weight"]).toBe("500");
  expect(expected["font-size"]).toBe("20px");
  expect(expected["font-feature-settings"]).toBe('"tnum"');
  // The card wraps at the token's block width, capped so a full-width block stays a card.
  expect(await card(page).evaluate((el) => el.style.maxWidth)).toBe(`${Math.min(720, width)}px`);
  // The hovered token's body leaves the dim layer; every other body, foreign included, stays faded.
  expect(await highlighted(page, "entz-dim")).toEqual(
    sorted(
      token("ascii-title"),
      token("with-newline"),
      token("ascii-title"),
      token("title-60"),
      token("foreign"),
    ),
  );
  expect(await highlighted(page, "entz-tag")).toHaveLength(5);

  await hoverNothing(page);
  await expect(card(page)).toBeHidden();
  await expect.poll(() => highlighted(page, "entz-dim")).toHaveLength(6);
  expect(await highlighted(page, "entz-tag")).toHaveLength(5);
  await page.close();
});

test("the card is plaintext only and goes away the moment the cursor leaves the token", async () => {
  const page = await openFixture();
  await hoverToken(page, "#editable-para");
  await expect(card(page).locator("button, input, textarea, a")).toHaveCount(0);
  await hoverNothing(page);
  await expect(card(page)).toBeHidden();
  await hoverToken(page, "#para");
  await expect(cardText(page)).toHaveText(plaintext("ascii-title"));
  await page.close();
});

test("the card holds steady in the gap between two lines of a wrapped token", async () => {
  const page = await openFixture();
  await scanned(page);
  await page.locator("#editable-multiline").scrollIntoViewIfNeeded();
  const gap = await page.evaluate(() => {
    for (const [name, highlight] of CSS.highlights) {
      if (name !== "entz-tag") continue;
      for (const r of highlight) {
        const range = r as Range;
        if (range.startContainer.parentElement?.closest("#editable-multiline") == null) continue;
        const whole = range.cloneRange();
        whole.setEnd(range.startContainer, (range.startContainer as Text).length);
        const rects = [...whole.getClientRects()].sort((a, b) => a.top - b.top);
        const [first, second] = rects;
        if (first === undefined || second === undefined) return null;
        return {
          x: Math.round(Math.max(first.left, second.left) + 20),
          y: Math.round((first.bottom + second.top) / 2),
          gap: second.top - first.bottom,
        };
      }
    }
    return null;
  });
  if (gap === null) throw new Error("the narrow editor's token did not wrap");
  // The fixture's line-height leaves several pixels of dead space between glyph boxes.
  expect(gap.gap).toBeGreaterThan(4);

  await page.mouse.move(gap.x, gap.y - 12);
  await expect(card(page)).toBeVisible();
  await page.mouse.move(gap.x, gap.y);
  await page.waitForTimeout(150);
  await expect(card(page)).toBeVisible();
  await expect(cardText(page)).toHaveText(plaintext("title-60"));
  await page.close();
});

test("clicking a token pins its card until Escape", async () => {
  const page = await openFixture();
  const point = await tagPoint(page, "#row");
  await page.mouse.click(point.x, point.y);
  await expect(cardText(page)).toHaveText(plaintext("with-newline"));
  await hoverNothing(page);
  await page.waitForTimeout(600);
  await expect(card(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card(page)).toBeHidden();
  await page.close();
});

test.describe("editing in the page is refused", () => {
  /** Puts the caret `offset` characters into the token inside `selector`'s first text node. */
  async function caretInToken(page: Page, selector: string, offset: number): Promise<void> {
    await page.locator(selector).click();
    await page.evaluate(
      ([sel, at]) => {
        const el = document.querySelector(sel as string) as HTMLElement;
        const text = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
        const start = text.data.indexOf("ENTZ1:") + (at as number);
        document.getSelection()?.setBaseAndExtent(text, start, text, start);
      },
      [selector, offset],
    );
  }

  test("typing into a token leaves it intact and pins its card instead", async () => {
    const page = await openFixture();
    await scanned(page);
    await caretInToken(page, "#editable-para", 20);
    await page.keyboard.type("x");
    expect(await textOf(page, "#editable-para")).toBe(DRAFT(token("ascii-title")));
    await expect(cardText(page)).toHaveText(plaintext("ascii-title"));
    await page.close();
  });

  test("Backspace at a token's end and typing at its edges are refused too", async () => {
    const page = await openFixture();
    await scanned(page);
    const before = DRAFT(token("ascii-title"));

    await caretInToken(page, "#editable-para", token("ascii-title").length);
    await page.keyboard.press("Backspace");
    expect(await textOf(page, "#editable-para")).toBe(before);
    await page.keyboard.type("z");
    expect(await textOf(page, "#editable-para")).toBe(before);
    await caretInToken(page, "#editable-para", 0);
    await page.keyboard.press("Delete");
    expect(await textOf(page, "#editable-para")).toBe(before);

    // Prose around the token is still the page's to edit.
    await page.evaluate(() => {
      const el = document.getElementById("editable-para") as HTMLElement;
      const text = el.firstChild as Text;
      document.getSelection()?.setBaseAndExtent(text, 0, text, 0);
    });
    await page.keyboard.type("Q");
    expect(await textOf(page, "#editable-para")).toBe(`Q${before}`);
    await page.close();
  });

  test("a real ProseMirror editor refuses the edit through its own keymap as well", async () => {
    const page = await openFixture();
    await scanned(page);
    const pmText = (): Promise<string> =>
      page.evaluate(
        () =>
          (window as unknown as { __pmView: { state: { doc: { textContent: string } } } }).__pmView
            .state.doc.textContent,
      );
    const before = DRAFT(token("ascii-title"));
    expect(await pmText()).toBe(before);

    for (const key of ["x", "Backspace", "Enter"]) {
      await caretInToken(page, "#pm-editor p", 30);
      await page.keyboard.press(key);
      expect(await pmText()).toBe(before);
    }
    expect(await textOf(page, "#pm-editor")).toBe(before);
    await expect(cardText(page)).toHaveText(plaintext("ascii-title"));
    await page.close();
  });
});

test("keeps the pane's own clicks away from the page's handlers", async () => {
  const page = await openFixture();
  await scanned(page);
  await page.evaluate(() => {
    const counters = { keys: 0, clicks: 0 };
    (window as unknown as { __counters: typeof counters }).__counters = counters;
    document.addEventListener("keydown", () => counters.keys++);
    document.addEventListener("click", () => counters.clicks++);
  });
  const counters = (): Promise<{ keys: number; clicks: number }> =>
    page.evaluate(
      () => (window as unknown as { __counters: { keys: number; clicks: number } }).__counters,
    );

  await hoverNothing(page);
  await page.locator("h1").click();
  await page.keyboard.press("p");
  expect(await counters()).toEqual({ keys: 1, clicks: 1 });

  // Pinning keeps the card up once the cursor leaves the token, so it can be clicked at all.
  const point = await tagPoint(page, "#para");
  await page.mouse.click(point.x, point.y);
  await expect(card(page)).toBeVisible();
  expect(await counters()).toEqual({ keys: 1, clicks: 2 });
  await card(page).click();
  expect(await counters()).toEqual({ keys: 1, clicks: 2 });
  await page.close();
});

test("the card follows the cursor across a token", async () => {
  const page = await openFixture();
  const raw = await tagPoint(page, "#editable-para");
  // Playwright moves the mouse to whole pixels.
  const point = { x: Math.round(raw.x), y: Math.round(raw.y) };
  await page.mouse.move(point.x, point.y);
  await expect(card(page)).toBeVisible();
  const first = await box(card(page));
  expect(first.x).toBeCloseTo(point.x + 14, 0);
  // Above the cursor, clear of where the browser would draw a native tooltip.
  expect(first.y + first.height).toBeCloseTo(point.y - 14, 0);

  await page.mouse.move(point.x + 60, point.y);
  await expect.poll(async () => (await box(card(page))).x).toBeCloseTo(point.x + 74, 0);
  const moved = await box(card(page));
  expect(moved.y + moved.height).toBeCloseTo(point.y - 14, 0);

  await page.close();
});

test("the card refracts its backdrop through an SVG filter and is the only thing entziffer shows", async () => {
  const page = await openFixture();
  await scanned(page);
  await expect(card(page)).toBeHidden();
  expect(
    await page.evaluate(() => {
      const host = document.querySelector("[data-entz-host]");
      return [...(host?.shadowRoot?.children ?? [])].map((el) => el.tagName.toLowerCase());
    }),
  ).toEqual(["div", "svg"]);

  await hoverToken(page, "#para");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const host = document.querySelector("[data-entz-host]");
        const el = host?.shadowRoot?.querySelector("[data-entz-glass]");
        if (!(el instanceof HTMLElement)) return null;
        const map = host?.shadowRoot?.querySelector("feImage")?.getAttribute("href") ?? "";
        return `${getComputedStyle(el).backdropFilter} ${map.slice(0, 15)}`;
      }),
    )
    .toMatch(/^url\("#entz-lens-\d+"\) data:image\/png/);
  await page.close();
});

test("tags a token encrypted to someone else in grey and names its recipient on hover", async () => {
  const page = await openFixture();
  await scanned(page);
  expect(await highlighted(page, "entz-foreign")).toEqual([token("foreign")]);
  expect(await textOf(page, "#foreign")).toBe(`Someone else's: ${token("foreign")}`);
  await hoverToken(page, "#foreign");
  await expect(card(page)).toContainText(`Encrypted for someone else · ${foreign.fingerprint}`);
  await expect(cardText(page)).toHaveCount(0);
  await page.close();
});

test("a framework rewriting its own text node swaps the token rather than adding one", async () => {
  const page = await openFixture();
  await scanned(page);
  await page.evaluate((next) => {
    const para = document.getElementById("para") as HTMLElement;
    const owned = [...para.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
    owned.data = `Heads up: ${next} — please review today.`;
  }, token("title-60"));
  await expect.poll(() => taggedToken(page, "#para")).toBe(token("title-60"));
  await scanned(page);
  await hoverToken(page, "#para");
  await expect(cardText(page)).toHaveText(plaintext("title-60"));
  expect(await textOf(page, "#para")).toBe(`Heads up: ${token("title-60")} — please review today.`);
  await page.close();
});

test("counts a token inserted after load within a second", async () => {
  const page = await openFixture();
  await scanned(page);
  await page.click("#insert");
  await expect.poll(() => tokenCount(page), { timeout: 1_000 }).toBe(7);
  await hoverToken(page, "#dynamic-para");
  await expect(cardText(page)).toHaveText(plaintext("ascii-title"));
  await page.close();
});

test("the keystore holds public data and a credential id, never a private key", async () => {
  const meta = await worker.evaluate(() =>
    (globalThis as unknown as E2EHooks).__entzKeyRecordMeta(),
  );
  expect(meta?.fields).toEqual([
    "credentialId",
    "derivation",
    "enrolledAt",
    "fpr",
    "id",
    "publicRaw",
  ]);
  expect(meta?.credentialIdBytes).toBeGreaterThan(0);
});

test.describe("session lock", () => {
  test.afterEach(async () => {
    await seedFromPrf();
  });

  test("locks decryption, tags every token, and unlocks from the card", async () => {
    await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzLockNow());
    expect(await status()).toMatchObject({ hasKey: true, locked: true });

    const page = await openFixture();
    await scanned(page);
    // Locked, every token is tagged in the accent; nothing is known to be somebody else's yet.
    expect(await highlighted(page, "entz-foreign")).toEqual([]);
    await hoverToken(page, "#para");
    await expect(card(page)).toContainText("Locked · click to unlock");
    await expect(cardText(page)).toHaveCount(0);

    const opened = context.waitForEvent("page");
    const point = await tagPoint(page, "#para");
    await page.mouse.click(point.x, point.y);
    const unlockTab = await opened;
    expect(unlockTab.url()).toBe(new URL("unlock/index.html", worker.url()).href);
    await unlockTab.close();

    await worker.evaluate(
      (prf) => (globalThis as unknown as E2EHooks).__entzUnlockWithPrf(prf),
      E2E_PRF_HEX,
    );
    await expect.poll(() => highlighted(page, "entz-foreign")).toEqual([token("foreign")]);
    await hoverNothing(page);
    await hoverToken(page, "#para");
    await expect(cardText(page)).toHaveText(plaintext("ascii-title"));
    expect(await status()).toMatchObject({ locked: false });

    await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzLockNow());
    expect(await status()).toMatchObject({ locked: true });
    await page.reload();
    await scanned(page);
    await hoverToken(page, "#para");
    await expect(card(page)).toContainText("Locked · click to unlock");
    await page.close();
  });

  test("locking takes the card down on an open page without a reload", async () => {
    const page = await openFixture();
    await hoverToken(page, "#para");
    await expect(cardText(page)).toHaveText(plaintext("ascii-title"));

    await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzLockNow());
    await expect(card(page)).toBeHidden();
    await expect(page.locator("#para")).toContainText(token("ascii-title"));
    await hoverNothing(page);
    await hoverToken(page, "#para");
    await expect(card(page)).toContainText("Locked · click to unlock");

    await worker.evaluate(
      (prf) => (globalThis as unknown as E2EHooks).__entzUnlockWithPrf(prf),
      E2E_PRF_HEX,
    );
    await hoverNothing(page);
    await hoverToken(page, "#para");
    await expect(cardText(page)).toHaveText(plaintext("ascii-title"));
    await page.close();
  });

  test("a PRF output from another passkey does not unlock", async () => {
    await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzLockNow());
    await expect(
      worker.evaluate(
        (prf) => (globalThis as unknown as E2EHooks).__entzUnlockWithPrf(prf),
        OTHER_PRF_HEX,
      ),
    ).rejects.toThrow(/different entziffer key/i);
    expect(await status()).toMatchObject({ locked: true });
  });

  test("the startup handler clears the session store", async () => {
    expect(
      await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzHasSessionRecord()),
    ).toBe(true);

    await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzRunStartupHandler());
    expect(
      await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzHasSessionRecord()),
    ).toBe(false);
    expect(await status()).toMatchObject({ locked: true });
  });

  test("a session record without its sentinel never unlocks", async () => {
    await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzClearSessionSentinel());
    expect(await status()).toMatchObject({ locked: true });
    expect(
      await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzHasSessionRecord()),
    ).toBe(false);
  });
});

test.describe("real WebAuthn PRF ceremonies", () => {
  test.afterEach(async () => {
    await seedFromPrf();
  });

  /**
   * The credential is bound to the tab's virtual authenticator, so every ceremony in a test has to
   * happen in that same tab.
   */
  async function pageWithAuthenticator(): Promise<Page> {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        hasPrf: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    return page;
  }

  test("sets up a key, locks, and unlocks to the same public key", async () => {
    await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzClearKey());
    const page = await pageWithAuthenticator();
    await page.goto(new URL("options/index.html", worker.url()).href);
    await page.click("#setup");
    await expect(page.locator("#public-key")).toContainText("entz1pk_");
    const publicKey = await page.locator("#public-key").textContent();
    expect(await status()).toMatchObject({ hasKey: true, locked: false });

    await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzLockNow());
    expect(await status()).toMatchObject({ locked: true });

    // The unlock page closes itself the moment the ceremony succeeds, so assert on the worker.
    await page.goto(new URL("unlock/index.html", worker.url()).href).catch(() => undefined);
    await expect.poll(async () => (await status()).locked, { timeout: 10_000 }).toBe(false);
    expect((await status()).identity?.publicKey).toBe(publicKey);
    await page.close();
  });

  test("recovers the same key from an existing discoverable passkey", async () => {
    await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzClearKey());
    const page = await pageWithAuthenticator();
    const optionsUrl = new URL("options/index.html", worker.url()).href;
    await page.goto(optionsUrl);
    await page.click("#setup");
    await expect(page.locator("#public-key")).toContainText("entz1pk_");
    const publicKey = await page.locator("#public-key").textContent();

    await page.fill("#forget-confirm", (await status()).identity?.fingerprint ?? "");
    await page.click("#forget");
    await expect.poll(async () => (await status()).hasKey).toBe(false);

    // Empty `allowCredentials`: the browser picks the resident credential, exactly as a second Mac
    // would find the passkey synced through iCloud Keychain.
    await page.click("#recover");
    await expect(page.locator("#status")).toContainText("Ready");
    await expect(page.locator("#public-key")).toHaveText(publicKey ?? "");
    expect((await status()).identity?.publicKey).toBe(publicKey);
    await page.close();
  });
});
