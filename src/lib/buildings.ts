/** Filtering a specialist's washes by building ("B2", "B3", "B5"...). Pure helpers; the worker page uses them on every section. */

/** Choose "All buildings". */
export const ALL_BUILDINGS = 'all';
/** Washes whose address has no building written. */
export const NO_BUILDING = 'none';

/** One building written any way ("b2", " B-2", "B 2") is the same building. */
export const buildingKey = (b: string | null | undefined): string => (b ?? '').trim().toUpperCase().replace(/[\s-]+/g, '');

export interface BuildingOption {
  value: string;
  label: string;
}

/** The buildings in `rows`, in natural order (B2, B3, B10), then "No building" when some wash has none. Rows without details (hidden for washes that are not yours) are ignored. */
export function buildingOptions<T extends { building_block: string | null; hidden?: boolean }>(rows: T[]): BuildingOption[] {
  const seen = new Map<string, string>();
  let none = false;
  for (const r of rows) {
    if (r.hidden) continue;
    const key = buildingKey(r.building_block);
    if (!key) none = true;
    else if (!seen.has(key)) seen.set(key, (r.building_block ?? '').trim().toUpperCase());
  }
  const out = [...seen].sort((a, b) => a[1].localeCompare(b[1], 'en', { numeric: true })).map(([value, label]) => ({ value, label }));
  return none ? [...out, { value: NO_BUILDING, label: 'No building' }] : out;
}

/** Does this wash belong to the chosen building? Hidden rows (details not shown) only match "All buildings". */
export function inBuilding(r: { building_block: string | null; hidden?: boolean }, choice: string): boolean {
  if (choice === ALL_BUILDINGS) return true;
  if (r.hidden) return false;
  const key = buildingKey(r.building_block);
  return choice === NO_BUILDING ? key === '' : key === choice;
}

// ───────── societies (the same idea one level up: a specialist who washes in several societies filters by society, then by building) ─────────

/** Choose "All societies". */
export const ALL_SOCIETIES = 'all';

/** One society written any way ("Yashwin  Orizzonte", "yashwin orizzonte") is the same society. */
export const societyKey = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The societies in `rows`, A to Z. Rows without details (hidden) or without a society are ignored. */
export function societyOptions<T extends { society_name: string | null; hidden?: boolean }>(rows: T[]): BuildingOption[] {
  const seen = new Map<string, string>();
  for (const r of rows) {
    if (r.hidden) continue;
    const key = societyKey(r.society_name);
    if (key && !seen.has(key)) seen.set(key, (r.society_name ?? '').trim().replace(/\s+/g, ' '));
  }
  return [...seen].sort((a, b) => a[1].localeCompare(b[1], 'en', { numeric: true })).map(([value, label]) => ({ value, label }));
}

/** Does this wash belong to the chosen society? Hidden rows (details not shown) only match "All societies". */
export function inSociety(r: { society_name: string | null; hidden?: boolean }, choice: string): boolean {
  if (choice === ALL_SOCIETIES) return true;
  if (r.hidden) return false;
  return societyKey(r.society_name) === choice;
}
