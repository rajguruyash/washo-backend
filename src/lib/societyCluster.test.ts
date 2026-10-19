import { describe, expect, it } from 'vitest';
import { SOCIETY_MATCH, clusterSocieties, societySimilarity, societyWords } from './societyCluster';

const PURVA = ['Purva Silversands', 'Purva Sliversands', 'Purva Sliversands mundhva', 'Purva Silversands Keshavnagar', 'purva silversands', 'PURVA SILVERSANDS, Mundhwa'];

describe('society names that are the same society', () => {
  it('ignores case, punctuation, spaces and filler words', () => {
    expect(societyWords('  Purva   SILVERSANDS, (CHS) ')).toEqual(['purva', 'silversands']);
    expect(societyWords('The Society')).toEqual(['the', 'society']);   // never leaves nothing
    expect(societyWords(null)).toEqual([]);
  });

  it('scores a typo, a place added to the name, or both, at 65% or more', () => {
    for (const other of PURVA) expect(societySimilarity('Purva Silversands', other), other).toBeGreaterThanOrEqual(SOCIETY_MATCH);
    expect(societySimilarity('Purva Sliversands', 'Purva Silversands Keshavnagar')).toBeGreaterThanOrEqual(SOCIETY_MATCH);
    expect(societySimilarity('Purva Sliversands Mundhva', 'Purva Silversands Keshavnagar')).toBeGreaterThanOrEqual(SOCIETY_MATCH);   // 2 of 3 words
    expect(societySimilarity('Silversands', 'Silversand')).toBeGreaterThanOrEqual(SOCIETY_MATCH);
    expect(societySimilarity('Purvasilversands', 'Purva Silversands')).toBeGreaterThanOrEqual(SOCIETY_MATCH);   // spacing
    expect(societySimilarity('Sai Heights', 'Sai Hieghts')).toBeGreaterThanOrEqual(SOCIETY_MATCH);   // two letters swapped
  });

  it('keeps different societies apart, even when they share a word', () => {
    for (const [a, b] of [['Purva Silversands', 'Purva Panorama'], ['Amar Residency', 'Amar Orchid'], ['Yashwin Orizzonte', 'Yashwin Enclave'], ['Kumar Prestige', 'Kumar Paradise'], ['Sai Heights', 'Sky Heights'], ['Purva', 'Purva Silversands'], ['Sky Towers 1', 'Sky Towers 2'], ['Purva Silversands A', 'Purva Silversands B'], ['Purva Silversands Mundhwa', 'Purva Panorama Mundhwa']]) {
      expect(societySimilarity(a, b), `${a} / ${b}`).toBeLessThan(SOCIETY_MATCH);
    }
  });

  it('groups all the ways of writing one society into one, labelled the way most customers wrote it', () => {
    const c = clusterSocieties([...PURVA, 'Amar Residency', 'Amar Residency', 'Yashwin Orizzonte']);
    expect(c.groups).toHaveLength(3);
    const purva = c.groups.find((g) => /purva/i.test(g.label))!;
    expect(purva.variants).toHaveLength(5);   // "Purva Silversands" and "purva silversands" are one way of writing it
    expect(purva.count).toBe(6);
    expect(purva.label.toLowerCase()).toBe('purva silversands');
    for (const v of PURVA) expect(c.keyOf(v)).toBe(purva.key);
    expect(c.keyOf('Amar Residency')).not.toBe(purva.key);
    expect(c.keyOf('Yashwin Orizzonte')).toBe(c.groups.find((g) => g.label === 'Yashwin Orizzonte')!.key);
  });

  it('chains: a name close to any name in a group joins it', () => {
    const c = clusterSocieties(['Green Park Residency', 'Green Park Residency Phase 2', 'Green Park Residency Phase 2 Kharadi Pune']);
    expect(c.groups).toHaveLength(1);
  });

  it('handles nothing, blanks and one name', () => {
    expect(clusterSocieties([]).groups).toEqual([]);
    expect(clusterSocieties([null, undefined, '  ', '--']).groups).toEqual([]);
    const one = clusterSocieties(['Amar Residency']);
    expect(one.groups).toHaveLength(1);
    expect(one.keyOf('amar   residency')).toBe(one.groups[0].key);
    expect(one.keyOf(null)).toBe('');
    expect(one.keyOf('Something Else')).toBe('');
  });

  it('the label is the most common way it was written; a tie goes to the shortest', () => {
    const common = clusterSocieties(['Purva Silversands Mundhwa', 'Purva Silversands Mundhwa', 'Purva Silversands']);
    expect(common.groups[0].label).toBe('Purva Silversands Mundhwa');
    const tied = clusterSocieties(['Purva Silversands Mundhwa', 'Purva Silversands']);
    expect(tied.groups[0].label).toBe('Purva Silversands');
  });
});
