import { RotateCcw, Send, X } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { cn } from '../../lib/cn';
import { WoshiMascot } from './WoshiMascot';

/** One message's bubble: the customer's on the right in blue, Woshi's on the left, a notice in amber. */
export function BubbleText({ role, children }: { role: 'user' | 'assistant' | 'notice'; children: ReactNode }) {
  return (
    <div className={cn('whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-[15px] leading-snug', role === 'user' ? 'rounded-br-md bg-gradient-to-b from-washo-500 to-washo-700 text-white' : role === 'notice' ? 'border border-warn/30 bg-warn/10 text-sm' : 'rounded-bl-md border border-white/[0.08] bg-white/[0.06]')}>
      {children}
    </div>
  );
}

/**
 * The chat window: a sheet rising from the bottom of a phone (the page behind is dimmed), a box beside the page on a computer (the page stays usable). It slides in with a CSS animation (the
 * phone's graphics layer runs it even while the page is busy, which a script-driven animation cannot). The messages are `children`; the quick-reply buttons and the box are here.
 */
export function ChatSheet({ subtitle, onClose, onNew, scroller, field, chips, onChip, text, onText, onSubmit, canSend, max, note, children }: {
  subtitle: string;
  onClose: () => void;
  onNew: () => void;
  scroller: RefObject<HTMLDivElement | null>;
  field: RefObject<HTMLInputElement | null>;
  chips: { id: string; label: string }[];
  onChip: (id: string) => void;
  text: string;
  onText: (t: string) => void;
  onSubmit: () => void;
  canSend: boolean;
  max: number;
  note: string;
  children: ReactNode;
}) {
  return (
    <>
      <div aria-hidden onClick={onClose} className="fixed inset-0 z-[65] animate-chat-dim bg-black/60 lg:hidden" />
      <div
        role="dialog"
        aria-label="Chat with Woshi"
        className={cn(
          'fixed inset-x-0 bottom-0 z-[70] flex h-[72dvh] animate-chat-in flex-col overflow-hidden rounded-t-3xl border border-b-0 border-white/[0.12] bg-ink-950 shadow-[0_-10px_30px_-12px_rgb(0_0_0/0.8)]',
          'lg:inset-x-auto lg:bottom-6 lg:right-6 lg:h-[min(72vh,700px)] lg:w-[420px] lg:rounded-3xl lg:border-b lg:shadow-[0_30px_80px_-20px_rgb(0_0_0/0.85)]'
        )}
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-white/[0.18] lg:hidden" aria-hidden />
        <header className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-2.5">
          <span className="grid h-11 w-11 shrink-0 place-items-end justify-items-center overflow-hidden rounded-full border border-white/10 bg-[#0f1730]"><WoshiMascot className="w-[38px]" spriteClass="w-[44px]" /></span>
          <div className="min-w-0 flex-1">
            <p className="font-bold leading-tight">Woshi</p>
            <p className="text-xs text-fog">{subtitle}</p>
          </div>
          <button type="button" onClick={onNew} aria-label="Start a new chat" title="New chat" className="grid h-9 w-9 place-items-center rounded-full text-fog transition-colors hover:bg-white/[0.08] hover:text-white"><RotateCcw className="h-4 w-4" /></button>
          <button type="button" onClick={onClose} aria-label="Close chat" className="grid h-9 w-9 place-items-center rounded-full text-fog transition-colors hover:bg-white/[0.08] hover:text-white"><X className="h-5 w-5" /></button>
        </header>

        <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">{children}</div>

        {chips.length > 0 && (
          <div className="flex max-h-44 flex-wrap gap-2 overflow-y-auto px-4 pb-2">
            {chips.map((c) => (
              <button key={c.id} type="button" onClick={() => onChip(c.id)} className="rounded-full border border-washo-400/40 bg-washo-500/10 px-3.5 py-1.5 text-sm font-semibold text-washo-100 transition-colors hover:bg-washo-500/25">{c.label}</button>
            ))}
          </div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }} className="border-t border-white/[0.08] bg-ink-900/70 px-3 pb-[calc(0.6rem+env(safe-area-inset-bottom))] pt-2.5">
          <div className="flex items-center gap-2">
            <input
              ref={field}
              value={text}
              onChange={(e) => onText(e.target.value.slice(0, max))}
              placeholder="Type a message…"
              aria-label="Message to Woshi"
              maxLength={max}
              autoComplete="off"
              enterKeyHint="send"
              className="h-12 min-w-0 flex-1 rounded-2xl border border-white/[0.12] bg-white/[0.05] px-4 text-[15px] outline-none transition-colors placeholder:text-fog focus:border-washo-400/70"
            />
            <button type="submit" disabled={!canSend} aria-label="Send" className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-b from-washo-500 to-washo-700 text-white transition-opacity disabled:opacity-40"><Send className="h-5 w-5" /></button>
          </div>
          <p className="mt-1.5 text-center text-[11px] text-fog">{note}</p>
        </form>
      </div>
    </>
  );
}
