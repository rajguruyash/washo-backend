import { useEffect, useState } from 'react';
import avatarUrl from '../assets/brand/washo-avatar.webp';
import carUrl from '../assets/services/car-body-wash.webp';
import { whenLoaderDone } from '../lib/loaderState';
import PixelSwap from './reactbits/PixelSwap';

/**
 * The home page's opening move (React Bits Pixel Swap): as the page opens, a dusty, dull car dissolves pixel by pixel into WASHO's crew
 * arriving to clean it. It plays once the loading screen has gone, and tapping the picture plays it again (or back).
 */
export function HeroSwap() {
  const [swapped, setSwapped] = useState(false);

  useEffect(() => {
    let t = 0;
    const cancel = whenLoaderDone(() => {
      t = window.setTimeout(() => setSwapped(true), 450);
    });
    return () => {
      cancel();
      window.clearTimeout(t);
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-sm">
      <PixelSwap
        trigger="click"
        active={swapped}
        onActiveChange={setSwapped}
        aspectRatio="3 / 4"
        pixelSize={44}
        pattern="diagonal"
        randomness={0.4}
        pixelScale={0.2}
        pixelSpin={70}
        pixelRadius={8}
        duration={1700}
        pixelDuration={560}
        className="rounded-[2rem] border border-white/10 shadow-[0_30px_80px_-30px_rgb(18_72_184/0.7)]"
        firstContent={
          <div className="relative h-full w-full bg-ink-900">
            <img src={carUrl} alt="A dusty car, before a WASHO wash" width={960} height={960} decoding="async" draggable={false} className="h-full w-full select-none object-cover [filter:grayscale(0.9)_brightness(0.55)_contrast(0.92)_sepia(0.3)]" />
            <div aria-hidden className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_20%,rgba(120,100,70,0.35),transparent_60%)]" />
            <span className="absolute bottom-4 left-4 rounded-full border border-white/15 bg-ink-950/70 px-3 py-1 text-xs font-semibold text-mist backdrop-blur">Before</span>
          </div>
        }
        secondContent={
          <div className="relative grid h-full w-full place-items-end overflow-hidden bg-gradient-to-b from-washo-700/50 via-ink-800 to-ink-900">
            <div aria-hidden className="absolute inset-x-[8%] bottom-[8%] top-[18%] rounded-full bg-washo-500/30 blur-[70px]" />
            <img src={avatarUrl} alt="A WASHO crew member in a navy WASHO cap and polo, holding a pressure washer" width={896} height={1200} decoding="async" draggable={false} className="relative h-[96%] w-auto select-none object-contain drop-shadow-[0_24px_30px_rgb(0_0_0/0.5)]" />
            <span className="absolute bottom-4 left-4 rounded-full border border-washo-300/30 bg-washo-600/40 px-3 py-1 text-xs font-semibold text-white backdrop-blur">After WASHO</span>
          </div>
        }
      />
      <p className="mt-3 text-center text-xs text-fog">Tap the picture to swap it</p>
    </div>
  );
}
