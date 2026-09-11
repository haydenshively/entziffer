const OPEN_MS = 260;
const CLOSE_MS = 140;
const DROPLET_PX = 24;
const TEXT_DELAY_MS = 110;
const TEXT_MS = 180;
const OPEN_EASING = "cubic-bezier(0.2, 0.9, 0.2, 1)";
const CLOSE_EASING = "cubic-bezier(0.4, 0, 0.8, 0.4)";

const STIFFNESS = 420;
const DAMPING_RATIO = 0.9;
const MAX_STRETCH = 0.03;
/** Stretch per px/s of speed, so a brisk 180 px/s drag reaches the cap. */
const STRETCH_PER_SPEED = MAX_STRETCH / 180;
const MAX_STEP_S = 0.032;
const SETTLED = 0.05;

/** The card corner nearest the cursor, where the droplet the card grows from sits. */
export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface Motion {
  /** Grows the card, already laid out at full size, out of a droplet at `corner`. */
  open(corner: Corner): void;
  /** Collapses the card back into its droplet, then calls `done`; synchronously when nothing animates. */
  close(done: () => void): void;
  /** The card's target moved by (`dx`, `dy`); the card stays put and springs after it. */
  shift(dx: number, dy: number): void;
  /** Drops every animation and lag so the card sits exactly on its target. */
  reset(): void;
}

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function animates(card: HTMLElement): boolean {
  return typeof card.animate === "function" && !reducedMotion();
}

interface Droplet {
  transform: string;
  borderRadius: string;
  transformOrigin: string;
}

function droplet(corner: Corner, glass: HTMLElement): Droplet {
  const [vertical, horizontal] = corner.split("-");
  return {
    transform: `scale(${DROPLET_PX / (glass.offsetWidth || 1)}, ${DROPLET_PX / (glass.offsetHeight || 1)})`,
    borderRadius: "50%",
    transformOrigin: `${horizontal} ${vertical}`,
  };
}

function settled(glass: HTMLElement): Omit<Droplet, "transformOrigin"> {
  return {
    transform: "scale(1, 1)",
    borderRadius: getComputedStyle(glass).borderTopLeftRadius || "0px",
  };
}

/**
 * Animates `card`, the shell that springs after the cursor, around `glass`, the surface that
 * morphs. The morph is a scale rather than a clip: Chromium never masks `backdrop-filter` output
 * with an animated `clip-path`, on the element or any ancestor.
 */
export function createMotion(card: HTMLElement, glass: HTMLElement): Motion {
  let corner: Corner = "bottom-left";
  let lagX = 0;
  let lagY = 0;
  let velX = 0;
  let velY = 0;
  let last = 0;
  let frame = 0;

  const cancelAnimations = (): void => {
    for (const a of card.getAnimations?.({ subtree: true }) ?? []) a.cancel();
  };

  const stopSpring = (): void => {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    lagX = lagY = velX = velY = 0;
    card.style.transform = "";
  };

  const step = (now: number): void => {
    const dt = Math.min(MAX_STEP_S, (now - last) / 1000 || 0);
    last = now;
    const damping = 2 * DAMPING_RATIO * Math.sqrt(STIFFNESS);
    velX += (-STIFFNESS * lagX - damping * velX) * dt;
    velY += (-STIFFNESS * lagY - damping * velY) * dt;
    lagX += velX * dt;
    lagY += velY * dt;
    const speed = Math.hypot(velX, velY);
    if (Math.abs(lagX) < SETTLED && Math.abs(lagY) < SETTLED && speed < SETTLED) {
      stopSpring();
      return;
    }
    const stretch = Math.min(MAX_STRETCH, speed * STRETCH_PER_SPEED);
    const sx = 1 + (stretch * Math.abs(velX)) / (speed || 1);
    const sy = 1 + (stretch * Math.abs(velY)) / (speed || 1);
    card.style.transform = `translate(${lagX}px, ${lagY}px) scale(${sx}, ${sy})`;
    frame = requestAnimationFrame(step);
  };

  const spring = (): void => {
    if (typeof requestAnimationFrame !== "function" || reducedMotion()) {
      stopSpring();
      return;
    }
    if (frame === 0) {
      last = performance.now();
      frame = requestAnimationFrame(step);
    }
  };

  return {
    open(at) {
      corner = at;
      cancelAnimations();
      stopSpring();
      if (!animates(card)) return;
      const { transformOrigin, ...from } = droplet(corner, glass);
      glass.style.transformOrigin = transformOrigin;
      glass.animate([from, settled(glass)], { duration: OPEN_MS, easing: OPEN_EASING });
      const content = glass.firstElementChild;
      if (content instanceof HTMLElement) {
        content.animate([{ opacity: 0 }, { opacity: 1 }], {
          delay: TEXT_DELAY_MS,
          duration: TEXT_MS,
          fill: "backwards",
          easing: "ease-out",
        });
      }
    },
    close(done) {
      cancelAnimations();
      stopSpring();
      if (!animates(card) || card.hidden) {
        done();
        return;
      }
      const { transformOrigin, ...to } = droplet(corner, glass);
      glass.style.transformOrigin = transformOrigin;
      const collapse = glass.animate([settled(glass), to], {
        duration: CLOSE_MS,
        easing: CLOSE_EASING,
        fill: "forwards",
      });
      const content = glass.firstElementChild;
      if (content instanceof HTMLElement) {
        content.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: CLOSE_MS / 2,
          fill: "forwards",
        });
      }
      collapse.finished.then(done, () => {});
    },
    shift(dx, dy) {
      if (dx === 0 && dy === 0) return;
      lagX -= dx;
      lagY -= dy;
      spring();
    },
    reset() {
      cancelAnimations();
      stopSpring();
    },
  };
}
