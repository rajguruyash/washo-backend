import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import bike from '../assets/loader/bike-body-wash.webp';
import carBody from '../assets/loader/car-body-wash.webp';
import carDeep from '../assets/loader/car-deep-cleaning.webp';
import suvDeep from '../assets/loader/suv-deep-cleaning.webp';
import { markSiteReady } from '../lib/siteReady';
import { useAuth } from '../state/auth';
import { Logo } from './brand/Logo';
import DriftWall, { type DriftWallItem } from './reactbits/DriftWall';

// The screen is never up for less than this (so it is a proper moment, not a flash) nor more than this (so a slow server never traps anyone).
// It stays the same length on every visit: the wall of photos is part of how WASHO opens. If the site takes longer than this to be ready, it
// simply stays until it is.
const MIN_MS = 3500;
const MAX_MS = 9000;

// The wall is made from small copies of the service photos (about 15 KB each, not the 70 KB ones the page shows), so it appears at once and
// does not compete with the page for the connection.
const WALL_PHOTOS = [bike, carBody, carDeep, suvDeep];

// Has the browser finished loading the page's files? (An external store, so a load that finishes between render and effect is never missed.)
const onPageLoad = (cb: () => void) => {
  window.addEventListener('load', cb);
  return () => window.removeEventListener('load', cb);
};
const pageIsLoaded = () => document.readyState === 'complete';

/**
 * What you see while WASHO opens: React Bits Drift Wall (a slowly drifting, tilted wall of WASHO's own photos) behind the logo.
 * It goes when the page's files have loaded and the app knows who is signed in, and fades away rather than cutting.
 */
export function SiteLoader() {
  const { loading } = useAuth();
  const pageLoaded = useSyncExternalStore(onPageLoad, pageIsLoaded, () => false);
  const [minPassed, setMinPassed] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const phone = useMemo(() => window.matchMedia('(max-width: 639px)').matches, []);

  useEffect(() => {
    const a = window.setTimeout(() => setMinPassed(true), MIN_MS);
    const b = window.setTimeout(() => setGaveUp(true), MAX_MS);
    return () => {
      window.clearTimeout(a);
      window.clearTimeout(b);
    };
  }, []);

  const items = useMemo<DriftWallItem[]>(() => {
    return Array.from({ length: 20 }, (_, i) => ({ image: WALL_PHOTOS[(i * 3 + Math.floor(i / 4)) % WALL_PHOTOS.length], title: 'WASHO' }));
  }, []);

  const ready = (pageLoaded && minPassed && !loading) || gaveUp;
  return (
    // (the price countdown and other opening animations wait until the screen has completely gone)
    <AnimatePresence onExitComplete={markSiteReady}>
      {!ready && (
        <motion.div
          key="site-loader"
          role="status"
          aria-live="polite"
          aria-label="Loading WASHO"
          className="fixed inset-0 z-[200] overflow-hidden bg-ink-950"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        >
          <div aria-hidden className="absolute inset-0">
            <DriftWall
              items={items}
              columns={phone ? 4 : 6}
              tileWidth={phone ? 118 : 210}
              tileHeight={phone ? 150 : 210}
              gap={phone ? 12 : 18}
              radius={18}
              speed={phone ? 34 : 42}
              dim={0.72}
              fade={0.55}
              parallax={0.5}
              overlayColor="#05080f"
              interactive={false}
            />
          </div>
          {/* keeps the logo readable over the photos */}
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(5,8,15,0.82)_0%,rgba(5,8,15,0.5)_38%,rgba(5,8,15,0.1)_78%)]" />
          <div className="relative grid h-full place-items-center px-6">
            <div className="text-center">
              <motion.div initial={{ opacity: 0, y: 14, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}>
                <Logo showTagline className="mx-auto h-24 sm:h-32" />
              </motion.div>
              <div className="mx-auto mt-7 h-1 w-44 overflow-hidden rounded-full bg-white/10" aria-hidden>
                <motion.div className="h-full w-1/2 rounded-full bg-gradient-to-r from-transparent via-washo-300 to-transparent" animate={{ x: ['-100%', '200%'] }} transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }} />
              </div>
              <p className="mt-3 text-xs font-medium tracking-[0.2em] text-fog">GETTING YOUR WASH READY</p>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
