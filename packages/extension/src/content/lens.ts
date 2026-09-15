const SVG_NS = "http://www.w3.org/2000/svg";
/** Skia downsamples any blur past sigma 4 on a viewport-aligned grid, which shows as pixel
 * stepping while the card moves; stacking passes under the threshold keeps it full-resolution.
 * https://source.chromium.org/chromium/chromium/src/+/main:third_party/skia/src/gpu/ganesh/GrBlurUtils.cpp */
const BODY_BLUR_PX = 4;
const RIM_BLUR_PX = 0.8;
const SATURATE = 1.8;
const MAX_SHIFT_PX = 22;
/** Width of the refracting rim as a fraction of the shorter side; the centre stays undistorted. */
const RIM_FRACTION = 0.3;
const RIM_MAX_PX = 16;
/** Red bends least and blue most, so the rim shows a faint colour fringe like real glass. */
const CHANNEL_DISPERSION = { R: 0.9, G: 1, B: 1.12 } as const;

const LENS_ID = "entz-lens";
const MAP_CACHE_LIMIT = 16;

type Channel = keyof typeof CHANNEL_DISPERSION;

/** An `ImageData`-shaped RGBA buffer, so the pixel maths runs outside a canvas. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const neutralProbe = new Uint8ClampedArray([128, 128, 0, 255]);
const NEUTRAL_WORD = new Uint32Array(neutralProbe.buffer)[0] as number;

/**
 * Paints the displacement map of a rounded rectangle: R/G encode the refraction per
 * https://www.w3.org/TR/filter-effects-1/#feDisplacementMapElement, and B carries the rim weight
 * that masks the sharp layer over the frosted body. The weight sits in B rather than alpha because
 * `feImage` premultiplies, and a low-alpha rim would destroy the R/G displacement precision.
 */
