export const TAG_LAYER = "entz-tag";
export const FOREIGN_LAYER = "entz-foreign";
export const DIM_LAYER = "entz-dim";

const ACCENT_PROPERTY = "--entz-highlight-accent";
/**
 * Inside `::highlight()`, `currentColor` is the highlight's own colour (which Chromium resolves to
 * black), never the text's, so every colour a layer paints has to be spelled out.
 */
const FOREIGN_PROPERTY = "--entz-highlight-foreign";
/** How much of the text's own colour the ciphertext keeps while it is not under the cursor. */
const DIM_PERCENT = 65;
/** Distinct text colours that get their own dim layer before new ones fall back to the first. */
const MAX_DIM_LAYERS = 32;

const ROOT_RULES = `:root { ${ACCENT_PROPERTY}: #3b5bdb; ${FOREIGN_PROPERTY}: rgba(20, 24, 40, 0.55); }
@media (prefers-color-scheme: dark) { :root {
  ${ACCENT_PROPERTY}: #8ea2ff; ${FOREIGN_PROPERTY}: rgba(255, 255, 255, 0.6);
} }`;

const ACCENT = `var(${ACCENT_PROPERTY})`;

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
 * The `ENTZ1:` marker at the head of a token, styled as a small tag in one fixed accent; the
 * ciphertext after it is left exactly as the page renders it.
 */
export const tagLayer = (): HighlightLayer =>
  highlightLayer(
    TAG_LAYER,
    `background-color: color-mix(in srgb, ${ACCENT} 16%, transparent); color: ${ACCENT};
     -webkit-text-fill-color: ${ACCENT};`,
  );

/** The marker of a token this key cannot open: encrypted to someone else, or malformed. */
export const foreignLayer = (): HighlightLayer =>
  highlightLayer(
    FOREIGN_LAYER,
    `background-color: color-mix(in srgb, var(${FOREIGN_PROPERTY}) 25%, transparent);
     color: var(${FOREIGN_PROPERTY}); -webkit-text-fill-color: var(${FOREIGN_PROPERTY});`,
  );

const dimLayers = new Map<string, HighlightLayer>();

/**
 * The ciphertext body of a token not under the cursor, faded to {@link DIM_PERCENT} of `color`,
 * the computed colour of the text it sits in. One layer per distinct colour, since a highlight
 * cannot see the colour of the text it covers; the hovered token simply leaves its layer.
 */
export function dimLayer(color: string): HighlightLayer {
  const existing = dimLayers.get(color);
  if (existing !== undefined) return existing;
  if (dimLayers.size >= MAX_DIM_LAYERS) return dimLayers.values().next().value as HighlightLayer;
  const faded = `color-mix(in srgb, ${color} ${DIM_PERCENT}%, transparent)`;
  const layer = highlightLayer(
    `${DIM_LAYER}-${dimLayers.size}`,
    `color: ${faded}; -webkit-text-fill-color: ${faded};`,
  );
  dimLayers.set(color, layer);
  return layer;
}

/** Every layer created so far, for clearing or forgetting a range wherever it may be. */
export const allLayers = (): HighlightLayer[] => [...layers.values()];
