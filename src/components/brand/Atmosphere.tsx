import { Component, lazy, Suspense, type ReactNode } from 'react';

// ogl (WebGL) is a sizeable chunk: it loads after the page is already usable, and the static glow below shows in the meantime.
const MicroSlats = lazy(() => import('../reactbits/MicroSlats'));

/** The calm glow: used while the slats load, and if the browser cannot do WebGL. */
function Glow() {
  return (
    <>
      <div className="absolute -left-40 -top-40 h-[34rem] w-[34rem] animate-orbit rounded-full bg-washo-700/30 blur-[120px]" />
      <div className="absolute -right-40 top-1/3 h-[30rem] w-[30rem] animate-orbit rounded-full bg-washo-500/15 blur-[120px] [animation-delay:-12s] [animation-direction:alternate-reverse]" />
    </>
  );
}

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
 * save battery. It pauses itself when the tab is hidden, and holds still for people who ask for reduced motion.
 */
export function Atmosphere() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-ink-950">
      <Safe fallback={<Glow />}>
        <Glow />
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
            />
          </div>
        </Suspense>
      </Safe>
      {/* keeps copy readable over the slats */}
      <div className="absolute inset-0 bg-gradient-to-b from-ink-950/50 via-ink-950/60 to-ink-950/85" />
    </div>
  );
}
