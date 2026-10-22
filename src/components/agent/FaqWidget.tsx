import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { answerFor, byId, replyTo, startingQuestions, type Faq, type FaqLink, type FaqReply } from '../../lib/faq';
import { useCatalog } from '../../lib/queries';
import { useSiteReady } from '../../lib/siteReady';
import { LEGAL } from '../../pages/legal/facts';
import { BubbleText, ChatSheet } from './ChatSheet';
import { useChatSheet } from './useChatSheet';
import { WoshiWalker } from './WoshiWalker';

/**
 * Woshi on the public site (before anyone has signed in): the same little pixel mascot walking along the bottom of the page, but here he only answers common questions about WASHO. There is no
 * model and no server call behind him: the answers are fixed text from the site's own pages (lib/faq.ts), and the prices come from the rate card the page already loads. Anything else gets a polite
 * "I can only answer questions about WASHO". He appears once the opening loading screen has gone, and nothing is stored or sent anywhere.
 */
const HELLO = 'Hi, I\'m Woshi! Got a question about WASHO?';
const GREETING = "Hi! I'm Woshi, WASHO's helper. I can answer questions about our services, prices, memberships and how booking works. Tap a question below or type your own.";
const MAX = 200;

interface Line { role: 'user' | 'assistant'; text: string; links?: FaqLink[] }

const pill = 'rounded-full border border-white/[0.14] bg-white/[0.05] px-4 py-2 text-sm font-semibold transition-colors hover:bg-white/[0.1]';

function FaqChat({ onClose }: { onClose: () => void }) {
  const catalog = useCatalog().data;
  const [lines, setLines] = useState<Line[]>([{ role: 'assistant', text: GREETING }]);
  const [chips, setChips] = useState<Faq[]>(() => startingQuestions());
  const [text, setText] = useState('');
  const { scroller, field } = useChatSheet(true, onClose);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [lines, scroller]);

  const say = (question: string, reply: FaqReply) => {
    setLines((l) => [...l, { role: 'user', text: question }, { role: 'assistant', text: reply.text, links: reply.links }]);
    setChips(reply.next);
  };
  const tap = (id: string) => {
    const f = byId(id);
    if (f) say(f.question, answerFor(f, catalog));
  };
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    say(t, replyTo(t, catalog));
  };
  const fresh = () => {
    setLines([{ role: 'assistant', text: GREETING }]);
    setChips(startingQuestions());
  };

  return (
    <ChatSheet
      subtitle="WASHO helper · answers your questions"
      onClose={onClose}
      onNew={fresh}
      scroller={scroller}
      field={field}
      chips={chips.map((f) => ({ id: f.id, label: f.chip ?? f.question }))}
      onChip={tap}
      text={text}
      onText={setText}
      onSubmit={submit}
      canSend={Boolean(text.trim())}
      max={MAX}
      note={`Woshi answers common questions only. For anything else, call ${LEGAL.phones[0]}.`}
    >
      {lines.map((l, i) => (
        <div key={i} className={cn('flex', l.role === 'user' ? 'justify-end' : 'justify-start')}>
          <div className="max-w-[88%]">
            <BubbleText role={l.role}>{l.text}</BubbleText>
            {l.links && (
              <div className="mt-2 flex flex-wrap gap-2">
                {l.links.map((k) =>
                  k.to.startsWith('/') ? <Link key={k.to} to={k.to} onClick={onClose} className={pill}>{k.label}</Link> : <a key={k.to} href={k.to} className={pill}>{k.label}</a>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
    </ChatSheet>
  );
}

export function FaqWidget() {
  const siteReady = useSiteReady();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);

  // moving to another page closes the chat (derived while rendering, not in an effect)
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
  }

  if (!siteReady) return null;
  return (
    <>
      {!open && <WoshiWalker message={HELLO} onOpen={() => setOpen(true)} sidebar={false} />}
      {open && <FaqChat onClose={() => setOpen(false)} />}
    </>
  );
}
