export const MASK_LAYER = "entz-mask";
export const FOCUS_LAYER = "entz-focus";
export const DIM_LAYER = "entz-dim";
export const FOREIGN_LAYER = "entz-foreign";

const ACCENT_PROPERTY = "--entz-highlight-accent";
/** Inside `::highlight()`, `currentColor` is the highlight's own (transparent) colour, so grey is explicit. */
const FOREIGN_PROPERTY = "--entz-highlight-foreign";
const ACCENT_LIGHT = "#3b5bdb";
const ACCENT_DARK = "#8ea2ff";
const FOREIGN_LIGHT = "rgba(20, 24, 40, 0.22)";
const FOREIGN_DARK = "rgba(255, 255, 255, 0.24)";

const ROOT_RULES = `:root { ${ACCENT_PROPERTY}: ${ACCENT_LIGHT}; ${FOREIGN_PROPERTY}: ${FOREIGN_LIGHT}; }
@media (prefers-color-scheme: dark) { :root { ${ACCENT_PROPERTY}: ${ACCENT_DARK}; ${FOREIGN_PROPERTY}: ${FOREIGN_DARK}; } }`;

const ACCENT = `var(${ACCENT_PROPERTY})`;

/**
 * Hides the ciphertext's glyphs and fills exactly the space they occupy, like a censor's bar, so
 * the token reads as redacted without any change to the text, its layout, or what copy yields.
 * Overlapping highlights each paint their own fill, so a range belongs to one layer at a time.
 */
const mask = (fill: string): string =>
  `color: transparent; -webkit-text-fill-color: transparent; background-color: ${fill};`;

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
 * `::highlight()` rule and may read {@link ACCENT_PROPERTY}, which follows the page's colour
 * scheme. Ranges are live, so a layer follows the page's own edits; engines without the API get a
 * layer that does nothing. Calling this twice with the same `name` returns the same layer.
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

/** Every token the pane can show, while nothing is being pointed at. */
export const maskLayer = (): HighlightLayer => highlightLayer(MASK_LAYER, mask(tint(45)));

/** The one token the pane and page agree on. */
export const focusLayer = (): HighlightLayer =>
  highlightLayer(
    FOCUS_LAYER,
    `${mask(tint(80))}
     text-decoration: underline solid ${ACCENT}; text-decoration-thickness: 2px;
     text-underline-offset: 3px;`,
  );

/** Every other token while {@link focusLayer} holds one. */
export const dimLayer = (): HighlightLayer => highlightLayer(DIM_LAYER, mask(tint(18)));

/** Tokens this key cannot open: encrypted to someone else, or malformed. */
export const foreignLayer = (): HighlightLayer =>
  highlightLayer(FOREIGN_LAYER, mask(`var(${FOREIGN_PROPERTY})`));
