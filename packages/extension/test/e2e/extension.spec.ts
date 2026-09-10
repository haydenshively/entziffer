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
const entries = (page: Page): Locator => page.locator("[data-entz-entry]");

const entryText = (page: Page): Promise<string[]> =>
  entries(page)
    .locator("textarea")
    .evaluateAll((els) => els.map((el) => (el as HTMLTextAreaElement).value));

/** The ranges a highlight layer currently paints, as the text they cover. */
const highlighted = (page: Page, layer: string): Promise<string[]> =>
  page.evaluate(
    (name) => [...(CSS.highlights.get(name) ?? [])].map((r) => (r as Range).toString()),
    layer,
  );

const textOf = (page: Page, selector: string): Promise<string | null> =>
  page.locator(selector).evaluate((el) => el.textContent);

/** Every token in the fixture, in document order, as the pane lists them. */
const ALL_TEXT = [
  plaintext("ascii-title"),
  plaintext("with-newline"),
  plaintext("ascii-title"),
  plaintext("title-60"),
  plaintext("ascii-title"),
];

const box = async (
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> => {
  const rect = await locator.boundingBox();
  if (rect === null) throw new Error("element has no box");
  return rect;
};

const paneRect = (): Promise<Record<string, number> | undefined> =>
  worker.evaluate(
    () =>
      (globalThis as unknown as E2EHooks).__entzGetLocal("paneRect") as Promise<
        Record<string, number> | undefined
      >,
  );

test("loads under the extension id the manifest key pins", async () => {
  expect(await worker.evaluate(() => chrome.runtime.id)).toBe(EXTENSION_ID);
});

test("derives the vector's recipient key from the seeded PRF output", async () => {
  expect((await status()).identity?.publicKey).toBe(recipient.publicKey);
});

test("leaves every text node byte-identical to the ciphertext, editable or not", async () => {
  const page = await openFixture();
  await expect(page.locator("[data-entz-pane]")).toBeVisible();

  expect(await textOf(page, "#para")).toBe(
    `Heads up: ${token("ascii-title")} — please review today.`,
  );
  expect(await textOf(page, "#row")).toBe(token("with-newline"));
  const expected = `Draft: ${token("ascii-title")} (still editing)`;
  expect(await textOf(page, "#editable-para")).toBe(expected);
  expect(await page.locator("#editable").evaluate((el) => el.textContent?.trim())).toBe(expected);
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

test("lists every token in the pane, in document order, editable ones as editable", async () => {
  const page = await openFixture();
  await expect(entries(page)).toHaveCount(6);
  expect(await entryText(page)).toEqual(ALL_TEXT);
  await expect(page.locator("[data-entz-count]")).toHaveText("6 encrypted");

  const readOnly = await entries(page)
    .locator("textarea")
    .evaluateAll((els) => els.map((el) => (el as HTMLTextAreaElement).readOnly));
  expect(readOnly).toEqual([true, true, false, false, false]);
  await expect(entries(page).locator("[data-entz-insert]")).toHaveCount(3);
  await expect(entries(page).nth(0).locator("[data-entz-insert]")).toHaveCount(0);
  await expect(entries(page).nth(0).locator("[data-entz-copy]")).toHaveCount(1);
  await expect(entries(page).nth(5)).toContainText(
    `Encrypted for someone else · ${foreign.fingerprint}`,
  );
  await page.close();
});

test("masks every token with a highlight that hides its glyphs behind a solid fill", async () => {
  const page = await openFixture();
  await expect(entries(page)).toHaveCount(6);

  // The 157-character token in the 220px editor wraps; the range spans all of it.
  expect(await highlighted(page, "entz-mask")).toEqual([
    token("ascii-title"),
    token("with-newline"),
    token("ascii-title"),
    token("title-60"),
    token("ascii-title"),
  ]);
  expect(await highlighted(page, "entz-foreign")).toEqual([token("foreign")]);
  expect(await textOf(page, "#editable-multiline")).toBe(token("title-60"));
  // The element's own colour is untouched: only the highlight pseudo-element hides the text.
  expect(
    await page.locator("#editable-multiline").evaluate((el) => getComputedStyle(el).color),
  ).not.toBe("rgba(0, 0, 0, 0)");
  expect(
    await page.evaluate(() => {
      for (const sheet of document.adoptedStyleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule.cssText.startsWith("::highlight(entz-mask)")) return rule.cssText;
        }
      }
      return null;
    }),
  ).toMatch(/color: transparent;.*background-color: color-mix\(/s);
  await page.close();
});

test("hovering an entry focuses its token and dims the others", async () => {
  const page = await openFixture();
  await expect(entries(page)).toHaveCount(6);

  await entries(page).nth(3).hover();
  await expect.poll(() => highlighted(page, "entz-focus")).toEqual([token("title-60")]);
  expect(await highlighted(page, "entz-dim")).toEqual([
    token("ascii-title"),
    token("with-newline"),
    token("ascii-title"),
    token("ascii-title"),
    token("foreign"),
  ]);
  expect(await highlighted(page, "entz-mask")).toEqual([]);

  await page.locator("h1").hover();
  await expect.poll(() => highlighted(page, "entz-focus")).toEqual([]);
  expect(await highlighted(page, "entz-dim")).toEqual([]);
  expect(await highlighted(page, "entz-mask")).toHaveLength(5);
  await page.close();
});

test("hovering a token in the page marks and focuses its pane entry", async () => {
  const page = await openFixture();
  await expect(entries(page)).toHaveCount(6);
  await page.locator("#pm-editor").scrollIntoViewIfNeeded();

  const point = await page.evaluate(() => {
    for (const entry of CSS.highlights.get("entz-mask") ?? []) {
      const range = entry as Range;
      if (range.startContainer.parentElement?.closest("#pm-editor") == null) continue;
      const rect = range.getClientRects()[0];
      if (rect === undefined) return null;
      return { x: rect.left + 4, y: rect.top + rect.height / 2 };
    }
    return null;
  });
  if (point === null) throw new Error("no token rect inside the ProseMirror editor");

  await page.mouse.move(point.x, point.y);
  await expect(entries(page).nth(4)).toHaveAttribute("data-entz-active", "");
  await expect(entries(page).nth(2)).not.toHaveAttribute("data-entz-active", "");
  await expect(entries(page).nth(3)).not.toHaveAttribute("data-entz-active", "");
  expect(await highlighted(page, "entz-focus")).toEqual([token("ascii-title")]);

  await page.mouse.move(4, 4);
  await expect(entries(page).nth(4)).not.toHaveAttribute("data-entz-active", "");
  await expect.poll(() => highlighted(page, "entz-focus")).toEqual([]);
  await page.close();
});

test.describe("insert plaintext", () => {
  const DRAFT = (body: string): string => `Draft: ${body} (still editing)`;

  const insertOf = (page: Page, index: number): Locator =>
    entries(page).nth(index).locator("[data-entz-insert]");

  test("rewrites a plain contenteditable and leaves nothing to re-render", async () => {
    const page = await openFixture();
    await expect(entries(page)).toHaveCount(6);

    await expect(insertOf(page, 2)).toHaveAttribute(
      "title",
      /Saving the field afterwards stores it/,
    );
    await insertOf(page, 2).click();

    await expect.poll(() => textOf(page, "#editable-para")).toBe(DRAFT(plaintext("ascii-title")));
    await expect(entries(page)).toHaveCount(5);

    await page.click("#insert");
    await expect(entries(page)).toHaveCount(6);
    expect(await textOf(page, "#editable-para")).toBe(DRAFT(plaintext("ascii-title")));
    expect(await textOf(page, "#dynamic-para")).toBe(`Late arrival: ${token("ascii-title")} ok`);
    await page.close();
  });

  test("inserts the value the user edited in the pane, not the original plaintext", async () => {
    const page = await openFixture();
    await expect(entries(page)).toHaveCount(6);

    const textarea = entries(page).nth(2).locator("textarea");
    await textarea.fill("edited in the pane");
    await insertOf(page, 2).click();

    await expect.poll(() => textOf(page, "#editable-para")).toBe(DRAFT("edited in the pane"));
    await expect(entries(page)).toHaveCount(5);
    await page.close();
  });

  test("rewrites a real ProseMirror editor through its own state", async () => {
    const page = await openFixture();
    await expect(entries(page)).toHaveCount(6);
    expect(await textOf(page, "#pm-editor")).toBe(DRAFT(token("ascii-title")));

    await insertOf(page, 4).click();

    await expect.poll(() => textOf(page, "#pm-editor")).toBe(DRAFT(plaintext("ascii-title")));
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __pmView: { state: { doc: { textContent: string } } } }).__pmView
            .state.doc.textContent,
      ),
    ).toBe(DRAFT(plaintext("ascii-title")));
    await expect(entries(page)).toHaveCount(5);
    await page.close();
  });
});

