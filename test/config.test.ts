import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveNetwork,
  networkBanner,
  isLive,
  DEFAULT_NETWORK,
  NetworkConfigError,
} from '../src/config.ts';

describe('network resolution', () => {
  test('defaults to testnet when unset or empty', () => {
    assert.equal(resolveNetwork({}), 'testnet');
    assert.equal(resolveNetwork({ NADO_NETWORK: '' }), 'testnet');
    assert.equal(resolveNetwork({ NADO_NETWORK: '   ' }), 'testnet');
    assert.equal(DEFAULT_NETWORK, 'testnet');
  });

  test('accepts both networks, case and whitespace insensitive', () => {
    assert.equal(resolveNetwork({ NADO_NETWORK: 'mainnet' }), 'mainnet');
    assert.equal(resolveNetwork({ NADO_NETWORK: 'MAINNET' }), 'mainnet');
    assert.equal(resolveNetwork({ NADO_NETWORK: ' Testnet ' }), 'testnet');
  });

  test('throws on anything unrecognised rather than falling back', () => {
    // A typo must not quietly resolve to either network — one trades real money.
    for (const value of ['mainet', 'main', 'prod', 'production', 'test']) {
      assert.throws(() => resolveNetwork({ NADO_NETWORK: value }), NetworkConfigError, value);
    }
  });

  test('a typo never silently selects mainnet', () => {
    try {
      resolveNetwork({ NADO_NETWORK: 'mainnett' });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof NetworkConfigError);
      assert.match(err.message, /mainnett/);
    }
  });

  test('mainnet is flagged as live and banners loudly', () => {
    assert.equal(isLive('mainnet'), true);
    assert.equal(isLive('testnet'), false);
    assert.match(networkBanner('mainnet'), /MAINNET — REAL FUNDS/);
    assert.match(networkBanner('testnet'), /Ink Sepolia/);
  });
});
