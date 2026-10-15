import { MessageCircle, Phone } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { prettyPhone } from '../lib/format';
import { waLink } from '../lib/whatsapp';

/**
 * A customer's number that can be tapped: it opens a small menu with "Chat on WhatsApp" (the chat opens with `message` already typed, in WhatsApp or WhatsApp Business, whichever
 * the device uses) and "Call". Safe to put inside a clickable row: tapping the number does not open the row.
 */
export function PhoneAction({ phone, message, className }: { phone: string | null | undefined; message: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const width = 224;
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const away = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); trigger.current?.focus(); } };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  if (!phone) return null;
  const chat = waLink(phone, message);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}
        className={className ?? 'font-medium text-washo-300 underline decoration-washo-300/40 underline-offset-2 hover:text-white'}
      >
        {prettyPhone(phone)}
      </button>
      {open && pos && createPortal(
        <div ref={menu} role="menu" aria-label={`Contact ${prettyPhone(phone)}`} style={{ position: 'fixed', top: pos.top, left: pos.left, width: 224 }} onClick={stop}
          className="z-[100] overflow-hidden rounded-2xl border border-white/10 bg-ink-900/95 p-1.5 shadow-2xl backdrop-blur-xl">
          {chat && (
            <a role="menuitem" href={chat} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)} className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-semibold hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none">
              <MessageCircle className="h-4 w-4 text-ok" aria-hidden /> Chat on WhatsApp
            </a>
          )}
          <a role="menuitem" href={`tel:${phone}`} onClick={() => setOpen(false)} className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-semibold hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none">
            <Phone className="h-4 w-4 text-washo-300" aria-hidden /> Call
          </a>
        </div>,
        document.body
      )}
    </>
  );
}
