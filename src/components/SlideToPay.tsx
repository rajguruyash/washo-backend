import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import SlideCommit from './reactbits/SlideCommit';

/**
 * Slide to pay (React Bits Slide Commit), sized to the space it is given. Also used to claim a free wash (pass `doneLabel`/`errorLabel`).
 * `onConfirm` runs when the handle reaches the end: the handle shows a spinner while it runs, a green "Paid" pill when it
 * resolves, and springs back with a shake when it throws (so the customer can slide again). Keyboard: arrows, or End to confirm.
 */
export function SlideToPay({ label, onConfirm, onDone, disabled, doneLabel = 'Paid', errorLabel = 'Payment not completed' }: { label: string; onConfirm: () => Promise<unknown>; onDone?: () => void; disabled?: boolean; doneLabel?: string; errorLabel?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(200, Math.floor(el.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={box} className="min-w-0 flex-1">
      <SlideCommit
        label={label as ReactNode}
        doneLabel={doneLabel}
        errorLabel={errorLabel}
        width={width}
        height={56}
        radius={18}
        trackColor="#1a2542"
        handleColor="#3f7cff"
        successColor="#3dd9a0"
        dangerColor="#ff6b7a"
        holdMs={2500}
        disabled={disabled}
        onConfirm={onConfirm}
        onDone={onDone}
      />
    </div>
  );
}
