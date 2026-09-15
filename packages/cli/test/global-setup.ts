import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCES = ["packages/core/src", "packages/cli/src"];
const ARTIFACTS = ["packages/core/dist/index.js", "packages/cli/dist/index.js"];

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

function isUpToDate(): boolean {
  try {
    const built = Math.min(...ARTIFACTS.map((p) => statSync(join(repoRoot, p)).mtimeMs));
    return built > Math.max(...SOURCES.map((p) => newestMtime(join(repoRoot, p))));
  } catch {
    return false;
  }
}

export default function setup(): void {
  if (isUpToDate()) return;
  execFileSync("pnpm", ["--filter", "entziffer...", "build"], { cwd: repoRoot, stdio: "inherit" });
}
