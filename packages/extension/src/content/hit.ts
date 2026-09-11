/** Slack a token's client rects get for hit-testing the pointer, in CSS pixels. */
export const HIT_SLACK_PX = 2;

/** The parts of a `DOMRect` hit-testing needs, so callers can pass plain boxes. */
export interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A token's client rects, ordered top to bottom, which is what {@link hits} assumes. */
export function sortedRects(range: Range): DOMRect[] {
  return [...range.getClientRects()].sort((a, b) => a.top - b.top);
}

/**
 * Whether (`x`, `y`) is over a token whose client `rects` are sorted by `top`. The rects cover
 * only the glyph boxes, so a wrapped token has a dead strip between its lines wherever the line
 * height exceeds the font; each line's hit area therefore reaches to the midpoint of the gap to
 * the line above and below. A line can be several rects wide when the token crosses inline
 * elements, so neighbours are the nearest rects that do not share the line.
 */
export function hits(rects: readonly Box[], x: number, y: number): boolean {
  for (const [i, rect] of rects.entries()) {
    if (x < rect.left - HIT_SLACK_PX || x > rect.right + HIT_SLACK_PX) continue;
    let above: Box | undefined;
    for (let j = i - 1; j >= 0; j--) {
      const candidate = rects[j] as Box;
      if (candidate.bottom <= rect.top) {
        above = candidate;
        break;
      }
    }
    let below: Box | undefined;
    for (let j = i + 1; j < rects.length; j++) {
      const candidate = rects[j] as Box;
      if (candidate.top >= rect.bottom) {
        below = candidate;
        break;
      }
    }
    const top = above === undefined ? rect.top - HIT_SLACK_PX : (above.bottom + rect.top) / 2;
    const bottom = below === undefined ? rect.bottom + HIT_SLACK_PX : (rect.bottom + below.top) / 2;
    if (y >= top && y <= bottom) return true;
  }
  return false;
}
