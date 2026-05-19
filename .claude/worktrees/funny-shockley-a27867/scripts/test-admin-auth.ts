import assert from 'node:assert/strict';

import { getConfiguredAdminToken, verifyAdminRequest } from '@/lib/server/adminAuth';

interface MockRequest {
  headers: {
    get(name: string): string | null;
  };
}

function createRequest(headers: Record<string, string | undefined>): MockRequest {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      map.set(key.toLowerCase(), value);
    }
  }

  return {
    headers: {
      get(name: string) {
        return map.get(name.toLowerCase()) || null;
      },
    },
  };
}

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.ADMIN_API_TOKEN;
  if (value === undefined) {
    delete process.env.ADMIN_API_TOKEN;
  } else {
    process.env.ADMIN_API_TOKEN = value;
  }

  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.ADMIN_API_TOKEN;
    } else {
      process.env.ADMIN_API_TOKEN = previous;
    }
  }
}

function run() {
  const previousAllowInsecure = process.env.ALLOW_INSECURE_LOCAL_ADMIN;
  process.env.ALLOW_INSECURE_LOCAL_ADMIN = 'false';
  try {
    withEnv(undefined, () => {
      assert.equal(getConfiguredAdminToken(), '');
      const result = verifyAdminRequest(createRequest({}) as never);
      assert.equal(result.ok, false);
      if (result.ok) throw new Error('unexpected ok');
      assert.equal(result.reason, 'missing_admin_token');
    });
  } finally {
    if (previousAllowInsecure === undefined) {
      delete process.env.ALLOW_INSECURE_LOCAL_ADMIN;
    } else {
      process.env.ALLOW_INSECURE_LOCAL_ADMIN = previousAllowInsecure;
    }
  }

  withEnv('secret-token', () => {
    const missing = verifyAdminRequest(createRequest({}) as never);
    assert.equal(missing.ok, false);
    if (missing.ok) throw new Error('unexpected ok');
    assert.equal(missing.reason, 'unauthorized');

    const wrong = verifyAdminRequest(createRequest({ authorization: 'Bearer wrong-token' }) as never);
    assert.equal(wrong.ok, false);
    if (wrong.ok) throw new Error('unexpected ok');
    assert.equal(wrong.reason, 'unauthorized');

    const correctBearer = verifyAdminRequest(createRequest({ authorization: 'Bearer secret-token' }) as never);
    assert.equal(correctBearer.ok, true);

    const correctHeader = verifyAdminRequest(createRequest({ 'x-admin-token': 'secret-token' }) as never);
    assert.equal(correctHeader.ok, true);
  });

  console.log('admin auth tests: ok');
}

run();
