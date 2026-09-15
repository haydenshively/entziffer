import { describe, expect, it } from "vitest";
import { type Pixels, paintDisplacement } from "../src/content/lens.js";

const RIM_FRACTION = 0.3;
const RIM_MAX_PX = 16;

/** The map as it was painted before the bands: every pixel through the full per-pixel maths. */
function everyPixel(width: number, height: number, radius: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
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
      const i = (y * width + x) * 4;
      data[i] = 128 + Math.round(-Math.sign(px) * nx * t * 127);
      data[i + 1] = 128 + Math.round(-Math.sign(py) * ny * t * 127);
      data[i + 2] = Math.round(depth ** 1.5 * 255);
      data[i + 3] = 255;
    }
  }
  return data;
}

function painted(width: number, height: number, radius: number): Pixels {
  const image = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  paintDisplacement(image, radius);
  return image;
}

const at = (image: Pixels, x: number, y: number): number[] => {
  const i = (y * image.width + x) * 4;
  return [...image.data.slice(i, i + 4)];
};

const sizes: [number, number, number][] = [
  [200, 80, 18],
  [40, 40, 18],
  [17, 9, 18],
  [720, 120, 0],
  [300, 41, 7],
  [1, 1, 3],
  [64, 300, 18],
];

describe("paintDisplacement", () => {
  it("leaves the interior neutral", () => {
    const image = painted(200, 80, 18);
    expect(at(image, 100, 40)).toEqual([128, 128, 0, 255]);
    expect(at(image, 60, 40)).toEqual([128, 128, 0, 255]);
  });

  it("ramps the rim weight up toward the edge", () => {
    const image = painted(200, 80, 18);
    const weights = [0, 2, 5, 8, 12, 15, 20].map((x) => at(image, x, 40)[2] as number);
    expect(weights[0]).toBeGreaterThan(0);
    expect(weights.at(-1)).toBe(0);
    for (const [i, w] of weights.entries()) {
      if (i > 0) expect(w).toBeLessThanOrEqual(weights[i - 1] as number);
    }
  });

  it("paints what the full per-pixel loop painted", () => {
    for (const [width, height, radius] of sizes) {
      expect({
        size: [width, height, radius],
        data: [...painted(width, height, radius).data],
      }).toEqual({ size: [width, height, radius], data: [...everyPixel(width, height, radius)] });
    }
  });
});
