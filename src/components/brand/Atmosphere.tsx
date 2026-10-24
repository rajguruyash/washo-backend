import { Component, lazy, Suspense, type ReactNode } from 'react';
import { useBackgroundHeld } from '../../lib/holdBackground';

// ogl (WebGL) is a sizeable chunk: it loads after the page is already usable, and the static glow below shows in the meantime.
const MicroSlats = lazy(() => import('../reactbits/MicroSlats'));

/**
 * A soft glow of one colour: a radial gradient that falls off the way a blurred disc does (the stops follow a Gaussian), with no blur filter. The two big blurred discs this replaces had to be
 * re-blurred whenever the browser redrew them, which on a phone competed with everything the visitor tried to do; a gradient costs nothing to draw.
 */
const glow = (rgb: string, a: number) =>
  `radial-gradient(closest-side, rgb(${rgb} / ${(a * 0.99).toFixed(3)}), rgb(${rgb} / ${(a * 0.87).toFixed(3)}) 32%, rgb(${rgb} / ${(a * 0.5).toFixed(3)}) 63%, rgb(${rgb} / ${(a * 0.32).toFixed(3)}) 77%, rgb(${rgb} / ${(a * 0.16).toFixed(3)}) 91%, rgb(${rgb} / 0))`;

/** The calm glow: used while the slats load, and if the browser cannot do WebGL. */
function Glow({ still }: { still: boolean }) {
  const hold = still ? ' [animation-play-state:paused]' : '';
  return (
    <>
      <div className={`absolute -left-[318px] -top-[318px] h-[860px] w-[860px] animate-orbit will-change-transform${hold}`} style={{ background: glow('18 72 184', 0.3) }} />
      <div className={`absolute -right-[320px] top-[calc(33.333%-160px)] h-[800px] w-[800px] animate-orbit will-change-transform [animation-delay:-12s] [animation-direction:alternate-reverse]${hold}`} style={{ background: glow('63 124 255', 0.15) }} />
    </>
  );
}

/** Touch screens and small computers get a lighter background: a lower resolution (it sits under a dark veil, so the detail is not missed) and half the frames. */
const light = () => typeof window !== 'undefined' && (Boolean(window.matchMedia?.('(pointer: coarse)').matches) || (navigator.hardwareConcurrency ?? 8) <= 4);

/** Anything that goes wrong inside the background (no WebGL, a lost context) must never take the page down with it. */
class Safe extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.warn('Background animation disabled:', error.message);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const fine = () => typeof window !== 'undefined' && !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;

/**
 * Fixed backdrop behind every page: a wall of tiny slats that rolls like a sea (React Bits Micro Slats), tinted WASHO blue and
 * dimmed so text stays easy to read. Mounted once, at the root. The cursor stirs it on desktop; touch screens skip that part to
 * save battery. It pauses itself when the tab is hidden, and holds still for people who ask for reduced motion, and while a screen that opened over the page (the Woshi chat) holds it still.
 */
export function Atmosphere() {
  const still = useBackgroundHeld();
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-ink-950">
      <Safe fallback={<Glow still={still} />}>
        <Glow still={still} />
        <Suspense fallback={null}>
          <div className="absolute inset-0 opacity-60">
            <MicroSlats
              preset="tide"
              backgroundColor="#05080f"
              color="#2a62e6"
              glintColor="#9bbfff"
              slatWidth={9}
              slatHeight={22}
              gap={3}
              interactive={fine()}
              intro
              paused={still}
              maxDpr={light() ? 1.25 : 1.5}
              maxFps={light() ? 30 : 0}
            />
          </div>
        </Suspense>
      </Safe>
      {/* keeps copy readable over the slats */}
      <div className="absolute inset-0 bg-gradient-to-b from-ink-950/50 via-ink-950/60 to-ink-950/85" />
    </div>
  );
}
