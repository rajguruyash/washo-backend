import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { SERVICE_PHOTOS } from '../lib/serviceImages';
import { useAuth } from '../state/auth';
import { Logo } from './brand/Logo';
import DriftWall, { type DriftWallItem } from './reactbits/DriftWall';

// The screen is never up for less than this (so it is a moment, not a flash) nor more than this (so a slow server never traps anyone).
// The first time in a browser tab it gets its full moment; a reload in the same tab only a short one.
const FIRST_MS = 1500;
const AGAIN_MS = 600;
const MAX_MS = 7000;
const KEY = 'washo_seen_loader';
const minimum = () => {
  try {
    const seen = sessionStorage.getItem(KEY) === '1';
    sessionStorage.setItem(KEY, '1');
    return seen ? AGAIN_MS : FIRST_MS;
  } catch {
    return FIRST_MS; // storage can be unavailable (private windows, blocked site data)
  }
};

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
    const a = window.setTimeout(() => setMinPassed(true), minimum());
    const b = window.setTimeout(() => setGaveUp(true), MAX_MS);
    return () => {
      window.clearTimeout(a);
      window.clearTimeout(b);
    };
  }, []);

  const items = useMemo<DriftWallItem[]>(() => {
    const photos = Object.values(SERVICE_PHOTOS);
    return Array.from({ length: 20 }, (_, i) => ({ image: photos[(i * 3 + Math.floor(i / 4)) % photos.length], title: 'WASHO' }));
  }, []);

  const ready = (pageLoaded && minPassed && !loading) || gaveUp;
  return (
    <AnimatePresence>
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
