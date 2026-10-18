import { describe, expect, it } from 'vitest';
import { matchesAll, poolFields, queueFields } from './workerSearch';
import type { PoolWash, WorkerWash } from './types';

const wash = { reference_code: 'WSH-AB12CD', customer_name: 'Asha Kulkarni', customer_phone: '+919876543210', registration_number: 'MH12AB1234', vehicle_make: 'Hyundai', vehicle_model: 'Creta', vehicle_color: 'White', vehicle_type: 'car', society_name: 'Yashwin Orizzonte', building_block: 'B6', flat_number: '602', area_locality: 'Kharadi', parking_location: 'Basement P2', service_name: 'Car Body Wash', membership_reference: null } as unknown as WorkerWash;
const pool = { service_name: 'Bike Wash', vehicle_type: 'bike', vehicle_make: 'Honda', vehicle_model: 'Activa', vehicle_color: 'Red', society_name: 'Amar Residency', building_block: 'C2', area_locality: 'Kharadi', city: 'Pune', parking_location: null } as unknown as PoolWash;

describe('specialist search', () => {
  it('finds a wash of their own by name, plate, phone, building, society or reference, however it is typed', () => {
    const f = queueFields(wash, 'Tomorrow');
    for (const q of ['asha', 'KULKARNI', 'mh12ab1234', 'mh 12 ab 1234', '98765 43210', '9876543210', 'b6', 'yashwin', 'WSH-AB12CD', 'wsh ab12cd', 'creta white', 'basement', 'body wash', 'tomorrow']) {
      expect(matchesAll(q, f), q).toBe(true);
    }
  });

  it('every word must match, and nothing matches nothing; an empty search finds nothing', () => {
    const f = queueFields(wash, 'Tomorrow');
    expect(matchesAll('asha b7', f)).toBe(false);
    expect(matchesAll('zzz', f)).toBe(false);
    expect(matchesAll('', f)).toBe(false);
    expect(matchesAll('   ', f)).toBe(false);
  });

  it('finds an unclaimed wash by what is shown about it, and never by a customer detail it does not carry', () => {
    const f = poolFields(pool, 'Mon, 19 Oct');
    for (const q of ['bike', 'honda activa', 'amar', 'c2', 'kharadi pune', '19 oct']) expect(matchesAll(q, f), q).toBe(true);
    expect(matchesAll('asha', f)).toBe(false);
    expect(matchesAll('9876543210', f)).toBe(false);
  });
});