test.describe("editing in the pane", () => {
  const DRAFT = /^Draft: (ENTZ1:\S+) \(still editing\)$/;

  interface PaneFocus {
    value: string;
    start: number | null;
    end: number | null;
  }

  /** The pane lives in a shadow root, so `document.activeElement` only ever names its host. */
  const paneFocus = (page: Page): Promise<PaneFocus | null> =>
    page.evaluate(() => {
      for (const host of document.querySelectorAll("[data-entz-host]")) {
        const active = host.shadowRoot?.activeElement;
        if (active instanceof HTMLTextAreaElement) {
          return { value: active.value, start: active.selectionStart, end: active.selectionEnd };
        }
      }
      return null;
    });

  const pmText = (page: Page): Promise<string> =>
    page.evaluate(
      () =>
        (window as unknown as { __pmView: { state: { doc: { textContent: string } } } }).__pmView
          .state.doc.textContent,
    );

  /** Types at the end of an entry's textarea and marks it, so a rebuilt row would be visible. */
  async function typeInto(page: Page, index: number, suffix: string): Promise<void> {
    const textarea = entries(page).nth(index).locator("textarea");
    await textarea.click();
    await textarea.evaluate((el) => {
      const field = el as HTMLTextAreaElement;
      field.dataset.probe = "kept";
      field.setSelectionRange(field.value.length, field.value.length);
    });
    await page.keyboard.type(suffix);
  }

  function rewritten(before: string, text: string | null): string {
    const match = DRAFT.exec(text ?? "");
    if (match === null) throw new Error(`not a draft holding one token: ${text}`);
    const after = match[1] as string;
    expect(after).not.toBe(before);
    return after;
  }

  test("re-encrypts a plain contenteditable as the user types, without moving the caret", async () => {
    const page = await openFixture();
    await expect(entries(page)).toHaveCount(6);
    const before = token("ascii-title");

    await typeInto(page, 2, " plus more");
    const edited = `${plaintext("ascii-title")} plus more`;

    await expect
      .poll(() => textOf(page, "#editable-para"), { timeout: 5_000 })
      .not.toBe(`Draft: ${before} (still editing)`);
    rewritten(before, await textOf(page, "#editable-para"));
    expect(await textOf(page, "#editable-para")).not.toContain(plaintext("ascii-title"));

    await expect(entries(page)).toHaveCount(6);
    await expect(entries(page).nth(2).locator("textarea")).toHaveAttribute("data-probe", "kept");
    expect(await paneFocus(page)).toEqual({
      value: edited,
      start: edited.length,
      end: edited.length,
    });
    await page.close();
  });

  test("re-encrypts a real ProseMirror editor and keeps the row and its caret", async () => {
    const page = await openFixture();
    await expect(entries(page)).toHaveCount(6);
    const before = token("ascii-title");
    expect(await pmText(page)).toBe(`Draft: ${before} (still editing)`);

    await typeInto(page, 4, "!");
    const edited = `${plaintext("ascii-title")}!`;

    await expect
      .poll(() => pmText(page), { timeout: 5_000 })
      .not.toBe(`Draft: ${before} (still editing)`);
    const after = rewritten(before, await pmText(page));
    expect(after).toBe(rewritten(before, await textOf(page, "#pm-editor")));
    expect(await pmText(page)).not.toContain(plaintext("ascii-title"));

    await expect(entries(page)).toHaveCount(6);
    await expect(entries(page).nth(4).locator("textarea")).toHaveAttribute("data-probe", "kept");
    expect(await paneFocus(page)).toEqual({
      value: edited,
      start: edited.length,
      end: edited.length,
    });
    await expect.poll(() => entryText(page)).toEqual([...ALL_TEXT.slice(0, 4), edited]);
    await page.close();
  });

  test("keeps the pane's own keys and clicks away from the page's handlers", async () => {
    const page = await openFixture();
    await expect(entries(page)).toHaveCount(6);
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

    await page.locator("h1").click();
    await page.keyboard.press("p");
    expect(await counters()).toEqual({ keys: 1, clicks: 1 });

    const textarea = entries(page).nth(2).locator("textarea");
    await textarea.click();
    await page.keyboard.press("p");
    expect(await counters()).toEqual({ keys: 1, clicks: 1 });
    expect(await paneFocus(page)).toMatchObject({ value: `${plaintext("ascii-title")}p` });
    await page.close();
  });
});

