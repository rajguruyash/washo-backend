/**
 * Customers type their society's name in different ways: "Purva Silversands", "Purva Sliversands" (a typo), "Purva Silversands Mundhwa", "Purva Silversands Keshavnagar". The
 * specialist's page groups all of those into ONE society when at least 65% of the name matches. The match is made word by word, from the start of the name, because that is
 * where the society's own name is and where a customer adds a locality after it:
 *   - a word matches when it is the same word or a typo of it (at least 75% of its letters, a swapped pair of letters counting as one slip), so "Sliversands" matches "Silversands";
 *   - the score is the share of the SHORTER name's words that match, counted from the first word until the first one that does not. "Purva Silversands" / "Purva Silversands
 *     Keshavnagar" is 2 of 2; "Purva Sliversands Mundhva" / "Purva Silversands Keshavnagar" is 2 of 3 (67%); "Purva Silversands" / "Purva Panorama" is 1 of 2 (50%) and stays apart;
 *   - two matching words are needed to join names of different lengths: "Purva" alone is not "Purva Silversands", and a one-word name is only grouped with another one-word name;
 *   - a wing or a number that differs ("Sky Towers 1" / "Sky Towers 2", "Silversands A" / "Silversands B") keeps names apart;
 *   - a name written with different spacing ("Purvasilversands") is also matched on its letters.
 * Names are compared without case, punctuation or filler words ("society", "CHS", "housing"). Matching is chained: a name close to any name in a group joins that group.
 */

export const SOCIETY_MATCH = 0.65;
const WORD_MATCH = 0.75;
const SPACING_MATCH = 0.85;
const FILLER = new Set(['society', 'soc', 'chs', 'coop', 'cooperative', 'housing', 'ltd', 'pvt', 'the']);

/** The words of a society name: lower case, letters and digits only, filler words dropped (unless that would leave nothing). */
export function societyWords(name: string | null | undefined): string[] {
  const all = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
  const kept = all.filter((w) => !FILLER.has(w));
  return kept.length ? kept : all;
}

/** Number of slips between two words: a letter added, dropped or changed, or two neighbouring letters swapped, each count as one. */
const slips = (a: string, b: string): number => {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
};
const alike = (a: string, b: string) => (a === b ? 1 : 1 - slips(a, b) / Math.max(a.length, b.length));
/** A wing ("A") or a number ("2", "A1"): when two names differ in this, they are different places. */
const isTag = (w: string) => w.length === 1 || /\d/.test(w);

/** 0 to 1: how much two society names look like the same society (see the top of this file). */
export function societySimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const wa = societyWords(a), wb = societyWords(b);
  if (!wa.length || !wb.length) return 0;
  if (wa.length === 1 && wb.length === 1) return alike(wa[0], wb[0]);
  const spacing = wa.length !== wb.length ? alike(wa.join(''), wb.join('')) : 0;
  const bySpacing = spacing >= SPACING_MATCH ? spacing : 0;
  const [small, big] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (small.length === 1) return bySpacing;
  let run = 0;
  while (run < small.length && alike(small[run], big[run]) >= WORD_MATCH) run++;
  // a wing or number that differs
  if (run < small.length && isTag(small[run]) && isTag(big[run])) return 0;
  return Math.max(run >= 2 ? run / small.length : 0, bySpacing);
}

export interface SocietyGroup {
  /** What the filter uses to say "this society". Stable for as long as the group keeps the same most-typed name. */
  key: string;
  /** How the society is shown: the way most customers wrote it (the shortest, if tied). */
  label: string;
  /** Every way it was written. */
  variants: string[];
  count: number;
}
export interface SocietyClusters {
  groups: SocietyGroup[];
  /** The group key of a name as typed ('' if there is none). */
  keyOf: (name: string | null | undefined) => string;
}

/** Groups the names that are the same society (see the top of this file). */
export function clusterSocieties(names: (string | null | undefined)[]): SocietyClusters {
  const counts = new Map<string, { text: string; n: number }>();    // by the words, so "Purva  Silversands" and "purva silversands" are one way of writing it
  for (const raw of names) {
    const text = (raw ?? '').trim().replace(/\s+/g, ' ');
    const id = societyWords(text).join(' ');
    if (!id) continue;
    const seen = counts.get(id);
    if (seen) seen.n += 1; else counts.set(id, { text, n: 1 });
  }
  const ids = [...counts.keys()];
  const parent = ids.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (societySimilarity(ids[i], ids[j]) >= SOCIETY_MATCH) parent[find(i)] = find(j);

  const byRoot = new Map<number, number[]>();
  ids.forEach((_, i) => { const r = find(i); byRoot.set(r, [...(byRoot.get(r) ?? []), i]); });
  const groups: SocietyGroup[] = [];
  const keyByWords = new Map<string, string>();
  for (const members of byRoot.values()) {
    const ranked = members.map((i) => ({ id: ids[i], ...counts.get(ids[i])! })).sort((a, b) => b.n - a.n || a.id.length - b.id.length || a.id.localeCompare(b.id));
    const group: SocietyGroup = { key: ranked[0].id, label: ranked[0].text, variants: ranked.map((m) => m.text), count: ranked.reduce((s, m) => s + m.n, 0) };
    groups.push(group);
    for (const m of ranked) keyByWords.set(m.id, group.key);
  }
  groups.sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
  return { groups, keyOf: (name) => keyByWords.get(societyWords(name).join(' ')) ?? '' };
}
