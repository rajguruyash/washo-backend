import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, get, post } from './http';
import type { SlotId } from './types';

/**
 * Woshi, the booking assistant, as the website sees it. The server keeps the conversation and builds every card; this only sends the customer's words (or "I saved it" / "I paid") and
 * shows what comes back. Nothing here talks to a model.
 */
export interface MoneyLine { label: string; cents: number; tone: 'plain' | 'discount' | 'total' }
interface CardBase { id: string; expires_at: string; done?: 'saved' | 'paid' }
export interface VehicleCardData extends CardBase { type: 'vehicle'; fields: { vehicle_type: 'bike' | 'car' | 'suv'; make: string; model: string; registration_number: string; color: string; address_id: string | null; parking_location: string } }
export interface AddressCardData extends CardBase { type: 'address'; fields: { label: string; society_name: string; building_block: string; flat_number: string; parking_location: string; area_locality: string; city: string; pincode: string } }
export interface SingleWashCardData extends CardBase { type: 'single_wash'; title: string; description: string; rows: { label: string; value: string }[]; lines: MoneyLine[]; total_cents: number; pay: { vehicle_id: string; service_id: string; scheduled_date: string; time_slot: SlotId; address_id: string; parking_location?: string; coupon?: string } }
export interface MembershipCardData extends CardBase { type: 'membership'; title: string; description: string; rows: { label: string; value: string }[]; lines: MoneyLine[]; total_cents: number; per_month_cents: number; pay: { vehicle_id: string; monthly: { body: number; deep: number; weekdays: number[] }; duration_months: number; time_slot: SlotId; start_date: string; address_id: string; parking_location?: string; coupon?: string } }
export type AgentCard = VehicleCardData | AddressCardData | SingleWashCardData | MembershipCardData;

export interface Bubble { role: 'user' | 'assistant' | 'notice'; text: string; cards?: AgentCard[]; at: string }

export interface AgentStatus { enabled: boolean; name?: string; greeting?: string; quick_replies?: string[]; fallback_links?: { label: string; to: string }[]; max_chars?: number }

export type AgentEvent =
  | { type: 'vehicle_saved'; vehicle_id: string; card_id?: string }
  | { type: 'address_saved'; address_id: string; card_id?: string }
  | { type: 'paid'; kind: 'single' | 'membership'; id: string; card_id?: string }
  | { type: 'payment_cancelled' };

interface Turn { reply: string; cards: AgentCard[]; quick_replies: string[]; notice?: string }

/** Is the assistant on for this customer (it is off when the server has no model connected)? One quick question per visit. */
export const useAgentStatus = (enabled = true) =>
  useQuery({ queryKey: ['agent-status'], queryFn: () => get<AgentStatus & { success: boolean }>('/agent/status'), enabled, staleTime: 10 * 60_000, retry: false });

const now = () => new Date().toISOString();

const STALE_MS = 60_000; // a chat the screen got from the server this long ago is asked for again when the chat is opened

/**
 * `status` is what the status call brought (the greeting and the buttons), `ready` says Woshi is on screen. Opening the chat never waits for the network: the greeting and the buttons are shown the
 * moment it opens (they came with the status), and the real chat (a conversation that was already going) is fetched quietly as soon as Woshi appears, and again when the chat is opened if
 * that was a while ago. If the customer has already said or done something by the time it arrives, it is dropped: what they see is the truth.
 */
