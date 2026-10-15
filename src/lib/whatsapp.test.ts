import { describe, expect, it } from 'vitest';
import { waLink, waMessage, waNumber, washKindWords } from './whatsapp';

describe('WhatsApp links', () => {
  it('turns any way of writing an Indian number into the digits WhatsApp wants', () => {
    expect(waNumber('9876543210')).toBe('919876543210');
    expect(waNumber('+919876543210')).toBe('919876543210');
    expect(waNumber('+91 98765 43210')).toBe('919876543210');
    expect(waNumber('098765 43210')).toBe('919876543210');
    expect(waNumber('')).toBeNull();
    expect(waNumber(null)).toBeNull();
    expect(waNumber('12345')).toBeNull();
  });

  it('says what kind of wash it is', () => {
    expect(washKindWords({ booking_type: 'membership', service_name: 'Car Deep Cleaning' })).toBe('membership');
    expect(washKindWords({ payment_kind: 'free', service_name: 'Car Body Wash' })).toBe('free');
    expect(washKindWords({ campaign_name: 'Navratri', service_name: 'Car Body Wash' })).toBe('free');
    expect(washKindWords({ payment_kind: 'paid', service_name: 'Car Body Wash' })).toBe('car body');
    expect(washKindWords({ payment_kind: 'paid', service_name: 'Bike Wash' })).toBe('bike');
    expect(washKindWords({ payment_kind: 'paid', service_name: 'SUV Deep Cleaning' })).toBe('suv deep cleaning');
  });

  it('writes the first message with the first name, and still reads well with no name or no kind', () => {
    expect(waMessage('Asha Kulkarni', 'car body')).toBe('Hey Asha, this is regarding your car body wash.');
    expect(waMessage('Asha', 'free')).toBe('Hey Asha, this is regarding your free wash.');
    expect(waMessage(null, 'membership')).toBe('Hey there, this is regarding your membership wash.');
    expect(waMessage('  ', '')).toBe('Hey there, this is regarding your wash.');
  });

  it('builds a wa.me link with the message encoded, and none when there is no number', () => {
    const url = waLink('+91 98765 43210', 'Hey Asha, this is regarding your free wash.')!;
    expect(url.startsWith('https://wa.me/919876543210?text=')).toBe(true);
    expect(decodeURIComponent(url.split('text=')[1])).toBe('Hey Asha, this is regarding your free wash.');
    expect(waLink(null, 'x')).toBeNull();
  });
});
