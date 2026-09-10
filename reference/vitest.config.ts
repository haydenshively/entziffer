import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "reference",
    environment: "node",
    include: ["*.test.ts"],
  },
});
