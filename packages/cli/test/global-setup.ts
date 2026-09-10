import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

export default function setup(): void {
  execFileSync("pnpm", ["--filter", "entziffer...", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}
