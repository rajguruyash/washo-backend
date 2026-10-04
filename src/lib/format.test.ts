import { describe, expect, it } from 'vitest';
import { addDays, dayLabel, duration, formatPlate, friendlyDay, inSentence, percent, prettyDate, prettyPhone, rupees, todayIST } from './format';

describe('formatting', () => {
  it('formats rupees the Indian way, dropping .00', () => {
    expect(rupees(99900)).toBe('₹999');
    expect(rupees(219900)).toBe('₹2,199');
    expect(rupees(14950)).toBe('₹149.50');
    expect(rupees(12345600)).toBe('₹1,23,456');
    expect(rupees(0)).toBe('₹0');
  });

  it('spaces registration plates', () => {
    expect(formatPlate('MH12AB1234')).toBe('MH 12 AB 1234');
    expect(formatPlate('MH14A1234')).toBe('MH 14 A 1234');
    expect(formatPlate('MH141234')).toBe('MH 14 1234');
    expect(formatPlate('22BH1234AA')).toBe('22 BH 1234 AA');
    expect(formatPlate('WEIRD')).toBe('WEIRD');
  });

  it('describes durations', () => {
    expect(duration(30)).toBe('30 min');
    expect(duration(120)).toBe('2 hr');
    expect(duration(150)).toBe('2 hr 30 min');
  });

  it('talks about dates naturally', () => {
    const today = todayIST();
    expect(friendlyDay(today)).toBe('Today');
    expect(friendlyDay(addDays(today, 1))).toBe('Tomorrow');
    expect(inSentence(today)).toBe('today');
    expect(inSentence(addDays(today, 1))).toBe('tomorrow');
    expect(inSentence(addDays(today, 5))).toBe(`on ${dayLabel(addDays(today, 5))}`);
    expect(prettyDate(addDays(today, 1)).startsWith('Tomorrow · ')).toBe(true);
    expect(prettyDate(addDays(today, 5))).toBe(dayLabel(addDays(today, 5)));
  });

  it('shows discounts and phone numbers readably', () => {
    expect(percent(1000)).toBe('10%');
    expect(percent(1500)).toBe('15%');
    expect(percent(250)).toBe('2.5%');
    expect(prettyPhone('+919876543210')).toBe('+91 98765 43210');
    expect(prettyPhone(null)).toBe('');
  });
});
