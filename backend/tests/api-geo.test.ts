/** "Use my current location" on the address form: coordinates in, a best guess at the society and area out (nothing stored). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, boot, customerWithVehicle, expectOk, fake, shutdown } from './helpers';

beforeAll(boot);
afterAll(shutdown);

describe('reverse lookup', () => {
  it('is for signed-in people only, and refuses nonsense coordinates', async () => {
    expect((await new Client().get('/api/geo/reverse?lat=18.55&lon=73.94')).status).toBe(401);
    const c = await customerWithVehicle();
    expect((await c.c.get('/api/geo/reverse')).status).toBe(400);
    expect((await c.c.get('/api/geo/reverse?lat=999&lon=73.9')).status).toBe(400);
    expect((await c.c.get('/api/geo/reverse?lat=abc&lon=73.9')).status).toBe(400);
  });

  it('finds the society, area, city and pincode near a known place', async () => {
    const c = await customerWithVehicle();
    const r = expectOk(await c.c.get('/api/geo/reverse?lat=18.5515&lon=73.9402'));
    expect(r.body.place).toEqual({ society: 'Yashwin Orizzonte Phase 1', area: 'Kharadi', city: 'Pune', pincode: '411014', road: 'EON Road', label: 'Yashwin Orizzonte, Kharadi, Pune' });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('gives only what it knows: a road in another area has no society, and a spaced pincode is tidied', async () => {
    const c = await customerWithVehicle();
    const r = expectOk(await c.c.get('/api/geo/reverse?lat=18.5000&lon=73.9000')).body.place;
    expect(r).toMatchObject({ society: null, area: 'Hadapsar', city: 'Pune', pincode: '411028', road: 'Some Road' });
  });

  it('asks OpenStreetMap once for the same spot, and says so plainly when it is down', async () => {
    const c = await customerWithVehicle();
    const before = fake.geoCalls();
    expectOk(await c.c.get('/api/geo/reverse?lat=18.5516&lon=73.9403'));
    expectOk(await c.c.get('/api/geo/reverse?lat=18.5516&lon=73.9403'));
    expect(fake.geoCalls() - before).toBe(1);
    fake.failNextGeocode();
    const down = await c.c.get('/api/geo/reverse?lat=18.4400&lon=73.8000');
    expect(down.status).toBe(502);
    expect(down.body.message).toMatch(/type your society/);
  });
});

describe('picking the useful parts', () => {
  it('prefers a residential name, then a building, and ignores the generic "yes"', async () => {
    // imported after boot(): the server's configuration is read from the environment the first time it is loaded
    const { toPlace } = await import('../src/geocode');
    expect(toPlace({ address: { residential: 'Park Street Homes', building: 'Block A' } }).society).toBe('Park Street Homes');
    expect(toPlace({ address: { building: 'yes', road: 'X' } }).society).toBeNull();
    expect(toPlace({ name: 'Sai Heights', category: 'building', address: { building: 'yes' } }).society).toBe('Sai Heights');
    expect(toPlace({ name: 'A Cafe', category: 'amenity', address: {} }).society).toBeNull();
    expect(toPlace({ address: { postcode: '41101' } }).pincode).toBeNull();
  });
});
