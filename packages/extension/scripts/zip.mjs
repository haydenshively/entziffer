import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = `${root}dist`;
if (!existsSync(`${dist}/manifest.json`)) {
  console.error("dist/ is missing or unbuilt; run `pnpm build` first");
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(`${dist}/manifest.json`, "utf8"));
const name = `entziffer-extension-${version}.zip`;
rmSync(`${root}${name}`, { force: true });

const r = spawnSync("zip", ["-r", "-X", "-q", `../${name}`, "."], { cwd: dist, stdio: "inherit" });
if (r.error !== undefined || r.status !== 0) {
  console.error("`zip` is required (preinstalled on macOS and GitHub-hosted Linux runners)");
  process.exit(1);
}
console.log(name);
