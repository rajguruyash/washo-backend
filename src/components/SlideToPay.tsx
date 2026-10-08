import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Blocker } from '../lib/payBlockers';
import SlideCommit from './reactbits/SlideCommit';

/** Scrolls to the place the missing information goes and flashes it red. */
function showMissing(target?: string) {
  const el = target ? document.getElementById(target) : null;
  if (!el) return;
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' });
  el.classList.remove('missing-flash');
  void el.offsetWidth; // restart the flash if it is still running from the last slide
  el.classList.add('missing-flash');
  window.setTimeout(() => el.classList.remove('missing-flash'), 2200);
  // The cursor is deliberately NOT moved into the field: focusing an input while the page is still scrolling closes the page in WebKit (found in testing), and on a
  // phone it would throw the keyboard up over the very thing being pointed at. The customer taps the flashing box themselves.
}

/**
 * Slide to pay (React Bits Slide Commit), sized to the space it is given. Also used to claim a free wash (pass `doneLabel`/`errorLabel`).
 * `onConfirm` runs when the handle reaches the end: the handle shows a spinner while it runs, a green "Paid" pill when it
 * resolves, and springs back with a shake when it throws (so the customer can slide again). Keyboard: arrows, or End to confirm.
 *
 * `blockers` are things still missing (a mobile number, an address). The slider is never dead because of them: it slides all the way, then goes RED, says
 * what is missing inside the track, and the page scrolls to the exact place to put it right (see lib/payBlockers). Nothing is sent anywhere.
 */
export function SlideToPay({ label, onConfirm, onDone, disabled, doneLabel = 'Paid', errorLabel = 'Payment not completed', blockers = [] }: { label: string; onConfirm: () => Promise<unknown>; onDone?: () => void; disabled?: boolean; doneLabel?: string; errorLabel?: string; blockers?: Blocker[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  const [said, setSaid] = useState<string | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(200, Math.floor(el.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A SYNCHRONOUS throw makes the handle turn red at once (no spinner first); a rejected promise is for real failures (a payment that did not go through).
  const confirm = (): Promise<unknown> => {
    const first = blockers[0];
    if (first) {
      setSaid(first.label);
      // After a beat, once the finger is up and the handle has turned red, so the colour is seen first and then the page moves.
      window.setTimeout(() => showMissing(first.target), 350);
      throw new Error(first.label);
    }
    setSaid(null);
    return onConfirm();
  };

  return (
    <div ref={box} className="min-w-0 flex-1">
      <SlideCommit
        label={label as ReactNode}
        doneLabel={doneLabel}
        errorLabel={said ?? errorLabel}
        width={width}
        height={56}
        radius={18}
        trackColor="#1a2542"
        handleColor="#3f7cff"
        successColor="#3dd9a0"
        dangerColor="#ff6b7a"
        holdMs={2500}
        disabled={disabled}
        onConfirm={confirm}
        onDone={onDone}
      />
    </div>
  );
}
