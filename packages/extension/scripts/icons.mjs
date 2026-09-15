import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = (p) => join(dirname(fileURLToPath(import.meta.url)), p);
const SOURCES = { 16: "icon-small.svg", 48: "icon.svg", 128: "icon.svg" };

const dataUri = (file) =>
  `data:image/svg+xml;base64,${Buffer.from(readFileSync(here(`../icons/${file}`))).toString("base64")}`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [size, file] of Object.entries(SOURCES).map(([s, f]) => [Number(s), f])) {
  const src = dataUri(file);
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
