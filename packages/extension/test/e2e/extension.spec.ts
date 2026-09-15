import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrowserContext,
  chromium,
  expect,
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

async function setSettings(patch: Record<string, unknown>): Promise<void> {
  await worker.evaluate((p) => (globalThis as unknown as E2EHooks).__entzSetSettings(p), patch);
}

async function openFixture(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(server.url);
  return page;
}

test("loads under the extension id the manifest key pins", async () => {
  expect(await worker.evaluate(() => chrome.runtime.id)).toBe(EXTENSION_ID);
});

test("derives the vector's recipient key from the seeded PRF output", async () => {
  expect((await status()).identity?.publicKey).toBe(recipient.publicKey);
});

test("decrypts a token sitting mid-sentence in a paragraph", async () => {
  const page = await openFixture();
  await expect(page.locator("#para [data-entz-plain]")).toHaveText(plaintext("ascii-title"));
  await expect(page.locator("#para")).toContainText("please review today");
  await expect(page.locator("#para")).not.toContainText("ENTZ1:");
  await page.close();
});

test("decrypts a list row and preserves newlines in the replacement", async () => {
  const page = await openFixture();
  const span = page.locator("#row [data-entz-plain]");
  await expect(span).toHaveAttribute("data-entz-ct", token("with-newline"));
  expect(await span.evaluate((el) => el.textContent)).toBe(plaintext("with-newline"));
  expect(await span.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("pre-wrap");
  await page.close();
});

test("leaves the contenteditable's textContent byte-identical to the ciphertext", async () => {
  const page = await openFixture();
  await expect(page.locator("#para [data-entz-plain]")).toBeVisible();
  await expect(page.locator("[data-entz-overlay]").first()).toBeVisible();

  const expected = `Draft: ${token("ascii-title")} (still editing)`;
  expect(await page.locator("#editable-para").evaluate((el) => el.textContent)).toBe(expected);
  expect(await page.locator("#editable").evaluate((el) => el.textContent?.trim())).toBe(expected);
  await expect(page.locator("#editable [data-entz-plain]")).toHaveCount(0);
  await expect(page.locator("#editable [data-entz-badge]")).toHaveCount(0);
  await page.close();
});

test("floats an overlay with the plaintext on top of the editable token", async () => {
  const page = await openFixture();
  await expect(page.locator("[data-entz-overlay]")).toHaveCount(2);
  const overlay = page.locator("[data-entz-overlay]").filter({ hasText: plaintext("ascii-title") });
  await expect(overlay).toHaveText(plaintext("ascii-title"));

  const box = await overlay.boundingBox();
  const target = await page.locator("#editable-para").boundingBox();
  expect(box).not.toBeNull();
  expect(target).not.toBeNull();
  if (box === null || target === null) return;
  expect(box.y + box.height).toBeGreaterThan(target.y - 4);
  expect(box.y).toBeLessThan(target.y + target.height + 4);
  expect(box.x + box.width).toBeGreaterThan(target.x);
  expect(box.x).toBeLessThan(target.x + target.width);
  await page.close();
});

test("masks a wrapped editable token with one overlay box per line", async () => {
  const page = await openFixture();
  const overlay = page.locator("[data-entz-overlay]").filter({ hasText: plaintext("title-60") });
  await expect(overlay).toHaveText(plaintext("title-60"));

  const target = await page.locator("#editable-multiline").boundingBox();
  expect(target).not.toBeNull();
  if (target === null) return;

  const boxes = await page.locator("[data-entz-overlay-line]").all();
  const inside = [];
  for (const box of boxes) {
    const rect = await box.boundingBox();
    if (rect === null) continue;
    if (
      rect.x >= target.x - 4 &&
      rect.x + rect.width <= target.x + target.width + 4 &&
      rect.y >= target.y - 4 &&
      rect.y + rect.height <= target.y + target.height + 4
    ) {
      inside.push(rect);
    }
  }
  // The token is 157 characters in a 220px editor, so it wraps: one masking box per line.
  expect(inside.length).toBeGreaterThanOrEqual(2);
  expect(await page.locator("#editable-multiline").evaluate((el) => el.textContent)).toBe(
    token("title-60"),
  );
  await page.close();
});

test("badges a token encrypted to someone else and leaves its text alone", async () => {
  const page = await openFixture();
  await expect(page.locator("#foreign [data-entz-badge]")).toHaveAttribute(
    "title",
    `Encrypted for someone else (fingerprint ${foreign.fingerprint})`,
  );
  await expect(page.locator("#foreign")).toContainText(token("foreign"));
  await expect(page.locator("#foreign [data-entz-plain]")).toHaveCount(0);
  await page.close();
});

test("decrypts a token inserted after load within a second", async () => {
  const page = await openFixture();
  await expect(page.locator("#para [data-entz-plain]")).toBeVisible();
  await page.click("#insert");
  await expect(page.locator("#dynamic-para [data-entz-plain]")).toHaveText(
    plaintext("ascii-title"),
    { timeout: 1_000 },
  );
  await page.close();
});

test("overlay-only mode never rewrites page text", async () => {
  await setSettings({ overlayOnly: true });
  const page = await openFixture();
  const original = `Heads up: ${token("ascii-title")} — please review today.`;

  await expect(page.locator("[data-entz-overlay]")).toHaveCount(4);
  expect(await page.locator("#para").evaluate((el) => el.textContent)).toBe(original);
  await expect(page.locator("[data-entz-plain]")).toHaveCount(0);
  await expect(page.locator("[data-entz-badge]")).toHaveCount(0);
  expect(await page.locator("[data-entz-overlay]").allTextContents()).toContain(
    plaintext("ascii-title"),
  );
  await page.close();
  await setSettings({ overlayOnly: false });
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

  test("locks decryption, shows one unlock badge, and unlocks in place", async () => {
    await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzLockNow());
    expect(await status()).toMatchObject({ hasKey: true, locked: true });

    const page = await openFixture();
    await expect(page.locator("[data-entz-locked]")).toHaveCount(1);
    await expect(page.locator("[data-entz-locked]")).toHaveAttribute(
      "title",
      "Click to unlock entziffer",
    );
    await expect(page.locator("[data-entz-plain]")).toHaveCount(0);

    const opened = context.waitForEvent("page");
    await page.click("[data-entz-locked]");
    const unlockTab = await opened;
    expect(unlockTab.url()).toBe(new URL("unlock/index.html", worker.url()).href);
    await unlockTab.close();

    await worker.evaluate(
      (prf) => (globalThis as unknown as E2EHooks).__entzUnlockWithPrf(prf),
      E2E_PRF_HEX,
    );
    await expect(page.locator("#para [data-entz-plain]")).toHaveText(plaintext("ascii-title"));
    await expect(page.locator("[data-entz-locked]")).toHaveCount(0);
    expect(await status()).toMatchObject({ locked: false });

    await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzLockNow());
    expect(await status()).toMatchObject({ locked: true });
    await page.reload();
    await expect(page.locator("[data-entz-locked]")).toHaveCount(1);
    await expect(page.locator("[data-entz-plain]")).toHaveCount(0);
    await page.close();
  });

  test("locking strips rendered plaintext from an open page without a reload", async () => {
    const page = await openFixture();
    await expect(page.locator("#para [data-entz-plain]")).toHaveText(plaintext("ascii-title"));
    await expect(page.locator("[data-entz-overlay]")).toHaveCount(2);

    await worker.evaluate(() => (globalThis as unknown as E2EHooks).__entzLockNow());
    await expect(page.locator("[data-entz-plain]")).toHaveCount(0);
    await expect(page.locator("[data-entz-overlay]")).toHaveCount(0);
    await expect(page.locator("#para")).toContainText(token("ascii-title"));
    await expect(page.locator("[data-entz-locked]")).toHaveCount(1);

    await worker.evaluate(
      (prf) => (globalThis as unknown as E2EHooks).__entzUnlockWithPrf(prf),
      E2E_PRF_HEX,
    );
    await expect(page.locator("#para [data-entz-plain]")).toHaveText(plaintext("ascii-title"));
    await expect(page.locator("[data-entz-locked]")).toHaveCount(0);
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
