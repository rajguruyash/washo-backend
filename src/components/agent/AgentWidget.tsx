import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { useAgent, useAgentStatus } from '../../lib/agent';
import { AgentCards } from './AgentCards';
import { BubbleText, ChatSheet } from './ChatSheet';
import { useChatSheet } from './useChatSheet';
import { WoshiWalker } from './WoshiWalker';

/**
 * Woshi, the booking assistant. A little pixel mascot that walks along the footer (on top of the phone's tab bar) and says hello in a speech bubble with an arrow; tapping him opens a chat over about 70% of the
 * screen (a sheet rising from the bottom on a phone, a chat box beside the page on a computer, where the page stays usable: ChatSheet.tsx). It appears only for a signed-in customer, only when the
 * server has the assistant switched on, and not on the booking wizards (they have their own bar at the bottom of the screen).
 * Opening has to be instant on a phone, whatever the page is doing underneath: the sheet slides in with a CSS animation, the animated background is held still while the chat is open, and nothing
 * is focused on a touch screen (the keyboard would cover the buttons).
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
  const available = Boolean(status.data?.enabled) && !HIDDEN.test(pathname);
  const agent = useAgent(status.data, available, open);
  const [text, setText] = useState('');
  const { scroller, field } = useChatSheet(open, () => setOpen(false));

  // moving to another page closes the chat (derived while rendering, not in an effect)
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [agent.bubbles, agent.busy, agent.chips, scroller]);

  if (!available) return null;
  const fallback = status.data?.fallback_links ?? [];

  const submit = () => {
    const t = text.trim();
    if (!t || agent.busy) return;
    setText('');
    agent.send(t);
  };
  const actions = { event: (ev: Parameters<typeof agent.event>[0]) => agent.event(ev), markDone: agent.markDone, coupon: agent.coupon };

  return (
    <>
      {/* Woshi walking along the footer, and what he says */}
      {!open && <WoshiWalker message={HELLO} onOpen={() => setOpen(true)} />}

      {open && (
        <ChatSheet
          subtitle="WASHO assistant · books washes and memberships"
          onClose={() => setOpen(false)}
          onNew={() => void agent.restart()}
          scroller={scroller}
          field={field}
          chips={agent.busy ? [] : agent.chips.map((c) => ({ id: c, label: c }))}
          onChip={agent.send}
          text={text}
          onText={setText}
          onSubmit={submit}
          canSend={Boolean(text.trim()) && !agent.busy}
          max={MAX}
          note="Woshi can make mistakes: the price on the booking card is the one that counts."
        >
          {agent.bubbles.map((b, i) => (
            <div key={i} className={cn('flex', b.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div className={cn('max-w-[88%]', b.cards && 'w-full max-w-full')}>
                {b.text && <BubbleText role={b.role}>{b.text}</BubbleText>}
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
        </ChatSheet>
      )}
    </>
  );
}
