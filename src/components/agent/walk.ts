export const SPEED = 38; // pixels a second

/** How much room he needs ahead of him before he will start walking that way. */
const ROOM = 40;

export interface Walk {
  x: number;
  /** 1 = facing and walking right, -1 = left. */
  dir: 1 | -1;
  mode: 'walk' | 'idle';
  /** When (in the animation clock's milliseconds) the current walk or pause ends. */
  until: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * One frame of Woshi's wandering, between `min` and `max` (the two ends of the footer). He walks, stops for a moment, sometimes changes his mind and turns round, and carries on.
 * At an end of the footer he stops and turns to face back the way he came, once. He never starts a walk towards the end he is standing at: that used to make him turn to face the wall for a
 * single frame and flip straight back, which showed as a glitch each time he reached the edge. `rand` is Math.random (a seeded one in the tests).
 */
export function stepWalk(s: Walk, t: number, dt: number, min: number, max: number, rand: () => number): void {
  if (s.mode === 'walk') {
    s.x += s.dir * SPEED * dt;
    if (s.x >= max || s.x <= min) {
      s.dir = s.x >= max ? -1 : 1;
      s.mode = 'idle';
      s.until = t + 1000 + rand() * 1400;
    } else if (t > s.until) {
      s.mode = 'idle';
      s.until = t + 900 + rand() * 1800;
    }
  } else if (t > s.until) {
    if (max - min < ROOM * 2) {
      s.until = t + 1000; // nowhere worth walking to
    } else {
      s.mode = 'walk';
      s.until = t + 2600 + rand() * 3600;
      if (rand() < 0.35) s.dir = s.dir === 1 ? -1 : 1;
      const room = s.dir === 1 ? max - s.x : s.x - min;
      if (room < ROOM) s.dir = s.dir === 1 ? -1 : 1; // never towards a wall that is right there
    }
  }
  s.x = clamp(s.x, min, max);
}
