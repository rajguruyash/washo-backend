import { useEffect, useLayoutEffect, useRef } from 'react';
import { holdBackground } from '../../lib/holdBackground';

/**
 * What both Woshis (the booking assistant in the app, the question helper on the public site) do while their chat is open: the animated background stands still before the first paint of the
 * chat, Escape closes it, and on a computer the cursor is in the box at once (on a touch screen the keyboard stays down until the box is tapped, or it would cover the buttons).
 */
export function useChatSheet(open: boolean, onClose: () => void) {
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useLayoutEffect(() => (open ? holdBackground() : undefined), [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', onKey);
    if (window.matchMedia?.('(pointer: fine)').matches) field.current?.focus({ preventScroll: true });
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return { scroller, field };
}
