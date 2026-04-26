import assert from 'node:assert/strict';

import { sanitizeUsersPayload } from '@/lib/server/userPayload';

function run() {
  const validUsers = sanitizeUsersPayload([
    {
      id: 'user-1',
      name: 'pow',
      handle: 'pow',
      avatar: 'pow',
      tags: [],
      addresses: [
        {
          address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf06',
          name: '#8',
          chain: 'bsc',
        },
      ],
    },
  ]);

  assert.equal(validUsers.length, 1);
  assert.equal(validUsers[0]?.addresses.length, 1);

  assert.throws(
    () =>
      sanitizeUsersPayload([
        {
          id: 'user-1',
          name: 'pow',
          handle: 'pow',
          avatar: 'pow',
          tags: [],
          addresses: [
            {
              address: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf06#pow8',
              name: '#8',
              chain: 'bsc',
            },
          ],
        },
      ]),
    /地址格式无效/
  );

  console.log('tracked user validation tests: ok');
}

run();
