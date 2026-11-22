import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestRejectedError } from '../_validate.js';
import { isBlockedAddress, resolveCustomEndpoint, type DnsLookupFn } from './_endpoint.js';

function withHostedMode(fn: () => Promise<void>) {
  return async () => {
    const previous = process.env.SHADROX_LOCAL_BACKEND;
    delete process.env.SHADROX_LOCAL_BACKEND;
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env.SHADROX_LOCAL_BACKEND;
      else process.env.SHADROX_LOCAL_BACKEND = previous;
    }
  };
}

test('isBlockedAddress blocks IPv4 private/link-local and hex/dotted IPv6 equivalents', () => {
  assert.equal(isBlockedAddress('127.0.0.1'), true);
  assert.equal(isBlockedAddress('169.254.169.254'), true);
  assert.equal(isBlockedAddress('10.0.0.1'), true);
  assert.equal(isBlockedAddress('172.16.0.1'), true);
  assert.equal(isBlockedAddress('192.168.1.10'), true);
  assert.equal(isBlockedAddress('100.64.0.1'), true);
  assert.equal(isBlockedAddress('::1'), true);
  assert.equal(isBlockedAddress('0:0:0:0:0:0:0:1'), true);
  assert.equal(isBlockedAddress('::'), true);
  assert.equal(isBlockedAddress('fe80::1'), true);
  assert.equal(isBlockedAddress('febf::1'), true);
  assert.equal(isBlockedAddress('fc00::1'), true);
  assert.equal(isBlockedAddress('fd12:3456::1'), true);
  assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:7f00:1'), true);
  assert.equal(isBlockedAddress('0:0:0:0:0:ffff:a9fe:a9fe'), true);

  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('104.26.10.233'), false);
  assert.equal(isBlockedAddress('2606:4700:4700::1111'), false);
});

test(
  'resolveCustomEndpoint rejects DNS-rebinding domains like 169.254.169.254.nip.io in hosted mode',
  withHostedMode(async () => {
    const fakeLookup: DnsLookupFn = async () => [{ address: '169.254.169.254', family: 4 }];
    await assert.rejects(
      () => resolveCustomEndpoint('https://169.254.169.254.nip.io/v1', fakeLookup),
      (err: unknown) =>
        err instanceof RequestRejectedError &&
        err.status === 400 &&
        err.code === 'ENDPOINT_SSRF_BLOCKED'
    );
  })
);

test(
  'resolveCustomEndpoint blocks hostnames if ANY A/AAAA record resolves to a private or loopback IP',
  withHostedMode(async () => {
    const mixedLookup: DnsLookupFn = async () => [
      { address: '104.26.10.233', family: 4 },
      { address: '::ffff:a9fe:a9fe', family: 6 }
    ];
    await assert.rejects(
      () => resolveCustomEndpoint('https://dual-stack-rebind.example/v1', mixedLookup),
      (err: unknown) =>
        err instanceof RequestRejectedError &&
        err.status === 400 &&
        err.code === 'ENDPOINT_SSRF_BLOCKED'
    );
  })
);

test(
  'resolveCustomEndpoint allows public HTTPS endpoints when DNS resolves only public IPs',
  withHostedMode(async () => {
    const publicLookup: DnsLookupFn = async () => [
      { address: '104.18.32.7', family: 4 },
      { address: '2606:4700::6812:2007', family: 6 }
    ];
    const resolved = await resolveCustomEndpoint('https://openrouter.ai/api/v1/', publicLookup);
    assert.equal(resolved, 'https://openrouter.ai/api/v1');
  })
);

test('resolveCustomEndpoint still allows loopback/private URLs when running on the local desktop backend', async () => {
  const previous = process.env.SHADROX_LOCAL_BACKEND;
  process.env.SHADROX_LOCAL_BACKEND = '1';
  try {
    const resolved = await resolveCustomEndpoint('http://127.0.0.1:11434/v1/');
    assert.equal(resolved, 'http://127.0.0.1:11434/v1');
  } finally {
    if (previous === undefined) delete process.env.SHADROX_LOCAL_BACKEND;
    else process.env.SHADROX_LOCAL_BACKEND = previous;
  }
});
