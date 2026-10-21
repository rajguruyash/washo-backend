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

export function useAgent(open: boolean) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [chips, setChips] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [fallback, setFallback] = useState(false);
  const loaded = useRef(false);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await get<{ bubbles: Bubble[]; quick_replies: string[] }>('/agent/history');
      setBubbles(r.bubbles);
      setChips(r.quick_replies);
    } catch {
      setBubbles([{ role: 'notice', text: 'Woshi is not available right now. You can still book from the Book and Plans screens.', at: now() }]);
      setFallback(true);
    }
  }, []);

  useEffect(() => {
    if (open && !loaded.current) {
      loaded.current = true;
      void load();
    }
  }, [open, load]);

  const take = (t: Turn) => {
    if (t.reply) setBubbles((b) => [...b, { role: 'assistant', text: t.reply, cards: t.cards?.length ? t.cards : undefined, at: now() }]);
    setChips(t.quick_replies ?? []);
  };

  const run = async (go: () => Promise<Turn>) => {
    if (busyRef.current) return;
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
    setBubbles((b) => [...b, { role: 'user', text: t, at: now() }]);
    setChips([]);
    void run(() => post<Turn>('/agent/chat', { message: t }));
  };

  const event = (ev: AgentEvent) => run(() => post<Turn>('/agent/event', ev));

  const restart = async () => {
    await post('/agent/new', {}).catch(() => undefined);
    setFallback(false);
    await load();
  };

  /** A card the customer has used is marked, so it cannot be used twice on this screen. */
  const markDone = (cardId: string, done: 'saved' | 'paid') =>
    setBubbles((all) => all.map((b) => (b.cards ? { ...b, cards: b.cards.map((c) => (c.id === cardId ? { ...c, done } : c)) } : b)));

  return { bubbles, chips, busy, fallback, send, event, restart, markDone };
}
