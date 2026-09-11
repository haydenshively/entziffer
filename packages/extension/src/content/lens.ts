const SVG_NS = "http://www.w3.org/2000/svg";
/** Skia downsamples any blur past sigma 4 on a viewport-aligned grid, which shows as pixel
 * stepping while the card moves; stacking passes under the threshold keeps it full-resolution.
 * https://source.chromium.org/chromium/chromium/src/+/main:third_party/skia/src/gpu/ganesh/GrBlurUtils.cpp */
const BODY_BLUR_PX = 4;
const BODY_BLUR_PASSES = 2;
const RIM_BLUR_PX = 0.8;
const SATURATE = 1.8;
const MAX_SHIFT_PX = 22;
/** Width of the refracting rim as a fraction of the shorter side; the centre stays undistorted. */
const RIM_FRACTION = 0.3;
const RIM_MAX_PX = 16;
/** Red bends least and blue most, so the rim shows a faint colour fringe like real glass. */
const CHANNEL_DISPERSION = { R: 0.9, G: 1, B: 1.12 } as const;

type Channel = keyof typeof CHANNEL_DISPERSION;

let nextId = 0;

/**
 * Builds the displacement map for a rounded rectangle of `width`×`height`: R/G neutral (128) in
 * the interior, ramping toward the centre inside the rim so the backdrop is stretched across
 * the edges like the bevel of a thick glass slab; B carries the rim weight, which masks the sharp
 * refracted layer over the frosted body. R/G encoding per the SVG filter spec:
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
      const depth = inside < rim ? 1 - Math.max(inside, 0) / rim : 0;
      const t = depth ** 3;
      const sx = -Math.sign(px) * nx * t;
      const sy = -Math.sign(py) * ny * t;
      const i = (y * width + x) * 4;
      data[i] = 128 + Math.round(sx * 127);
      data[i + 1] = 128 + Math.round(sy * 127);
      data[i + 2] = Math.round(depth ** 1.5 * 255);
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
  const body: SVGElement[] = [];
  for (let pass = 0; pass < BODY_BLUR_PASSES; pass++) {
    body.push(
      el("feGaussianBlur", {
        in: pass === 0 ? "SourceGraphic" : `body${pass - 1}`,
        stdDeviation: String(BODY_BLUR_PX),
        result: pass === BODY_BLUR_PASSES - 1 ? "body" : `body${pass}`,
      }),
    );
  }
  const sharp = el("feGaussianBlur", {
    in: "SourceGraphic",
    stdDeviation: String(RIM_BLUR_PX),
    result: "sharp",
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
    ...body,
    sharp,
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
