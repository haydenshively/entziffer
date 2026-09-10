import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  deps: { alwaysBundle: ["@entziffer/core"] },
  dts: false,
  clean: true,
  sourcemap: true,
  outExtensions: () => ({ js: ".js" }),
});
