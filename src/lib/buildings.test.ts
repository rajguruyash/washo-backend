import { describe, expect, it } from 'vitest';
import { ALL_BUILDINGS, ALL_SOCIETIES, NO_BUILDING, buildingKey, buildingOptions, inBuilding, inSociety, societyKey, societyOptions } from './buildings';

const row = (building_block: string | null, hidden = false) => ({ building_block, hidden });

describe('building filter', () => {
  it('treats one building written differently as the same one', () => {
    expect(buildingKey('b2')).toBe('B2');
    expect(buildingKey(' B-2 ')).toBe('B2');
    expect(buildingKey('B 2')).toBe('B2');
    expect(buildingKey(null)).toBe('');
    expect(buildingKey('   ')).toBe('');
  });

  it('lists each building once, in natural order, and "No building" last', () => {
    const rows = [row('B10'), row('b2'), row('B3'), row('B2'), row(null), row('B5'), row('  '), row('A1')];
    expect(buildingOptions(rows)).toEqual([
      { value: 'A1', label: 'A1' }, { value: 'B2', label: 'B2' }, { value: 'B3', label: 'B3' }, { value: 'B5', label: 'B5' }, { value: 'B10', label: 'B10' },
      { value: NO_BUILDING, label: 'No building' },
    ]);
  });

  it('ignores washes whose details are hidden, and has no "No building" when every wash has one', () => {
    expect(buildingOptions([row('B2'), row(null, true)])).toEqual([{ value: 'B2', label: 'B2' }]);
    expect(buildingOptions([])).toEqual([]);
  });

  it('matches a wash to the chosen building however it was written', () => {
    expect(inBuilding(row('b-2'), 'B2')).toBe(true);
    expect(inBuilding(row('B3'), 'B2')).toBe(false);
    expect(inBuilding(row(null), NO_BUILDING)).toBe(true);
    expect(inBuilding(row('B2'), NO_BUILDING)).toBe(false);
    expect(inBuilding(row('B2'), ALL_BUILDINGS)).toBe(true);
    expect(inBuilding(row(null), ALL_BUILDINGS)).toBe(true);
  });

  it('a wash with hidden details only shows under All buildings', () => {
    expect(inBuilding(row(null, true), ALL_BUILDINGS)).toBe(true);
    expect(inBuilding(row(null, true), NO_BUILDING)).toBe(false);
    expect(inBuilding(row('B2', true), 'B2')).toBe(false);
  });
});

describe('society filter', () => {
  const row = (society_name: string | null, hidden = false) => ({ society_name, hidden });

  it('treats one society written differently as the same one', () => {
    expect(societyKey('Yashwin Orizzonte')).toBe('yashwin orizzonte');
    expect(societyKey('  yashwin   ORIZZONTE ')).toBe('yashwin orizzonte');
    expect(societyKey(null)).toBe('');
  });

  it('lists each society once, A to Z, and ignores washes with no details or no society', () => {
    const rows = [row('Yashwin Orizzonte'), row('Amar Residency'), row('yashwin  orizzonte'), row(null), row('  '), row('Zen Heights', true)];
    expect(societyOptions(rows)).toEqual([{ value: 'amar residency', label: 'Amar Residency' }, { value: 'yashwin orizzonte', label: 'Yashwin Orizzonte' }]);
    expect(societyOptions([])).toEqual([]);
  });

  it('matches a wash to the chosen society; hidden washes only show under All societies', () => {
    expect(inSociety(row('Yashwin  Orizzonte'), 'yashwin orizzonte')).toBe(true);
    expect(inSociety(row('Amar Residency'), 'yashwin orizzonte')).toBe(false);
    expect(inSociety(row(null), 'yashwin orizzonte')).toBe(false);
    expect(inSociety(row(null), ALL_SOCIETIES)).toBe(true);
    expect(inSociety(row('Amar Residency', true), 'amar residency')).toBe(false);
    expect(inSociety(row('Amar Residency', true), ALL_SOCIETIES)).toBe(true);
  });
});