export function paintDisplacement(image: Pixels, radius: number): void {
  const { width, height, data } = image;
  const rim = Math.min(RIM_MAX_PX, Math.min(width, height) * RIM_FRACTION);
  const r = Math.min(radius, width / 2, height / 2);
  const hx = width / 2 - r;
  const hy = height / 2 - r;
  const band = Math.min(Math.ceil(Math.max(rim, r)), Math.ceil(width / 2), Math.ceil(height / 2));

  new Uint32Array(data.buffer, data.byteOffset, width * height).fill(NEUTRAL_WORD);

  const span = (y: number, from: number, to: number): void => {
    const py = y + 0.5 - height / 2;
    const qy = Math.abs(py) - hy;
    for (let x = from; x < to; x++) {
      const px = x + 0.5 - width / 2;
      const qx = Math.abs(px) - hx;
      let nx = 0;
      let ny = 0;
      let inside: number;
      if (qx > 0 && qy > 0) {
        const len = Math.sqrt(qx * qx + qy * qy);
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
      if (inside >= rim) continue;
      const d = 1 - Math.max(inside, 0) / rim;
      const t = d * d * d;
      const sx = -Math.sign(px) * nx * t;
      const sy = -Math.sign(py) * ny * t;
      const i = (y * width + x) * 4;
      data[i] = 128 + Math.round(sx * 127);
      data[i + 1] = 128 + Math.round(sy * 127);
      data[i + 2] = Math.round(d * Math.sqrt(d) * 255);
      data[i + 3] = 255;
    }
  };

  for (let y = 0; y < height; y++) {
    if (y < band || y >= height - band) {
      span(y, 0, width);
      continue;
    }
    span(y, 0, Math.min(band, width));
    span(y, Math.max(width - band, 0), width);
  }
}

const maps = new Map<string, string>();

function displacementMap(width: number, height: number, radius: number): string | null {
  const key = `${width}x${height}x${radius}`;
  const cached = maps.get(key);
  if (cached !== undefined) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  const image = ctx.createImageData(width, height);
  paintDisplacement(image, radius);
  ctx.putImageData(image, 0, 0);
  const href = canvas.toDataURL();
  maps.set(key, href);
  for (const oldest of maps.keys()) {
    if (maps.size <= MAP_CACHE_LIMIT) break;
    maps.delete(oldest);
  }
  return href;
}

export function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function blur(input: string, result: string, px: number): SVGElement {
  return el("feGaussianBlur", { in: input, stdDeviation: String(px), result });
}

function channelMatrix(channel: Channel): string {
  const rows = (["R", "G", "B"] as const).map((c, i) => {
    const row = [0, 0, 0, 0, 0];
    if (c === channel) row[i] = 1;
    return row.join(" ");
  });
  return `${rows.join(" ")} 0 0 0 1 0`;
}

function refract(channel: Channel, input: string): SVGElement[] {
  const displaced = `shift${channel}`;
  return [
    el("feDisplacementMap", {
      in: input,
      in2: "map",
      scale: String(MAX_SHIFT_PX * CHANNEL_DISPERSION[channel]),
      xChannelSelector: "R",
      yChannelSelector: "G",
      result: displaced,
    }),
    el("feColorMatrix", {
      in: displaced,
      type: "matrix",
      values: channelMatrix(channel),
      result: channel,
    }),
  ];
}

/**
 * Gives `target` a refracting backdrop: a frosted body under a sharp, per-channel-displaced rim,
 * as an SVG filter inlined in the same shadow root because `url(#id)` never resolves across a
 * shadow boundary. The map is rebuilt whenever the element's box changes. Returns a disposer.
 */
export function attachLens(root: ShadowRoot, target: HTMLElement): () => void {
  if (typeof ResizeObserver !== "function") return () => {};

  const svg = el("svg", { width: "0", height: "0", "aria-hidden": "true" });
  svg.style.cssText = "position:fixed;width:0;height:0;overflow:hidden";
  const filter = el("filter", {
    id: LENS_ID,
    x: "0",
    y: "0",
    width: "100%",
    height: "100%",
    "color-interpolation-filters": "sRGB",
  });
  const map = el("feImage", { preserveAspectRatio: "none", result: "map" });
  const rimWeight = el("feColorMatrix", {
    in: "map",
    type: "matrix",
    values: "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0",
    result: "rimWeight",
  });
  const redGreen = el("feBlend", { in: "R", in2: "G", mode: "screen", result: "RG" });
  const rim = el("feBlend", { in: "RG", in2: "B", mode: "screen", result: "rim" });
  const rimMasked = el("feComposite", {
    in: "rim",
    in2: "rimWeight",
    operator: "in",
    result: "rimMasked",
  });
  const layered = el("feComposite", {
    in: "rimMasked",
    in2: "body",
    operator: "over",
    result: "layered",
  });
  const saturate = el("feColorMatrix", {
    in: "layered",
    type: "saturate",
    values: String(SATURATE),
  });
  filter.append(
    blur("SourceGraphic", "body0", BODY_BLUR_PX),
    blur("body0", "body", BODY_BLUR_PX),
    blur("SourceGraphic", "sharp", RIM_BLUR_PX),
    map,
    rimWeight,
    ...refract("R", "sharp"),
    ...refract("G", "sharp"),
    ...refract("B", "sharp"),
    redGreen,
    rim,
    rimMasked,
    layered,
    saturate,
  );
  svg.appendChild(filter);
  root.appendChild(svg);
  target.style.backdropFilter = `url(#${LENS_ID})`;

  let lastW = 0;
  let lastH = 0;
  const observer = new ResizeObserver(() => {
    const width = Math.round(target.offsetWidth);
    const height = Math.round(target.offsetHeight);
    if (width === 0 || height === 0) return;
    if (width === lastW && height === lastH) return;
    lastW = width;
    lastH = height;
    const radius = Number.parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0;
    const href = displacementMap(width, height, radius);
    if (href === null) return;
    map.setAttribute("href", href);
  });
  observer.observe(target);

  return () => {
    observer.disconnect();
    svg.remove();
  };
}
