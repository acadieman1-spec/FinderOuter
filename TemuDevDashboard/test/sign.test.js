import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSign, buildSignString, signedBody, verifyWebhook, signWebhook, maskSecret, stringifyParam } from '../server/sign.js';
import { decodeError, isRetryable } from '../server/errorCodes.js';

/**
 * Temu's documentation publishes a worked signature example:
 *   app_secret c7e0a1a63542be4de3cb5488f9fba8149e8fc290
 *   request    bg.logistics.shipment.confirm
 *   expected   4CCF219942D4180C6DDA3CE36C1B838F
 * If this test fails, the signing path is wrong and every request will come
 * back as 3000001 SIGN_UNVALID.
 */
const DOC_SECRET = 'c7e0a1a63542be4de3cb5488f9fba8149e8fc290';
const DOC_EXPECTED = '4CCF219942D4180C6DDA3CE36C1B838F';

test('reproduces the documented signature test vector', () => {
  const params = {
    app_key: 'f9d5cc9313893a20d5aa85c654e8f503',
    data_type: 'JSON',
    access_token: '2nifvmpyymvypwmcms5ct4uqqudrwgpmzbcnmkt1jzjkuaf3x56iixym',
    timestamp: 1711009072,
    type: 'bg.logistics.shipment.confirm',
    sendRequestList: [{
      orderSendInfoList: [{
        quantity: 1,
        orderSn: '211-21905473070712792',
        parentOrderSn: 'PO-211-21905452099192792',
        goodsId: 601099548666279,
        skuId: 17592352673534,
      }],
      carrierId: '699272611',
      trackingNumber: '270324232756',
    }],
    sendType: 0,
  };
  assert.equal(computeSign(DOC_SECRET, params), DOC_EXPECTED);
});

test('nested object key order is preserved, not re-sorted', () => {
  const base = {
    app_key: 'k', data_type: 'JSON', access_token: 't', timestamp: 1, type: 'x', sendType: 0,
  };
  const ordered = [{ carrierId: '1', trackingNumber: '2' }];
  const reordered = [{ trackingNumber: '2', carrierId: '1' }];
  const a = computeSign(DOC_SECRET, { ...base, sendRequestList: ordered });
  const b = computeSign(DOC_SECRET, { ...base, sendRequestList: reordered });
  assert.notEqual(a, b, 'the gateway hashes the serialised fragment verbatim; order matters');
});

test('top-level keys are sorted, so insertion order does not matter', () => {
  const a = computeSign('s', { b: 1, a: 2 });
  const b = computeSign('s', { a: 2, b: 1 });
  assert.equal(a, b);
});

test('sign string is wrapped with app_secret at head and tail', () => {
  const s = buildSignString('SECRET', { b: '2', a: '1' });
  assert.equal(s, 'SECRETa1b2SECRET');
});

test('values serialise the documented way', () => {
  assert.equal(stringifyParam('text'), 'text');
  assert.equal(stringifyParam(12), '12');
  assert.equal(stringifyParam(true), 'true');
  assert.equal(stringifyParam(false), 'false');
  assert.equal(stringifyParam({ a: 1, b: 'x' }), '{"a":1,"b":"x"}');
  assert.equal(stringifyParam([1, 'a']), '[1,"a"]');
  assert.equal(stringifyParam(null), '');
});

test('signedBody attaches common params and the sign, and never leaks the secret', () => {
  const body = signedBody({
    appKey: 'k', accessToken: 't', appSecret: 'S', type: 'bg.order.list.v2.get',
    business: { pageNumber: 1 }, now: 1_700_000_000,
  });
  assert.deepEqual(Object.keys(body).sort(), ['access_token', 'app_key', 'data_type', 'pageNumber', 'sign', 'timestamp', 'type']);
  assert.equal(body.data_type, 'JSON');
  assert.equal(body.timestamp, 1_700_000_000);
  assert.equal(body.sign, computeSign('S', { ...body, sign: undefined }));
  assert.ok(!JSON.stringify(body).includes('"S"'));
});

test('a missing sign throws instead of silently sending an unsigned request', () => {
  assert.throws(() => computeSign('', { a: 1 }), /app_secret is required/);
});

test('webhook HMAC-SHA256 round-trips and rejects tampering', () => {
  const headers = {
    'x-tm-app-key': 'app123',
    'x-tm-event-code': 'bg_order_status_change_event',
    'x-tm-timestamp': '1711009072000',
    'x-tm-ext-param': '',
  };
  const eventData = JSON.stringify({ orderSn: 'PO-211-1', status: 1 });
  const { signature, signString } = signWebhook({ appSecret: 'secret', headers, eventData });

  assert.match(signature, /^[0-9A-F]{64}$/);
  assert.match(signString, /^eventData=.*&x-tm-app-key=app123&x-tm-event-code=.*&x-tm-ext-param=&x-tm-timestamp=/,
    'params sorted ascending and joined with &');

  const good = verifyWebhook({ appSecret: 'secret', headers: { ...headers, 'x-tm-signature': signature }, eventData });
  assert.equal(good.ok, true);

  const tampered = verifyWebhook({
    appSecret: 'secret',
    headers: { ...headers, 'x-tm-signature': signature },
    eventData: JSON.stringify({ orderSn: 'PO-211-999', status: 1 }),
  });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, 'signature mismatch');

  const noSig = verifyWebhook({ appSecret: 'secret', headers, eventData });
  assert.equal(noSig.ok, false);
  assert.match(noSig.reason, /missing x-tm-signature/);

  const wrongSecret = verifyWebhook({ appSecret: 'other', headers: { ...headers, 'x-tm-signature': signature }, eventData });
  assert.equal(wrongSecret.ok, false);
});

test('decodeError explains gateway codes and flags retryable ones', () => {
  const sign = decodeError(3000001, 'SIGN_UNVALID');
  assert.equal(sign.scope, 'gateway');
  assert.match(sign.hint, /app_secret/);
  assert.equal(sign.retryable, false);

  assert.equal(decodeError(4000004, 'RATE_LIMIT_EXCEED_EXCEPTION').retryable, true);
  assert.equal(decodeError(1000000, 'SUCCESS'), null);
  assert.equal(isRetryable(4000000), true);
  assert.equal(isRetryable(3000032), false);

  // endpoint-specific codes fall back to the catalogue message
  const endpoint = decodeError(140020001, '', [{ code: 140020001, message: 'This interface does not support cross-border sellers.' }]);
  assert.equal(endpoint.scope, 'endpoint');
  assert.match(endpoint.meaning, /cross-border/);
});

test('maskSecret keeps only a hint of the value', () => {
  assert.equal(maskSecret('abc'), '•••');
  assert.match(maskSecret('abcdefghijklmnop'), /^abcd…mnop \(16 chars\)$/);
});