test.describe("the pane window", () => {
  test("collapses to a pill that refracts its backdrop through an SVG filter", async () => {
    const page = await openFixture();
    await expect(entries(page)).toHaveCount(6);
    const pill = page.locator("[data-entz-pill]");
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute("aria-expanded", "true");
    await page.locator("[data-entz-collapse]").click();

    await expect(pill).toBeVisible();
    await expect(pill).toHaveText("6");
    await expect(pill).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("[data-entz-window]")).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(() => {
          for (const host of document.querySelectorAll("[data-entz-host]")) {
            const el = host.shadowRoot?.querySelector("[data-entz-pill]");
            if (!(el instanceof HTMLElement)) continue;
            const map = host.shadowRoot?.querySelector("feImage")?.getAttribute("href") ?? "";
            return `${getComputedStyle(el).backdropFilter} ${map.slice(0, 15)}`;
          }
          return null;
        }),
      )
      .toMatch(/^url\("#entz-lens-\d+"\) data:image\/png/);

    await pill.click();
    await expect(page.locator("[data-entz-window]")).toBeVisible();
    await page.close();
  });

  test("Esc collapses the pane while focus is inside it", async () => {
    const page = await openFixture();
    await entries(page).nth(2).locator("textarea").focus();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-entz-pill]")).toBeVisible();
    await expect(page.locator("[data-entz-window]")).toBeHidden();
    await page.locator("[data-entz-pill]").click();
    await expect(page.locator("[data-entz-window]")).toBeVisible();
    await page.close();
  });

  test("persists a drag and a resize to chrome.storage.local", async () => {
    const page = await openFixture();
    await expect(entries(page)).toHaveCount(6);

    const header = page.locator("[data-entz-pane] .pane-head");
    const from = await header.boundingBox();
    if (from === null) throw new Error("no header box");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 - 120, from.y + from.height / 2 - 90, {
      steps: 8,
    });
    await page.mouse.up();

    await expect.poll(async () => (await paneRect())?.right).toBeGreaterThan(100);
    expect((await paneRect())?.bottom).toBeGreaterThan(90);

    const body = page.locator("[data-entz-body]");
    const box = await body.boundingBox();
    if (box === null) throw new Error("no body box");
    await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 90, box.y + box.height - 40, { steps: 8 });
    await page.mouse.up();

    await expect.poll(async () => (await paneRect())?.width).toBeLessThan(340);
    await page.close();
  });

  test.afterAll(async () => {
    await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzClearLocal("paneRect"));
  });
});

