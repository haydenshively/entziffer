import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts", testing: "src/testing.ts" },
  format: ["esm"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: true,
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
