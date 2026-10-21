import { AnimatePresence, motion } from 'framer-motion';
import { RotateCcw, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { useAgent, useAgentStatus } from '../../lib/agent';
import { WoshiMascot } from './WoshiMascot';
import { WoshiWalker } from './WoshiWalker';
import { AgentCards } from './AgentCards';

/**
 * Woshi, the booking assistant. A little pixel mascot that walks along the footer (on top of the phone's tab bar) and says hello in a speech bubble with an arrow; tapping him opens a chat over about 70% of the
 * screen (a sheet rising from the bottom on a phone, a chat box beside the page on a computer, where the page stays usable). It appears only for a signed-in customer, only when the
 * server has the assistant switched on, and not on the booking wizards (they have their own bar at the bottom of the screen).
 */
const HIDDEN = /^\/app\/(book|claim|welcome|membership\/new)\/?$/;
const MAX = 600;
const HELLO = "Hey, I'm Woshi! Do you want to book a wash?";

function Typing() {
  return (
    <div className="flex w-fit items-center gap-1 rounded-2xl rounded-bl-md border border-white/[0.08] bg-white/[0.06] px-4 py-3" role="status" aria-label="Woshi is typing">
      {[0, 1, 2].map((i) => <span key={i} className="h-2 w-2 animate-bounce rounded-full bg-fog" style={{ animationDelay: `${i * 140}ms` }} />)}
    </div>
  );
}

export function AgentWidget() {
  const { pathname } = useLocation();
  const status = useAgentStatus();
  const [open, setOpen] = useState(false);
  const agent = useAgent(open);
  const [text, setText] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  // moving to another page closes the chat (derived while rendering, not in an effect)
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
  }

  const available = Boolean(status.data?.enabled) && !HIDDEN.test(pathname);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    const t = window.setTimeout(() => field.current?.focus(), 300);
    return () => { window.removeEventListener('keydown', onKey); window.clearTimeout(t); };
  }, [open]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [agent.bubbles, agent.busy, agent.chips]);

  if (!available) return null;
  const fallback = status.data?.fallback_links ?? [];

  const openChat = () => setOpen(true);
  const submit = () => {
    const t = text.trim();
    if (!t || agent.busy) return;
    setText('');
    agent.send(t);
  };
  const actions = { event: (ev: Parameters<typeof agent.event>[0]) => agent.event(ev), markDone: agent.markDone };

  return (
    <>
      {/* Woshi walking along the footer, and what he says */}
      {!open && <WoshiWalker message={HELLO} onOpen={openChat} />}

      <AnimatePresence>
        {open && (
          <>
            {/* on a phone the page behind is dimmed; on a computer it stays usable */}
            <motion.div aria-hidden initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(false)} className="fixed inset-0 z-[65] bg-black/60 lg:hidden" />
            <motion.div
              role="dialog"
              aria-label="Chat with Woshi"
              initial={{ opacity: 0, y: 60 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 60 }}
              transition={{ type: 'spring', stiffness: 360, damping: 34 }}
              className={cn(
                'fixed inset-x-0 bottom-0 z-[70] flex h-[72dvh] flex-col overflow-hidden rounded-t-3xl border border-b-0 border-white/[0.12] bg-ink-950 shadow-[0_-20px_60px_-20px_rgb(0_0_0/0.9)]',
                'lg:inset-x-auto lg:bottom-6 lg:right-6 lg:h-[min(72vh,700px)] lg:w-[420px] lg:rounded-3xl lg:border-b lg:shadow-[0_30px_80px_-20px_rgb(0_0_0/0.85)]'
              )}
            >
              <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-white/[0.18] lg:hidden" aria-hidden />
              <header className="flex items-center gap-3 border-b border-white/[0.08] px-4 py-2.5">
                <span className="grid h-11 w-11 shrink-0 place-items-end justify-items-center overflow-hidden rounded-full border border-white/10 bg-[#0f1730]"><WoshiMascot className="w-[38px]" spriteClass="w-[44px]" /></span>
                <div className="min-w-0 flex-1">
                  <p className="font-bold leading-tight">Woshi</p>
                  <p className="text-xs text-fog">WASHO assistant · books washes and memberships</p>
                </div>
                <button type="button" onClick={() => void agent.restart()} aria-label="Start a new chat" title="New chat" className="grid h-9 w-9 place-items-center rounded-full text-fog transition-colors hover:bg-white/[0.08] hover:text-white"><RotateCcw className="h-4 w-4" /></button>
                <button type="button" onClick={() => setOpen(false)} aria-label="Close chat" className="grid h-9 w-9 place-items-center rounded-full text-fog transition-colors hover:bg-white/[0.08] hover:text-white"><X className="h-5 w-5" /></button>
              </header>

              <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
                {agent.bubbles.map((b, i) => (
                  <div key={i} className={cn('flex', b.role === 'user' ? 'justify-end' : 'justify-start')}>
                    <div className={cn('max-w-[88%]', b.cards && 'w-full max-w-full')}>
                      {b.text && (
                        <div className={cn('whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-[15px] leading-snug', b.role === 'user' ? 'rounded-br-md bg-gradient-to-b from-washo-500 to-washo-700 text-white' : b.role === 'notice' ? 'border border-warn/30 bg-warn/10 text-sm' : 'rounded-bl-md border border-white/[0.08] bg-white/[0.06]')}>
                          {b.text}
                        </div>
                      )}
                      {b.cards && <AgentCards cards={b.cards} actions={actions} />}
                    </div>
                  </div>
                ))}
                {agent.busy && <Typing />}
                {agent.fallback && fallback.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {fallback.map((l) => <Link key={l.to} to={l.to} className="rounded-full border border-white/[0.14] bg-white/[0.05] px-4 py-2 text-sm font-semibold hover:bg-white/[0.1]">{l.label}</Link>)}
                  </div>
                )}
              </div>

              {agent.chips.length > 0 && !agent.busy && (
                <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto px-4 pb-2">
                  {agent.chips.map((c) => (
                    <button key={c} type="button" onClick={() => agent.send(c)} className="rounded-full border border-washo-400/40 bg-washo-500/10 px-3.5 py-1.5 text-sm font-semibold text-washo-100 transition-colors hover:bg-washo-500/25">{c}</button>
                  ))}
                </div>
              )}

              <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="border-t border-white/[0.08] bg-ink-900/70 px-3 pb-[calc(0.6rem+env(safe-area-inset-bottom))] pt-2.5">
                <div className="flex items-center gap-2">
                  <input
                    ref={field}
                    value={text}
                    onChange={(e) => setText(e.target.value.slice(0, MAX))}
                    placeholder="Type a message…"
                    aria-label="Message to Woshi"
                    maxLength={MAX}
                    autoComplete="off"
                    enterKeyHint="send"
                    className="h-12 min-w-0 flex-1 rounded-2xl border border-white/[0.12] bg-white/[0.05] px-4 text-[15px] outline-none transition-colors placeholder:text-fog focus:border-washo-400/70"
                  />
                  <button type="submit" disabled={!text.trim() || agent.busy} aria-label="Send" className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-b from-washo-500 to-washo-700 text-white transition-opacity disabled:opacity-40"><Send className="h-5 w-5" /></button>
                </div>
                <p className="mt-1.5 text-center text-[11px] text-fog">Woshi can make mistakes: the price on the booking card is the one that counts.</p>
              </form>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
