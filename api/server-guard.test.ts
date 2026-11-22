import assert from 'node:assert/strict';
import test from 'node:test';

import { isTrustedApiRequest } from '../server';

test('isTrustedApiRequest accepts same-origin and shadrox-app packaged origin requests', () => {
  assert.equal(
    isTrustedApiRequest(
      { host: '127.0.0.1:43121', origin: 'shadrox-app://localhost' },
      { enforceLoopbackHost: true }
    ),
    true
  );
  assert.equal(
    isTrustedApiRequest(
      { host: 'localhost:3000', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' },
      { enforceLoopbackHost: true }
    ),
    true
  );
  assert.equal(
    isTrustedApiRequest(
      { host: '127.0.0.1:43121' },
      { enforceLoopbackHost: true }
    ),
    true
  );
});

test('isTrustedApiRequest blocks cross-site origins, null origins, and DNS rebinding hosts', () => {
  assert.equal(
    isTrustedApiRequest(
      { host: '127.0.0.1:43121', origin: 'https://evil.com' },
      { enforceLoopbackHost: true }
    ),
    false
  );
  assert.equal(
    isTrustedApiRequest(
      { host: '127.0.0.1:43121', origin: 'null' },
      { enforceLoopbackHost: true }
    ),
    false
  );
  assert.equal(
    isTrustedApiRequest(
      { host: '127.0.0.1:43121', 'sec-fetch-site': 'cross-site' },
      { enforceLoopbackHost: true }
    ),
    false
  );
  assert.equal(
    isTrustedApiRequest(
      { host: 'rebind.evil.com:43121', origin: 'http://rebind.evil.com:43121' },
      { enforceLoopbackHost: true }
    ),
    false
  );
});
