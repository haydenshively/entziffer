export const TAG_LAYER = "entz-tag";
export const ACTIVE_LAYER = "entz-tag-active";
export const DIM_LAYER = "entz-tag-dim";
export const FOREIGN_LAYER = "entz-tag-foreign";

const ACCENT_PROPERTY = "--entz-highlight-accent";
const ON_ACCENT_PROPERTY = "--entz-highlight-on-accent";
/** Inside `::highlight()`, `currentColor` is the highlight's own colour, so grey is explicit. */
const FOREIGN_PROPERTY = "--entz-highlight-foreign";

const ROOT_RULES = `:root {
  ${ACCENT_PROPERTY}: #3b5bdb; ${ON_ACCENT_PROPERTY}: #fff; ${FOREIGN_PROPERTY}: rgba(20, 24, 40, 0.55);
}
@media (prefers-color-scheme: dark) { :root {
  ${ACCENT_PROPERTY}: #8ea2ff; ${ON_ACCENT_PROPERTY}: #12141a; ${FOREIGN_PROPERTY}: rgba(255, 255, 255, 0.6);
} }`;

const ACCENT = `var(${ACCENT_PROPERTY})`;
const tint = (percent: number): string => `color-mix(in srgb, ${ACCENT} ${percent}%, transparent)`;

export interface HighlightLayer {
  add(range: Range): void;
  delete(range: Range): void;
  clear(): void;
}

const layers = new Map<string, HighlightLayer>();

let sheet: CSSStyleSheet | null = null;

function styleSheet(): CSSStyleSheet {
  if (sheet === null) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(ROOT_RULES);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }
  return sheet;
}

/**
 * Styles arbitrary text ranges without touching the DOM, through a registered CSS Custom Highlight
 * (https://drafts.csswg.org/css-highlight-api-1/). `css` is the declaration body of the layer's
 * `::highlight()` rule. Ranges are live, so a layer follows the page's own edits; engines without
 * the API get a layer that does nothing. Calling this twice with the same `name` returns the same
 * layer. Overlapping highlights each paint their own fill, so a range belongs to one layer at a time.
 */
export function highlightLayer(name: string, css: string): HighlightLayer {
  const existing = layers.get(name);
  if (existing !== undefined) return existing;

  let highlight: Highlight | null = null;
  const ensure = (): Highlight | null => {
    if (highlight !== null) return highlight;
    if (typeof Highlight !== "function" || typeof CSS?.highlights?.set !== "function") return null;
    highlight = new Highlight();
    CSS.highlights.set(name, highlight);
    const rules = styleSheet();
    rules.insertRule(`::highlight(${name}) { ${css} }`, rules.cssRules.length);
    return highlight;
  };

  const layer: HighlightLayer = {
    add(range) {
      ensure()?.add(range);
    },
    delete(range) {
      highlight?.delete(range);
    },
    clear() {
      highlight?.clear();
    },
  };
  layers.set(name, layer);
  return layer;
}

/**
 * The `ENTZ1:` marker at the head of every token, styled as a small tag; the ciphertext after it
 * is left exactly as the page renders it.
 */
export const tagLayer = (): HighlightLayer =>
  highlightLayer(TAG_LAYER, `background-color: ${tint(16)}; color: ${ACCENT};`);

/** The one token the pane and page agree on. */
export const activeLayer = (): HighlightLayer =>
  highlightLayer(
    ACTIVE_LAYER,
    `background-color: ${ACCENT}; color: var(${ON_ACCENT_PROPERTY});
     -webkit-text-fill-color: var(${ON_ACCENT_PROPERTY});`,
  );

/** Every other token while {@link activeLayer} holds one. */
export const dimLayer = (): HighlightLayer =>
  highlightLayer(
    DIM_LAYER,
    `background-color: ${tint(8)}; color: ${tint(45)}; -webkit-text-fill-color: ${tint(45)};`,
  );

/** Tokens this key cannot open: encrypted to someone else, or malformed. */
export const foreignLayer = (): HighlightLayer =>
  highlightLayer(
    FOREIGN_LAYER,
    `background-color: color-mix(in srgb, var(${FOREIGN_PROPERTY}) 25%, transparent);
     color: var(${FOREIGN_PROPERTY}); -webkit-text-fill-color: var(${FOREIGN_PROPERTY});`,
  );
