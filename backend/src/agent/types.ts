/**
 * What Woshi sends to the website and the app. Everything in a card is built by THIS SERVER from the database's own answers (prices, dates, names); the model only asks for a card
 * to be shown and can never write one. A card is a proposal: nothing is saved or paid until the customer taps Save or slides to pay, and those go through the same API calls the
 * booking pages use, which check everything again.
 */
export type Slot = 'morning' | 'afternoon' | 'night';
export type VehicleKind = 'bike' | 'car' | 'suv';

export interface MoneyLine {
  label: string;
  cents: number;
  tone: 'plain' | 'discount' | 'total';
}

interface CardBase {
  id: string;
  /** After this the card is stale: ask Woshi again (prices and free days change). */
  expires_at: string;
  /** Set once the customer has used the card (saved the vehicle, paid), so a reload never offers it a second time. */
  done?: 'saved' | 'paid';
}

export interface VehicleCard extends CardBase {
  type: 'vehicle';
  fields: { vehicle_type: VehicleKind; make: string; model: string; registration_number: string; color: string; address_id: string | null; parking_location: string };
}

export interface AddressCard extends CardBase {
  type: 'address';
  fields: { label: string; society_name: string; building_block: string; flat_number: string; parking_location: string; area_locality: string; city: string; pincode: string };
}

export interface SingleWashCard extends CardBase {
  type: 'single_wash';
  title: string;
  rows: { label: string; value: string }[];
  lines: MoneyLine[];
  total_cents: number;
  /** Exactly what POST /api/payments/on-demand takes. */
  pay: { vehicle_id: string; service_id: string; scheduled_date: string; time_slot: Slot; address_id: string; parking_location?: string; coupon?: string };
  description: string;
}

export interface MembershipCard extends CardBase {
  type: 'membership';
  title: string;
  rows: { label: string; value: string }[];
  lines: MoneyLine[];
  total_cents: number;
  per_month_cents: number;
  /** Exactly what POST /api/payments/membership-checkout takes. */
  pay: { vehicle_id: string; monthly: { body: number; deep: number; weekdays: number[] }; duration_months: number; time_slot: Slot; start_date: string; address_id: string; parking_location?: string; coupon?: string };
  description: string;
}

export type Card = VehicleCard | AddressCard | SingleWashCard | MembershipCard;

/** One thing said in the chat, as the screen shows it. */
export interface Bubble {
  role: 'user' | 'assistant';
  text: string;
  cards?: Card[];
  at: string;
}

export interface ChatResult {
  reply: string;
  cards: Card[];
  quick_replies: string[];
  /** A short word on what happened to this turn: the screen can say more for a limit than for an ordinary answer. */
  notice?: 'limit' | 'declined' | 'unavailable' | 'long_chat';
}

export class AgentError extends Error {
  constructor(public status: number, public code: string, message: string, public notice?: ChatResult['notice']) {
    super(message);
  }
}