test("masks a token encrypted to someone else in grey and names its recipient in the pane", async () => {
  const page = await openFixture();
  await expect(entries(page)).toHaveCount(6);
  expect(await highlighted(page, "entz-foreign")).toEqual([token("foreign")]);
  expect(await textOf(page, "#foreign")).toBe(`Someone else's: ${token("foreign")}`);
  const row = entries(page).nth(5);
  await expect(row).toContainText(`Encrypted for someone else · ${foreign.fingerprint}`);
  await expect(row.locator("textarea")).toHaveCount(0);
  await page.close();
});

test("a framework rewriting its own text node swaps the entry rather than adding one", async () => {
  const page = await openFixture();
  await expect(entries(page)).toHaveCount(6);
  await page.evaluate((next) => {
    const para = document.getElementById("para") as HTMLElement;
    const owned = [...para.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
    owned.data = `Heads up: ${next} — please review today.`;
  }, token("title-60"));
  await expect.poll(() => entryText(page)).toEqual([plaintext("title-60"), ...ALL_TEXT.slice(1)]);
  await expect(entries(page)).toHaveCount(6);
  await expect.poll(() => highlighted(page, "entz-mask")).toContain(token("title-60"));
  expect(await textOf(page, "#para")).toBe(`Heads up: ${token("title-60")} — please review today.`);
  await page.close();
});

test("lists a token inserted after load within a second", async () => {
  const page = await openFixture();
  await expect(entries(page)).toHaveCount(6);
  await page.click("#insert");
  await expect(entries(page)).toHaveCount(7, { timeout: 1_000 });
  await expect.poll(() => entryText(page)).toEqual([...ALL_TEXT, plaintext("ascii-title")]);
  await page.close();
});

test("collapsing never moves the pill, and the window reopens above its right edge after a drag", async () => {
  const page = await openFixture();
  const win = page.locator("[data-entz-window]");
  const pill = page.locator("[data-entz-pill]");
  await expect(win).toBeVisible();
  const head = await box(page.locator(".pane-head"));
  await page.mouse.move(head.x + 40, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x - 260, head.y - 160, { steps: 6 });
  await page.mouse.up();
  const before = await box(pill);
  const windowBefore = await box(win);
  expect(windowBefore.x + windowBefore.width).toBeCloseTo(before.x + before.width, 0);
  expect(windowBefore.y + windowBefore.height).toBeLessThan(before.y);

  await page.click("[data-entz-collapse]");
  await expect(win).toBeHidden();
  await expect(pill).toBeVisible();
  expect(await box(pill)).toEqual(before);
  expect(await pill.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe(
    await win.evaluate((el) => getComputedStyle(el).borderTopLeftRadius),
  );

  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x - 120, before.y + 60, { steps: 6 });
  await page.mouse.up();
  await expect(pill).toBeVisible();
  const moved = await box(pill);
  expect(moved.x).toBeLessThan(before.x - 100);

  await pill.click();
  await expect(win).toBeVisible();
  expect(await box(pill)).toEqual(moved);
  const windowAfter = await box(win);
  expect(windowAfter.x + windowAfter.width).toBeCloseTo(moved.x + moved.width, 0);
  expect(windowAfter.y + windowAfter.height).toBeLessThan(moved.y);
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

  test("locks decryption, masks every token, and unlocks in place", async () => {
    await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzLockNow());
    expect(await status()).toMatchObject({ hasKey: true, locked: true });

    const page = await openFixture();
    await expect(page.locator("[data-entz-unlock]")).toHaveText("Unlock");
    await expect(entries(page)).toHaveCount(0);
    await expect(page.locator("[data-entz-count]")).toHaveText("6 encrypted");
    await expect.poll(() => highlighted(page, "entz-mask")).toHaveLength(6);
    expect(await highlighted(page, "entz-foreign")).toEqual([]);

    const opened = context.waitForEvent("page");
    await page.click("[data-entz-unlock]");
    const unlockTab = await opened;
    expect(unlockTab.url()).toBe(new URL("unlock/index.html", worker.url()).href);
    await unlockTab.close();

    // The pill reads "Locked" and, once the window is collapsed, unlocks on its own.
    const pill = page.locator("[data-entz-pill]");
    await expect(pill).toHaveText(/Locked/);
    await page.click("[data-entz-collapse]");
    await expect(page.locator("[data-entz-window]")).toBeHidden();
    const reopened = context.waitForEvent("page");
    await pill.click();
    const secondTab = await reopened;
    expect(secondTab.url()).toBe(new URL("unlock/index.html", worker.url()).href);
    await secondTab.close();
    await expect(page.locator("[data-entz-window]")).toBeHidden();

    await worker.evaluate(
      (prf) => (globalThis as unknown as E2EHooks).__entzUnlockWithPrf(prf),
      E2E_PRF_HEX,
    );
    await expect(entries(page)).toHaveCount(6);
    await expect(pill).toHaveText("6");
    expect(await entryText(page)).toEqual(ALL_TEXT);
    expect(await status()).toMatchObject({ locked: false });

    await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzLockNow());
    expect(await status()).toMatchObject({ locked: true });
    await page.reload();
    await expect(page.locator("[data-entz-unlock]")).toBeVisible();
    await expect(entries(page)).toHaveCount(0);
    await page.close();
  });

  test("locking empties the pane on an open page without a reload", async () => {
    const page = await openFixture();
    await expect(entries(page)).toHaveCount(6);

    await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzLockNow());
    await expect(entries(page)).toHaveCount(0);
    await expect(page.locator("[data-entz-unlock]")).toBeVisible();
    await expect(page.locator("#para")).toContainText(token("ascii-title"));
    await expect(page.locator("[data-entz-pill]")).toHaveText(/Locked/);

    await worker.evaluate(
      (prf) => (globalThis as unknown as E2EHooks).__entzUnlockWithPrf(prf),
      E2E_PRF_HEX,
    );
    await expect(entries(page)).toHaveCount(6);
    await expect(page.locator("[data-entz-unlock]")).toHaveCount(0);
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
