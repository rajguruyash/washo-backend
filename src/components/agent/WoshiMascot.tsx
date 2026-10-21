import { useReducedMotion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { WoshiSprite } from './WoshiSprite';

/**
 * Woshi's picture (public/woshi.png: a transparent PNG). It takes a little hop every quarter of a second and, with `stroll`, wanders a few pixels either way and turns round (not at
 * all for someone who asked their device for less motion). If the picture is missing the pixel buddy drawn in code (WoshiSprite) stands in, so the chat never shows a broken image.
 */
export function WoshiMascot({ className, stroll = false, spriteClass = 'w-[44px]' }: { className?: string; stroll?: boolean; spriteClass?: string }) {
  const reduce = useReducedMotion();
  const [missing, setMissing] = useState(false);
  const [up, setUp] = useState(false);
  const [side, setSide] = useState(1);
  useEffect(() => {
    if (reduce) return;
    const hop = setInterval(() => setUp((u) => !u), 260);
    const turn = stroll ? setInterval(() => setSide((s) => -s), 1700) : undefined;
    return () => { clearInterval(hop); if (turn) clearInterval(turn); };
  }, [reduce, stroll]);
  if (missing) return <WoshiSprite stroll={stroll} className={spriteClass} />;
  const walking = stroll && !reduce;
  return (
    <span className="block" style={walking ? { transform: `translateX(${side * 3}px) scaleX(${side})`, transition: 'transform 1.6s linear' } : undefined}>
      <img
        src="/woshi.png"
        alt="Woshi"
        draggable={false}
        onError={() => setMissing(true)}
        className={cn('block select-none', className)}
        style={!reduce && up ? { transform: 'translateY(-2px)' } : undefined}
      />
    </span>
  );
}
