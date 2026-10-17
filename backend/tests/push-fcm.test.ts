/**
 * The Firebase Cloud Messaging sender (backend/src/push.ts) against a local stand-in for Google's token endpoint and FCM's send endpoint: the service-account key is turned into a
 * correctly signed request for an access token, the message has the shape Android needs, phones that are gone are told apart from failures, and the access token is kept and renewed.
 * No database and no real Firebase: nothing here leaves this computer.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fcmTransport, readServiceAccount, type PushMessage, type ServiceAccount } from '../src/push';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });

let server: http.Server;
let base = '';
let tokenCalls = 0;
let assertions: string[] = [];
let sent: { auth: string; message: any }[] = [];
let issued = 0;
let expireNextSend = false;

const sa = (): ServiceAccount => ({ project_id: 'washo-test', client_email: 'push@washo-test.iam.gserviceaccount.com', private_key: privateKey, token_uri: `${base}/token` });
const msg = (token: string, extra: Partial<PushMessage> = {}): PushMessage => ({ token, title: 'Free foam wash today', body: 'Book before 6 pm.', data: { notification_id: 'n-1', category: 'announcement' }, ...extra });

const readBody = (req: http.IncomingMessage) => new Promise<string>((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const json = (status: number, v: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.url === '/token') {
      tokenCalls++;
      const form = new URLSearchParams(body);
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return json(400, { error: 'unsupported_grant_type' });
      assertions.push(form.get('assertion') ?? '');
      issued++;
      return json(200, { access_token: `at-${issued}`, expires_in: 3600, token_type: 'Bearer' });
    }
    const m = /^\/v1\/projects\/([^/]+)\/messages:send$/.exec(req.url ?? '');
    if (!m || m[1] !== 'washo-test') return json(404, { error: { status: 'NOT_FOUND', message: 'no such project' } });
    if (expireNextSend) { expireNextSend = false; return json(401, { error: { status: 'UNAUTHENTICATED' } }); }
    const message = JSON.parse(body).message;
    sent.push({ auth: String(req.headers.authorization), message });
    const t: string = message.token;
    if (t.startsWith('dead-')) return json(404, { error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } });
    if (t.startsWith('bad-')) return json(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token' } });
    if (t.startsWith('boom-')) return json(500, { error: { status: 'INTERNAL' } });
    return json(200, { name: `projects/washo-test/messages/${crypto.randomUUID()}` });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { tokenCalls = 0; assertions = []; sent = []; issued = 0; expireNextSend = false; });

describe('the Firebase sender', () => {
  it('asks for its access token with a correctly signed service-account request, and sends the message in the shape Android needs', async () => {
    const send = fcmTransport(sa(), base);
    expect(await send([msg('good-token-0000000000000001')])).toEqual(['sent']);

    // the signed request: RS256, from the service account, for the messaging scope, to the token endpoint, valid for an hour
    const [h, p, s] = assertions[0].split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims).toMatchObject({ iss: 'push@washo-test.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: `${base}/token` });
    expect(claims.exp - claims.iat).toBe(3600);
    expect(crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0].auth).toBe('Bearer at-1');
    expect(sent[0].message).toEqual({
      token: 'good-token-0000000000000001',
      notification: { title: 'Free foam wash today', body: 'Book before 6 pm.' },
      data: { notification_id: 'n-1', category: 'announcement' },
      android: { priority: 'HIGH', ttl: '86400s', notification: { channel_id: 'washo' } },
    });
  });

  it('tells a phone that is gone (remove its token) from a failure (try again later), keeping the order of the messages', async () => {
    const send = fcmTransport(sa(), base);
    const tokens = ['good-token-0000000000000001', 'dead-token-0000000000000001', 'bad-token-00000000000000001', 'boom-token-0000000000000001', 'good-token-0000000000000002'];
    expect(await send(tokens.map((t) => msg(t)))).toEqual(['sent', 'dead', 'dead', 'failed', 'sent']);
  });

  it('keeps its access token between sends, and signs in again once if Firebase refuses it', async () => {
    const send = fcmTransport(sa(), base);
    await send([msg('good-token-0000000000000001')]);
    await send([msg('good-token-0000000000000002'), msg('good-token-0000000000000003')]);
    expect(tokenCalls).toBe(1);

    expireNextSend = true;
    expect(await send([msg('good-token-0000000000000004')])).toEqual(['sent']);
    expect(tokenCalls).toBe(2);
    expect(sent[sent.length - 1].auth).toBe('Bearer at-2');
  });

  it('reports failures, not exceptions, when Firebase cannot be reached or refuses to sign in', async () => {
    expect(await fcmTransport({ ...sa(), token_uri: 'http://127.0.0.1:1/token' }, base)([msg('good-token-0000000000000001')])).toEqual(['failed']);
    expect(await fcmTransport(sa(), 'http://127.0.0.1:1')([msg('good-token-0000000000000001')])).toEqual(['failed']);
    expect(await fcmTransport({ ...sa(), project_id: 'some-other-project' }, base)([msg('good-token-0000000000000001')])).toEqual(['dead']); // (the stand-in answers 404 for an unknown project)
  });

  it('sends a long list a few at a time and answers every one', async () => {
    const send = fcmTransport(sa(), base);
    const many = Array.from({ length: 120 }, (_, i) => msg(`${i % 10 === 0 ? 'dead' : 'good'}-token-${String(i).padStart(18, '0')}`));
    const out = await send(many);
    expect(out).toHaveLength(120);
    expect(out.filter((r) => r === 'dead')).toHaveLength(12);
    expect(out.filter((r) => r === 'sent')).toHaveLength(108);
    expect(tokenCalls).toBe(1);
  });
});

describe('reading the service-account key from the environment', () => {
  const json = JSON.stringify({ type: 'service_account', project_id: 'washo-test', client_email: 'push@washo-test.iam.gserviceaccount.com', private_key: privateKey });
  const none = { serviceAccountJson: '', serviceAccountFile: '', fcmBase: '' };

  it('takes the JSON itself, the JSON base64-encoded (easier to paste into Render), or a file', () => {
    expect(readServiceAccount({ ...none, serviceAccountJson: json })?.project_id).toBe('washo-test');
    expect(readServiceAccount({ ...none, serviceAccountJson: Buffer.from(json).toString('base64') })?.client_email).toBe('push@washo-test.iam.gserviceaccount.com');
    const file = path.join(os.tmpdir(), `washo-sa-${process.pid}.json`);
    fs.writeFileSync(file, json);
    try {
      expect(readServiceAccount({ ...none, serviceAccountFile: file })?.private_key).toBe(privateKey);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('is null (push is simply off) when nothing is set or the key is unusable', () => {
    expect(readServiceAccount(none)).toBeNull();
    expect(readServiceAccount({ ...none, serviceAccountJson: 'not json at all' })).toBeNull();
    expect(readServiceAccount({ ...none, serviceAccountJson: JSON.stringify({ project_id: 'x' }) })).toBeNull();
    expect(readServiceAccount({ ...none, serviceAccountFile: '/definitely/not/here.json' })).toBeNull();
  });
});