export function useAgent(status: AgentStatus | undefined, ready: boolean, open: boolean) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [chips, setChips] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [fallback, setFallback] = useState(false);
  const busyRef = useRef(false);
  const mine = useRef(false); // the customer has typed, tapped or paid on this screen
  const seeded = useRef(false);
  const syncedAt = useRef(0); // when the server last told us the chat (0 = not yet)
  const ask = useRef(0); // the newest request for the chat; an older answer is ignored
  const pending = useRef<Promise<void> | null>(null); // the request in flight, so it is not asked twice
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);

  /** The greeting and the buttons from the status call: nothing to wait for. */
  const showGreeting = useCallback(() => {
    const s = statusRef.current;
    if (!s?.greeting) return;
    setBubbles([{ role: 'assistant', text: s.greeting, at: now() }]);
    setChips(s.quick_replies ?? []);
  }, []);

  /** Asks the server for the chat as it stands. Quiet: a failure shows nothing (the greeting stays) and an answer that comes after the customer has started is dropped. One question at a time unless `again` (a new chat). */
  const sync = useCallback((again = false): Promise<void> => {
    if (pending.current && !again) return pending.current;
    const mark = ++ask.current;
    const p = (async () => {
      try {
        const r = await get<{ bubbles: Bubble[]; quick_replies: string[] }>('/agent/history');
        if (mark !== ask.current || mine.current) return;
        setBubbles(r.bubbles);
        setChips(r.quick_replies);
        setFallback(false);
        syncedAt.current = Date.now();
      } catch {
        /* the greeting stays; if the server is really down, the first message says so */
      } finally {
        if (ask.current === mark) pending.current = null; // (a newer question keeps its own slot)
      }
    })();
    pending.current = p;
    return p;
  }, []);

  useEffect(() => {
    if (!ready || !status?.greeting || seeded.current) return;
    seeded.current = true;
    if (!mine.current) showGreeting();
  }, [ready, status, showGreeting]);

  useEffect(() => {
    if (!ready || mine.current) return;
    if (!syncedAt.current || (open && Date.now() - syncedAt.current > STALE_MS)) void sync();
  }, [ready, open, sync]);

  const take = (t: Turn) => {
    if (t.reply) setBubbles((b) => [...b, { role: 'assistant', text: t.reply, cards: t.cards?.length ? t.cards : undefined, at: now() }]);
    setChips(t.quick_replies ?? []);
  };

  const run = async (go: () => Promise<Turn>) => {
    if (busyRef.current) return;
    mine.current = true;
    busyRef.current = true;
    setBusy(true);
    setFallback(false);
    try {
      take(await go());
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      setBubbles((b) => [...b, { role: 'notice', text: e?.message ?? 'Something went wrong. Please try again.', at: now() }]);
      setChips([]);
      // a limit or an outage: the booking screens are always there
      if (e && (e.status >= 500 || e.code === 'daily_limit' || e.code === 'slow_down')) setFallback(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const send = (text: string) => {
    const t = text.trim();
    if (!t || busyRef.current) return;
    mine.current = true;
    setBubbles((b) => [...b, { role: 'user', text: t, at: now() }]);
    setChips([]);
    void run(() => post<Turn>('/agent/chat', { message: t }));
  };

  const event = (ev: AgentEvent) => run(() => post<Turn>('/agent/event', ev));

  /** A new chat: the greeting is back at once, and the server's own word follows (it keeps a chat that is in the middle of an answer, so that is left alone here). */
  const restart = async () => {
    if (busyRef.current) return;
    mine.current = false;
    setFallback(false);
    showGreeting();
    await post('/agent/new', {}).catch(() => undefined);
    await sync(true);
  };

  /** A card the customer has used is marked, so it cannot be used twice on this screen. */
  const markDone = (cardId: string, done: 'saved' | 'paid') =>
    setBubbles((all) => all.map((b) => (b.cards ? { ...b, cards: b.cards.map((c) => (c.id === cardId ? { ...c, done } : c)) } : b)));

  /** A coupon typed on a pay card, or taken off it (null): the server prices the card again and the new card takes the old one's place. A refused code throws the server's plain words, and the card stays as it was. */
  const coupon = async (cardId: string, code: string | null) => {
    const r = await post<{ card: AgentCard }>('/agent/coupon', { card_id: cardId, code });
    mine.current = true;
    setBubbles((all) => all.map((b) => (b.cards ? { ...b, cards: b.cards.map((c) => (c.id === cardId ? r.card : c)) } : b)));
  };

  return { bubbles, chips, busy, fallback, send, event, restart, markDone, coupon };
}
