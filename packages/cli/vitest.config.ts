import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "cli",
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 20_000,
  },
});
