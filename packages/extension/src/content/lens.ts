const SVG_NS = "http://www.w3.org/2000/svg";
const BLUR_PX = 2;
const SATURATE = 1.6;
const MAX_SHIFT_PX = 28;
/** Width of the refracting rim as a fraction of the shorter side; the centre stays undistorted. */
const RIM_FRACTION = 0.32;
const RIM_MAX_PX = 16;

let nextId = 0;

/**
 * Builds the R/G displacement map for a rounded rectangle of `width`×`height`: neutral (128) in
 * the interior, ramping toward the outward normal inside the rim so the backdrop is pulled in at
 * the edges like a convex lens. Encoding per the SVG filter spec:
 * https://www.w3.org/TR/filter-effects-1/#feDisplacementMapElement
 */
function displacementMap(width: number, height: number, radius: number): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const rim = Math.min(RIM_MAX_PX, Math.min(width, height) * RIM_FRACTION);
  const r = Math.min(radius, width / 2, height / 2);
  const hx = width / 2 - r;
  const hy = height / 2 - r;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5 - width / 2;
      const py = y + 0.5 - height / 2;
      const qx = Math.abs(px) - hx;
      const qy = Math.abs(py) - hy;
      let nx = 0;
      let ny = 0;
      let inside: number;
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy);
        inside = r - len;
        nx = qx / len;
        ny = qy / len;
      } else if (qx > qy) {
        inside = r - qx;
        nx = 1;
      } else {
        inside = r - qy;
        ny = 1;
      }
      const t = inside < rim ? (1 - Math.max(inside, 0) / rim) ** 2 : 0;
      const sx = Math.sign(px) * nx * t;
      const sy = Math.sign(py) * ny * t;
      const i = (y * width + x) * 4;
      data[i] = 128 + Math.round(sx * 127);
      data[i + 1] = 128 + Math.round(sy * 127);
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * Gives `target` a refracting backdrop: an SVG filter (blur → saturate → displacement) inlined in
 * the same shadow root, because `url(#id)` never resolves across a shadow boundary. Chromium is the
 * only engine that honours SVG filters in `backdrop-filter`
 * (https://github.com/w3c/svgwg/issues/1142); elsewhere the stylesheet's plain blur stays.
 * The map is rebuilt whenever the element's box changes. Returns a disposer.
 */
export function attachLens(root: ShadowRoot, target: HTMLElement): () => void {
  if (typeof ResizeObserver !== "function") return () => {};
  const id = `entz-lens-${nextId++}`;

  const svg = el("svg", { width: "0", height: "0", "aria-hidden": "true" });
  svg.style.cssText = "position:fixed;width:0;height:0;overflow:hidden";
  const filter = el("filter", {
    id,
    x: "0",
    y: "0",
    width: "100%",
    height: "100%",
    "color-interpolation-filters": "sRGB",
  });
  const blur = el("feGaussianBlur", {
    in: "SourceGraphic",
    stdDeviation: String(BLUR_PX),
    result: "blurred",
  });
  const saturate = el("feColorMatrix", {
    in: "blurred",
    type: "saturate",
    values: String(SATURATE),
    result: "saturated",
  });
  const map = el("feImage", { preserveAspectRatio: "none", result: "map" });
  const displace = el("feDisplacementMap", {
    in: "saturated",
    in2: "map",
    scale: String(MAX_SHIFT_PX),
    xChannelSelector: "R",
    yChannelSelector: "G",
  });
  filter.append(blur, saturate, map, displace);
  svg.appendChild(filter);
  root.appendChild(svg);

  let lastKey = "";
  const observer = new ResizeObserver(() => {
    const width = Math.round(target.offsetWidth);
    const height = Math.round(target.offsetHeight);
    if (width === 0 || height === 0) return;
    const key = `${width}x${height}`;
    if (key === lastKey) return;
    lastKey = key;
    const radius = Number.parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0;
    const href = displacementMap(width, height, radius);
    if (href === null) return;
    map.setAttribute("href", href);
    target.style.backdropFilter = `url(#${id})`;
  });
  observer.observe(target);

  return () => {
    observer.disconnect();
    svg.remove();
  };
}
