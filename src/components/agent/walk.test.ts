import { describe, expect, it } from 'vitest';
import { stepWalk, type Walk } from './walk';

/** A small seeded random generator, so every run of the test walks the same walk. */
const seeded = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

/** Walks for `minutes` of pretend time at 60 frames a second and says what happened each frame. */
function simulate(min: number, max: number, seed: number, minutes = 30, start?: Partial<Walk>) {
  const rand = seeded(seed);
  const s: Walk = { x: min + (max - min) * 0.55, dir: 1, mode: 'idle', until: 1400, ...start };
  const frames: { t: number; x: number; dir: number; mode: string }[] = [];
  const dt = 1 / 60;
  for (let t = 0; t < minutes * 60_000; t += dt * 1000) {
    stepWalk(s, t, dt, min, max, rand);
    frames.push({ t, x: s.x, dir: s.dir, mode: s.mode });
  }
  return frames;
}

describe('Woshi walking along the footer', () => {
  it('never faces the edge he is standing at (that flicker was the glitch when he turned)', () => {
    for (const [min, max, seed] of [[12, 700, 1], [12, 700, 2], [284, 1180, 3], [12, 307, 4], [12, 300, 5]] as const) {
      const bad = simulate(min, max, seed).filter((f) => (f.x >= max && f.dir === 1) || (f.x <= min && f.dir === -1));
      expect(bad).toEqual([]);
    }
  });

  it('turns at most once per edge: two turns are never closer than a second together', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const frames = simulate(12, 700, seed);
      let last = -Infinity;
      for (let i = 1; i < frames.length; i++) {
        if (frames[i].dir !== frames[i - 1].dir) {
          expect(frames[i].t - last).toBeGreaterThan(1000);
          last = frames[i].t;
        }
      }
    }
  });

  it('really reaches both ends, and stays inside them', () => {
    const frames = simulate(12, 700, 7);
    expect(Math.min(...frames.map((f) => f.x))).toBe(12);
    expect(Math.max(...frames.map((f) => f.x))).toBe(700);
  });

  it('after reaching the right edge he turns round to walk back left, not into the edge again', () => {
    const frames = simulate(12, 700, 8);
    for (let i = 1; i < frames.length; i++) {
      if (frames[i - 1].x < 700 && frames[i].x === 700) {
        expect(frames[i].dir).toBe(-1);
        expect(frames[i].mode).toBe('idle');
        const walking = frames.slice(i).find((f) => f.mode === 'walk');
        expect(walking?.dir).toBe(-1);
        expect(walking?.x).toBe(700);
      }
    }
  });

  it('keeps a narrow screen from making him dither', () => {
    const frames = simulate(12, 60, 9, 5);
    expect(frames.every((f) => f.x >= 12 && f.x <= 60)).toBe(true);
    expect(new Set(frames.map((f) => f.dir)).size).toBe(1);
  });

  it('picks himself back inside if the screen shrinks around him', () => {
    const frames = simulate(12, 500, 10, 1, { x: 650, mode: 'walk', dir: 1, until: 1e9 });
    expect(frames[0].x).toBe(500);
    expect(frames[0].dir).toBe(-1);
  });
});
