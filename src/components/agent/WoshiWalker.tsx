import { useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { WoshiSprite } from './WoshiSprite';

const W = 66; // the figure's width in pixels (the picture is 256 x 224)
const H = 58;
const MARGIN = 12;
const SPEED = 38; // pixels a second

/**
 * Woshi walking along the footer, with nothing around him: no circle, no ring. He ambles one way, stops for a moment, sometimes turns round, and carries on, and a speech box (a rectangle with an arrow
 * pointing down at him) follows (and stays on the screen when he walks to an edge). Tapping him or the bubble opens the chat. On a phone he walks on top of the bottom tab bar; on a computer
 * along the bottom of the page, beside the side menu. The note is there the moment he appears; with nobody touching it for 6 seconds it folds away into him for 3, then pops back up, over and over. For someone who asked their device for less motion he simply stands in the corner.
 * The movement is written straight to the elements once per frame (no React renders), so it costs next to nothing.
 */
const QUIET_MS = 6000; // with nobody touching the note for this long it folds away...
const AWAY_MS = 3000; // ...for this long, then pops back up, and so on
const OFF = 'woshi_note_off';
const readOff = (): boolean => {
  try { return sessionStorage.getItem(OFF) === '1'; } catch { return false; }
};

export function WoshiWalker({ message, onOpen }: { message: string; onOpen: () => void }) {
  const reduce = useReducedMotion();
  const [missing, setMissing] = useState(false);
  const [shown, setShown] = useState(true); // the note is there at once
  const [off, setOff] = useState(readOff); // the little cross puts it away for this visit
  const touched = useRef(0); // the last time anyone touched, hovered or focused the note
  const box = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const walker = useRef<HTMLDivElement>(null);
  const flip = useRef<HTMLSpanElement>(null);
  const hop = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const arrow = useRef<HTMLSpanElement>(null);

  // the note's cycle: shown at once; after QUIET_MS without activity it folds away for AWAY_MS, then pops back up, for as long as nobody touches it
  useEffect(() => {
    if (off) return;
    let timer: ReturnType<typeof setTimeout>;
    const watch = () => {
      const wait = QUIET_MS - (Date.now() - touched.current);
      if (wait > 60) {
        timer = setTimeout(watch, wait);
        return;
      }
      setShown(false);
      timer = setTimeout(() => {
        touched.current = Date.now();
        setShown(true);
        timer = setTimeout(watch, QUIET_MS);
      }, AWAY_MS);
    };
    touched.current = Date.now();
    timer = setTimeout(watch, QUIET_MS);
    return () => clearTimeout(timer);
  }, [off]);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let x = 0;
    let dir = 1;
    let mode: 'walk' | 'idle' = 'idle';
    let until = last + 1400;
    let placed = false;
    let groundAt = -1000;
    const bounds = () => {
      const vw = window.innerWidth;
      const min = (vw >= 1024 ? 272 : 0) + MARGIN; // beside the side menu on a computer
      return { vw, min, max: Math.max(min, vw - W - MARGIN) };
    };
    // the line he walks on: the top of the phone's tab bar when there is one, else the bottom of the page
    const ground = () => {
      for (const nav of document.querySelectorAll<HTMLElement>('nav[aria-label="App"]')) {
        if (getComputedStyle(nav).position !== 'fixed') continue; // the side menu is not the footer
        const r = nav.getBoundingClientRect();
        if (r.height > 0) return Math.max(0, window.innerHeight - r.top);
      }
      return 0;
    };
    const tick = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const { vw, min, max } = bounds();
      if (!placed) {
        x = reduce ? max : min + (max - min) * 0.55;
        placed = true;
      }
      if (t - groundAt > 400 && strip.current) {
        strip.current.style.bottom = `${ground()}px`;
        groundAt = t;
      }
      if (!reduce) {
        if (mode === 'walk') {
          x += dir * SPEED * dt;
          if (x >= max || x <= min) {
            dir = x >= max ? -1 : 1;
            mode = 'idle';
            until = t + 1000 + Math.random() * 1400;
          } else if (t > until) {
            mode = 'idle';
            until = t + 900 + Math.random() * 1800;
          }
        } else if (t > until) {
          mode = 'walk';
          until = t + 2600 + Math.random() * 3600;
          if (Math.random() < 0.35) dir = -dir;
        }
      }
      x = Math.min(Math.max(x, min), max);
      if (walker.current) walker.current.style.transform = `translateX(${Math.round(x)}px)`;
      if (flip.current) flip.current.style.transform = `scaleX(${dir})`;
      if (hop.current) hop.current.style.transform = reduce ? '' : mode === 'walk' ? (Math.floor(t / 140) % 2 ? 'translateY(-2px)' : '') : Math.floor(t / 700) % 2 ? 'translateY(-1px)' : '';
      const b = bubble.current;
      if (b) {
        const bw = b.offsetWidth;
        const centre = x + W / 2;
        const left = Math.min(Math.max(centre - bw / 2, 8), vw - 8 - bw);
        b.style.transform = `translateX(${Math.round(left)}px)`;
        const tip = Math.round(Math.min(Math.max(centre - left - 6, 10), bw - 22));
        if (arrow.current) arrow.current.style.left = `${tip}px`;
        if (box.current) box.current.style.transformOrigin = `${tip + 6}px 100%`; // it folds into him and grows out of him
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);

  return (
    <div ref={strip} className="pointer-events-none fixed inset-x-0 bottom-0 z-40 h-0">
      <div ref={walker} className="absolute bottom-0 left-0" style={{ width: W, height: H }}>
        <button type="button" onClick={onOpen} aria-label="Chat with Woshi, the WASHO assistant" className="pointer-events-auto block outline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-washo-400" style={{ width: W, height: H }}>
          <span ref={flip} className="block">
            <span ref={hop} className="block">
              {missing ? <WoshiSprite className="w-[66px]" /> : <img src="/woshi.png" alt="" draggable={false} onError={() => setMissing(true)} className="block select-none" style={{ width: W, height: H }} />}
            </span>
          </span>
        </button>
      </div>
      {!off && (
        <div ref={bubble} className="absolute left-0 w-max max-w-[11.5rem]" style={{ bottom: H + 10 }}>
          <div
            ref={box}
            onPointerMove={() => { touched.current = Date.now(); }}
            onPointerDown={() => { touched.current = Date.now(); }}
            onFocus={() => { touched.current = Date.now(); }}
            className={`relative rounded-[3px] border-2 border-[#8ecdff] bg-ink-900 py-1.5 pl-2.5 pr-6 text-xs font-semibold leading-snug text-white shadow-[2px_2px_0_0_rgb(0_0_0/0.5)] transition-[scale,transform,opacity] ${shown ? 'pointer-events-auto scale-100 opacity-100 duration-[380ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]' : 'pointer-events-none scale-0 opacity-0 duration-[260ms] ease-in'}`}
            aria-hidden={!shown}
          >
            <button type="button" onClick={onOpen} tabIndex={shown ? 0 : -1} className="text-left">{message}</button>
            <button
              type="button"
              tabIndex={shown ? 0 : -1}
              onClick={() => { try { sessionStorage.setItem(OFF, '1'); } catch { /* it simply shows again next time */ } setOff(true); }}
              aria-label="Dismiss"
              className="absolute right-0.5 top-0.5 grid h-5 w-5 place-items-center text-fog hover:text-white"
            ><X className="h-3 w-3" /></button>
            <span ref={arrow} aria-hidden className="absolute -bottom-[7px] h-3 w-3 rotate-45 border-b-2 border-r-2 border-[#8ecdff] bg-ink-900" />
          </div>
        </div>
      )}
    </div>
  );
}
