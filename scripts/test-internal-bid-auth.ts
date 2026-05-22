import assert from 'node:assert/strict';

import { NextRequest } from 'next/server';

import './server-only-shim.cjs';

async function run() {
  const env = process.env as Record<string, string | undefined>;
  const previousHmacSecret = env.INTERNAL_BID_HMAC_SECRET;
  const previousHmacSecretPrev = env.INTERNAL_BID_HMAC_SECRET_PREVIOUS;
  const previousAllowedIps = env.INTERNAL_BID_ALLOWED_IPS;
  const previousNodeEnv = env.NODE_ENV;

  const SECRET = 'pili-internal-bid-auth-test-secret-1234567890abcdef';
  env.INTERNAL_BID_HMAC_SECRET = SECRET;
  delete env.INTERNAL_BID_HMAC_SECRET_PREVIOUS;
  delete env.INTERNAL_BID_ALLOWED_IPS;
  env.NODE_ENV = 'test';

  try {
    const auth = await import('@/lib/server/internalBidAuth');

    const makeRequest = (headers: Record<string, string> = {}) =>
      new NextRequest('http://localhost:3005/api/internal/bid/users', { headers });

    const goodToken = auth.signInternalBidToken({ scope: 'internal:bid:read' });
    const goodResult = auth.verifyInternalBidToken(goodToken);
    assert.equal(goodResult.ok, true);
    if (goodResult.ok) {
      assert.equal(goodResult.payload.svc, 'bid');
      assert.equal(goodResult.slot, 'current');
    }

    const expired = auth.signInternalBidToken({
      now: Math.floor(Date.now() / 1000) - 10_000,
      ttlSeconds: 60,
    });
    const expiredResult = auth.verifyInternalBidToken(expired);
    assert.equal(expiredResult.ok, false);
    if (!expiredResult.ok) {
      assert.equal(expiredResult.reason, 'expired');
    }

    process.env.INTERNAL_BID_HMAC_SECRET = 'rotated-secret-32-chars-or-more-abcdefghij';
    process.env.INTERNAL_BID_HMAC_SECRET_PREVIOUS = SECRET;
    auth._resetInternalBidAuthCacheForTest();
    const rotated = auth.verifyInternalBidToken(goodToken);
    assert.equal(rotated.ok, true);
    if (rotated.ok) {
      assert.equal(rotated.slot, 'previous');
    }

    process.env.INTERNAL_BID_HMAC_SECRET = SECRET;
    delete process.env.INTERNAL_BID_HMAC_SECRET_PREVIOUS;
    auth._resetInternalBidAuthCacheForTest();

    const tamperedSig = `${goodToken.split('.')[0]}.AAAAAAAAAAAAAAAA`;
    const tamperedResult = auth.verifyInternalBidToken(tamperedSig);
    assert.equal(tamperedResult.ok, false);

    const fromUnknownIp = auth.checkInternalBidIp(
      makeRequest({ 'x-forwarded-for': '198.51.100.10' })
    );
    assert.equal(fromUnknownIp.ok, true, 'allowlist unconfigured in test env should not block');

    process.env.INTERNAL_BID_ALLOWED_IPS = '10.0.0.0/8, 192.168.1.5';
    auth._resetInternalBidAuthCacheForTest();
    const allowed = auth.checkInternalBidIp(makeRequest({ 'x-forwarded-for': '10.1.2.3' }));
    assert.equal(allowed.ok, true);
    const blocked = auth.checkInternalBidIp(
      makeRequest({ 'x-forwarded-for': '198.51.100.10' })
    );
    assert.equal(blocked.ok, false);
    const exactAllowed = auth.checkInternalBidIp(
      makeRequest({ 'x-forwarded-for': '192.168.1.5' })
    );
    assert.equal(exactAllowed.ok, true);
    delete process.env.INTERNAL_BID_ALLOWED_IPS;
    auth._resetInternalBidAuthCacheForTest();

    env.NODE_ENV = 'production';
    auth._resetInternalBidAuthCacheForTest();
    const prodNoAllowlist = auth.checkInternalBidIp(
      makeRequest({ 'x-forwarded-for': '10.1.2.3' })
    );
    assert.equal(prodNoAllowlist.ok, false);
    if (!prodNoAllowlist.ok) {
      assert.equal(prodNoAllowlist.reason, 'misconfigured');
    }
    env.NODE_ENV = 'test';
    auth._resetInternalBidAuthCacheForTest();

    const noToken = auth.requireInternalBidAuth(makeRequest());
    assert.equal(noToken?.status, 401);
    const badToken = auth.requireInternalBidAuth(
      makeRequest({ authorization: 'Bearer not-a-token' })
    );
    assert.equal(badToken?.status, 401);
    const goodAuth = auth.requireInternalBidAuth(
      makeRequest({ authorization: `Bearer ${auth.signInternalBidToken()}` })
    );
    assert.equal(goodAuth, null);

    console.log('internal bid auth tests: ok');
  } finally {
    if (previousHmacSecret === undefined) {
      delete env.INTERNAL_BID_HMAC_SECRET;
    } else {
      env.INTERNAL_BID_HMAC_SECRET = previousHmacSecret;
    }
    if (previousHmacSecretPrev === undefined) {
      delete env.INTERNAL_BID_HMAC_SECRET_PREVIOUS;
    } else {
      env.INTERNAL_BID_HMAC_SECRET_PREVIOUS = previousHmacSecretPrev;
    }
    if (previousAllowedIps === undefined) {
      delete env.INTERNAL_BID_ALLOWED_IPS;
    } else {
      env.INTERNAL_BID_ALLOWED_IPS = previousAllowedIps;
    }
    if (previousNodeEnv === undefined) {
      delete env.NODE_ENV;
    } else {
      env.NODE_ENV = previousNodeEnv;
    }
  }
}

void run();
