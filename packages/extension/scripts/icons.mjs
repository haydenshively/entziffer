import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = (p) => join(dirname(fileURLToPath(import.meta.url)), p);
const SIZES = [16, 48, 128];

const svg = readFileSync(here("../icons/icon.svg"), "utf8");
const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const size of SIZES) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="${src}">`,
  );
  await page.locator("img").evaluate((img) => img.decode());
  const png = await page.screenshot({
    omitBackground: true,
    clip: { x: 0, y: 0, width: size, height: size },
  });
  writeFileSync(here(`../icons/icon${size}.png`), png);
  console.log(`icons/icon${size}.png`);
}
await browser.close();
