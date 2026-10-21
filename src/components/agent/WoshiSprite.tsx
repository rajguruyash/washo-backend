import { useReducedMotion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '../../lib/cn';
import { BODY, LEGS, PALETTE } from './woshiPixels';

/** The pixels of each walking frame as rectangles: [x, y, colour]. The second frame sits one pixel higher (the bob of a step). */
const FRAMES = [0, 1].map((f) => {
  const out: [number, number, string][] = [];
  [...BODY, ...LEGS[f]].forEach((row, y) => [...row].forEach((ch, x) => { if (PALETTE[ch]) out.push([x, y + (f ? 0 : 1), PALETTE[ch]]); }));
  return out;
});

/**
 * Woshi, drawn in pixels. `crop` shows the head, shell and body (for the round button and the chat header); without it the whole sprite is drawn, tail included. It takes a step every
 * quarter of a second and, when `stroll` is on, wanders a few pixels either way and turns round (not at all for someone who asked their device for less motion).
 * Pass a width that is a whole number of pixels per sprite pixel (22 columns x 3 = 66) and the pixels stay perfectly square.
 */
export function WoshiSprite({ className, crop = true, stroll = false }: { className?: string; crop?: boolean; stroll?: boolean }) {
  const reduce = useReducedMotion();
  const [frame, setFrame] = useState(0);
  const [side, setSide] = useState(1);
  useEffect(() => {
    if (reduce) return;
    const step = setInterval(() => setFrame((f) => 1 - f), 260);
    const turn = stroll ? setInterval(() => setSide((s) => -s), 1700) : undefined;
    return () => { clearInterval(step); if (turn) clearInterval(turn); };
  }, [reduce, stroll]);
  const rects = useMemo(() => FRAMES[reduce ? 0 : frame], [frame, reduce]);
  return (
    <svg
      viewBox={crop ? '8 0 22 19' : '-1 -1 32 21'}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Woshi"
      className={cn('block', className)}
      style={stroll && !reduce ? { transform: `translateX(${side * 3}px) scaleX(${side})`, transition: 'transform 1.6s linear' } : undefined}
    >
      {rects.map(([x, y, fill]) => <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} />)}
    </svg>
  );
}
