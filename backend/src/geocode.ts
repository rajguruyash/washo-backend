import { config } from './config';
import { HttpError } from './errors';

/** What the address form can use from a location: a best guess at the society, and where it is. Nothing here is stored. */
export interface Place {
  society: string | null;
  area: string | null;
  city: string | null;
  pincode: string | null;
  road: string | null;
  label: string;
}

interface Nominatim {
  name?: string;
  category?: string;
  type?: string;
  display_name?: string;
  address?: Record<string, string>;
}

const clean = (v: string | undefined | null): string | null => {
  const t = (v ?? '').trim();
  return t && t.toLowerCase() !== 'yes' ? t : null;
};

/** Picks the useful parts out of Nominatim's answer. Exported for tests. */
export function toPlace(r: Nominatim): Place {
  const a = r.address ?? {};
  // A residential complex or a named building, from the most to the least specific.
  const named = ['building', 'landuse', 'place'].includes(r.category ?? '') ? clean(r.name) : null;
  const society = clean(a.residential) ?? clean(a.building) ?? clean(a.amenity) ?? named;
  const pin = (a.postcode ?? '').replace(/\s+/g, '');
  return {
    society,
    area: clean(a.suburb) ?? clean(a.neighbourhood) ?? clean(a.city_district) ?? clean(a.quarter) ?? clean(a.village),
    city: clean(a.city) ?? clean(a.town) ?? clean(a.municipality) ?? clean(a.state_district) ?? clean(a.county),
    pincode: /^\d{6}$/.test(pin) ? pin : null,
    road: clean(a.road),
    label: (r.display_name ?? '').split(',').slice(0, 3).map((x) => x.trim()).filter(Boolean).join(', '),
  };
}

// The same spot is asked about again and again (retries, two people in one society), and Nominatim wants one request a second.
const cache = new Map<string, { at: number; place: Place }>();
const TTL_MS = 10 * 60_000;
let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;

/** Where is this? Asks OpenStreetMap, politely: one at a time, spaced out, remembered for ten minutes. */
export function reverseGeocode(lat: number, lon: number): Promise<Place> {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.place);

  const run = async (): Promise<Place> => {
    const again = cache.get(key);
    if (again && Date.now() - again.at < TTL_MS) return again.place;
    const wait = lastCall + config.geocode.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 7000);
    try {
      const url = `${config.geocode.url}/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=en&lat=${lat}&lon=${lon}`;
      const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': `WASHO website (${config.email.adminEmail})`, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`geocoder answered ${res.status}`);
      const place = toPlace((await res.json()) as Nominatim);
      if (cache.size > 500) cache.clear();
      cache.set(key, { at: Date.now(), place });
      return place;
    } catch (err) {
      console.error('Reverse geocode failed:', (err as Error).message);
      throw new HttpError(502, 'geocode_unavailable', 'We could not look up your location just now. Please type your society instead.');
    } finally {
      clearTimeout(timer);
    }
  };
  const result = chain.then(run, run);
  chain = result.catch(() => undefined);
  return result;
}
