import { useEffect, useState } from 'react';
import avatarUrl from '../assets/brand/washo-avatar.webp';
import logoUrl from '../assets/brand/washo-logo-full.webp';
import { whenLoaderDone } from '../lib/loaderState';
import { cn } from '../lib/cn';
import PixelSwap from './reactbits/PixelSwap';

// How long the opening swap takes, in all (the pixels land one after another over this time).
const SWAP_MS = 4200;

/**
 * The home page's opening move (React Bits Pixel Swap): as the site opens, the WASHO logo from the loading screen breaks into pixels that
 * swap, one by one, into the WASHO crew member, who then just floats there. It starts as the loading screen leaves and takes about four seconds.
 * No frame, no labels, and nothing to tap.
 */
export function HeroSwap() {
  const [swapped, setSwapped] = useState(false);
  const [floating, setFloating] = useState(false); // the float starts only once the swap is over, so the swapped pixels are still pictures

  useEffect(() => {
    let t = 0;
    const cancel = whenLoaderDone(() => {
      t = window.setTimeout(() => setSwapped(true), 120);
    });
    return () => {
      cancel();
      window.clearTimeout(t);
    };
  }, []);

  return (
    <div className="relative isolate mx-auto w-full max-w-sm">
      {/* The glow and the floor shadow sit OUTSIDE the swap: every pixel carries its own copy of the picture, and a blur filter in each of
          ~190 copies would make the swap crawl. */}
      <div aria-hidden className="absolute inset-x-[8%] bottom-[2%] top-[18%] -z-10 rounded-full bg-washo-600/35 blur-[70px]" />
      <div aria-hidden className="absolute inset-x-[22%] bottom-0 -z-10 h-6 rounded-[50%] bg-black/60 blur-xl" />
      <PixelSwap
        trigger="manual"
        active={swapped}
        onComplete={(active) => setFloating(active)}
        aspectRatio="896 / 1200"
        pixelSize={34}
        pattern="spiral"
        randomness={0.45}
        pixelScale={0.15}
        pixelSpin={110}
        pixelRadius={10}
        duration={SWAP_MS}
        pixelDuration={1300}
        style={{ overflow: 'visible' }}
        firstContent={
          <div className="grid h-full w-full place-items-center">
            <img src={logoUrl} alt="WASHO. Clean today, shine everyday." width={560} height={187} decoding="async" draggable={false} className="w-[86%] select-none" />
          </div>
        }
        secondContent={
          <img
            src={avatarUrl}
            alt="A WASHO crew member in a navy WASHO cap and polo, holding a pressure washer"
            width={896}
            height={1200}
            decoding="async"
            draggable={false}
            className={cn('mx-auto h-full w-full select-none object-contain', floating && 'animate-float')}
          />
        }
      />
    </div>
  );
}
