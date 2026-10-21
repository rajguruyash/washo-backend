import { describe, expect, it } from 'vitest';
import { COLOURS, missingColour } from './colours';

describe('the vehicle colour reminder', () => {
  it('a vehicle saved before the colour was asked for has none', () => {
    expect(missingColour({ color: null })).toBe(true);
    expect(missingColour({ color: undefined })).toBe(true);
    expect(missingColour({ color: '' })).toBe(true);
    expect(missingColour({ color: '   ' })).toBe(true);
  });
  it('any colour at all clears it', () => {
    expect(missingColour({ color: 'White' })).toBe(false);
    expect(missingColour({ color: ' metallic orange ' })).toBe(false);
  });
  it('offers the usual colours to tap', () => {
    expect(COLOURS).toContain('White');
    expect(COLOURS.length).toBeGreaterThanOrEqual(6);
  });
});
