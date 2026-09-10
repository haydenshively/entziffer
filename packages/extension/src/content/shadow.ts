import styles from "./styles.css?inline";

export const HOST_ATTR = "data-entz-host";

let sheet: CSSStyleSheet | null = null;

function styleSheet(): CSSStyleSheet {
  if (sheet === null) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(styles);
  }
  return sheet;
}

/** Creates a `body`-level host whose shadow root carries the extension's styles only. */
export function createShadowHost(): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  host.style.cssText = "all:initial;position:absolute;top:0;left:0;width:0;height:0";
  const root = host.attachShadow({ mode: "open" });
  root.adoptedStyleSheets = [styleSheet()];
  document.body.appendChild(host);
  return { host, root };
}
