import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The shipping build registers its content script at runtime, once an origin is enabled. The
 * E2E build instead declares the Playwright fixture server statically, so the fixture needs no
 * allowlist round trip; `file://` URLs never receive content scripts.
 */
const E2E_ORIGIN = "http://127.0.0.1/*";

const ICONS = ["icon16.png", "icon48.png", "icon128.png"];

function staticFiles(e2e) {
  return {
    name: "entz-static",
    generateBundle() {
      const raw = readFileSync(here("../manifest.json"), "utf8");
      let source = raw;
      if (e2e) {
        const manifest = JSON.parse(raw);
        manifest.name = "entziffer (e2e)";
        manifest.host_permissions = [E2E_ORIGIN];
        manifest.content_scripts = [
          { matches: [E2E_ORIGIN], js: ["content.js"], run_at: "document_idle" },
        ];
        source = `${JSON.stringify(manifest, null, 2)}\n`;
      }
      this.emitFile({ type: "asset", fileName: "manifest.json", source });
      for (const icon of ICONS) {
        this.emitFile({
          type: "asset",
          fileName: `icons/${icon}`,
          source: readFileSync(here(`../icons/${icon}`)),
        });
      }
    },
  };
}

function shared(outDir, e2e) {
  return {
    configFile: false,
    publicDir: false,
    define: { "import.meta.env.VITE_E2E": JSON.stringify(e2e ? "1" : "0") },
    build: {
      outDir: here(`../${outDir}`),
      target: "chrome133",
      minify: false,
      sourcemap: e2e,
    },
  };
}

function pagesConfig(outDir, e2e) {
  const config = shared(outDir, e2e);
  return {
    ...config,
    root: here("../src"),
    plugins: [staticFiles(e2e)],
    build: {
      ...config.build,
      emptyOutDir: true,
      modulePreload: false,
      rollupOptions: {
        input: {
          sw: here("../src/sw/index.ts"),
          options: here("../src/options/index.html"),
          popup: here("../src/popup/index.html"),
          unlock: here("../src/unlock/index.html"),
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  };
}

/** Content scripts are classic scripts: they cannot import ESM chunks, so this bundle is one IIFE. */
function contentConfig(outDir, e2e) {
  const config = shared(outDir, e2e);
  return {
    ...config,
    root: here(".."),
    build: {
      ...config.build,
      emptyOutDir: false,
      cssCodeSplit: false,
      lib: {
        entry: here("../src/content/index.ts"),
        formats: ["iife"],
        name: "entziffer",
        fileName: () => "content.js",
      },
      rollupOptions: { output: { inlineDynamicImports: true, extend: true } },
    },
  };
}

/** The real ProseMirror instance the E2E refuses edits against; E2E builds only. */
function fixtureEditorConfig(outDir) {
  const config = shared(outDir, true);
  return {
    ...config,
    root: here(".."),
    build: {
      ...config.build,
      emptyOutDir: false,
      lib: {
        entry: here("../test/e2e/fixture-editor.ts"),
        formats: ["iife"],
        name: "entzFixtureEditor",
        fileName: () => "fixture-editor.js",
      },
    },
  };
}

const e2e = process.argv.includes("--e2e");
const outDir = e2e ? "dist-e2e" : "dist";

await build(pagesConfig(outDir, e2e));
await build(contentConfig(outDir, e2e));
if (e2e) await build(fixtureEditorConfig(outDir));
