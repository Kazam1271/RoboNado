import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';

import {
  orderVerifyingContract,
  orderDomain,
  endpointDomain,
  orderDigest,
  signOrder,
  serializeOrder,
  ORDER_TYPES,
  CHAIN_ID,
  ENDPOINT_ADDRESS,
  type OrderMessage,
} from '../src/signing.ts';
import { toSubaccountHex, fromSubaccountHex } from '../src/subaccount.ts';
import { packOrderNonce, unpackOrderNonce, buildOrderNonce } from '../src/nonce.ts';
import { toX18, fromX18, roundToIncrement, signedAmount, sideOf } from '../src/units.ts';

// Anvil/Hardhat account #0. This key is published in their documentation and
// holds nothing anywhere; it is used here only so signature recovery is
// deterministic and reviewable.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const account = privateKeyToAccount(TEST_KEY);

describe('subaccount encoding', () => {
  test('matches the sender from the Nado place-order example', () => {
    // Docs example: sender for wallet 0x7a5e… with subaccount name "test0".
    const expected = '0x7a5ec2748e9065794491a8d29dcf3f9edb8d7c43746573743000000000000000';
    assert.equal(toSubaccountHex('0x7a5ec2748e9065794491a8d29dcf3f9edb8d7c43', 'test0'), expected);
  });

  test('encodes "default" as 7 bytes plus 5 of padding', () => {
    const hex = toSubaccountHex('0x7a5ec2748e9065794491a8d29dcf3f9edb8d7c43');
    assert.equal(hex.slice(42), '64656661756c740000000000');
    assert.equal(hex.length, 66); // 0x + 64
  });

  test('round-trips owner and name', () => {
    const hex = toSubaccountHex(account.address, 'robonado');
    const back = fromSubaccountHex(hex);
    assert.equal(back.owner.toLowerCase(), account.address.toLowerCase());
    assert.equal(back.name, 'robonado');
  });

  test('rejects a name that overflows the 12-byte field', () => {
    assert.throws(() => toSubaccountHex(account.address, 'thirteenchars'), RangeError);
  });
});

describe('verifying contract', () => {
  test('renders a product id as a 20-byte address', () => {
    // The docs give product 18 explicitly.
    assert.equal(orderVerifyingContract(18), '0x0000000000000000000000000000000000000012');
    assert.equal(orderVerifyingContract(90), '0x000000000000000000000000000000000000005a');
  });

  test('order domains differ per product — the whole point of the trap', () => {
    const wti = orderDomain('testnet', 90);
    const eur = orderDomain('testnet', 92);
    assert.notEqual(wti.verifyingContract, eur.verifyingContract);
    assert.equal(wti.chainId, CHAIN_ID.testnet);
  });

  test('order domain is never the endpoint address', () => {
    const domain = orderDomain('testnet', 90);
    assert.notEqual(
      domain.verifyingContract?.toLowerCase(),
      ENDPOINT_ADDRESS.testnet.toLowerCase(),
    );
    assert.equal(
      endpointDomain('testnet').verifyingContract?.toLowerCase(),
      ENDPOINT_ADDRESS.testnet.toLowerCase(),
    );
  });
});

describe('order signing', () => {
  const message: OrderMessage = {
    sender: toSubaccountHex(account.address),
    priceX18: toX18('64000'),
    amount: toX18('0.5'),
    expiration: 4294967295n,
    nonce: packOrderNonce({ recvTimeMs: 1757062078359n, random: 1000 }),
    appendix: 1n,
  };

  test('signature recovers to the signing account', async () => {
    const signature = await signOrder(account, 'testnet', 90, message);
    const valid = await verifyTypedData({
      address: account.address,
      domain: orderDomain('testnet', 90),
      types: ORDER_TYPES,
      primaryType: 'Order',
      message,
      signature,
    });
    assert.ok(valid);
  });

  test('a signature does not verify against the wrong product', async () => {
    const signature = await signOrder(account, 'testnet', 90, message);
    const valid = await verifyTypedData({
      address: account.address,
      domain: orderDomain('testnet', 92), // signed for WTI, checked as EURUSD
      types: ORDER_TYPES,
      primaryType: 'Order',
      message,
      signature,
    });
    assert.equal(valid, false, 'cross-product replay must not verify');
  });

  test('a signature does not verify across networks', async () => {
    const signature = await signOrder(account, 'testnet', 90, message);
    const valid = await verifyTypedData({
      address: account.address,
      domain: orderDomain('mainnet', 90),
      types: ORDER_TYPES,
      primaryType: 'Order',
      message,
      signature,
    });
    assert.equal(valid, false, 'testnet orders must not be replayable on mainnet');
  });

  test('digest is stable and 32 bytes', () => {
    const a = orderDigest('testnet', 90, message);
    const b = orderDigest('testnet', 90, message);
    assert.equal(a, b);
    assert.match(a, /^0x[0-9a-f]{64}$/);
  });

  test('serialises every numeric field as a decimal string', () => {
    const wire = serializeOrder(message);
    for (const [key, value] of Object.entries(wire)) {
      if (key === 'sender') continue;
      assert.equal(typeof value, 'string', `${key} must be a string`);
      assert.match(value as string, /^-?\d+$/);
    }
  });
});

describe('order nonce', () => {
  test('round-trips both halves', () => {
    const nonce = packOrderNonce({ recvTimeMs: 1757062078359n, random: 1000 });
    assert.deepEqual(unpackOrderNonce(nonce), { recvTimeMs: 1757062078359n, random: 1000 });
  });

  test('matches the documented construction', () => {
    // Docs: ((timestamp_ms() + 50) << 20) + 1000
    const now = 1757062078359;
    const expected = (BigInt(now + 50) << 20n) + 1000n;
    assert.equal(packOrderNonce({ recvTimeMs: BigInt(now + 50), random: 1000 }), expected);
  });

  test('generated nonces carry the recv window and fit in uint64', () => {
    const now = Date.now();
    const nonce = buildOrderNonce(50, now);
    assert.equal(unpackOrderNonce(nonce).recvTimeMs, BigInt(now + 50));
    assert.ok(nonce < 1n << 64n);
  });
});

describe('fixed-point units', () => {
  test('converts decimal strings to x18 exactly', () => {
    assert.equal(toX18('1'), 10n ** 18n);
    assert.equal(toX18('0.1'), 100000000000000000n);
    assert.equal(toX18('64123.5'), 64123500000000000000000n);
    assert.equal(toX18('-2.5'), -2500000000000000000n);
  });

  test('survives values past float precision', () => {
    assert.equal(toX18('123456789.123456789012345678'), 123456789123456789012345678n);
  });

  test('fromX18 inverts toX18', () => {
    for (const v of ['1', '0.1', '64123.5', '0.00000001']) {
      assert.equal(fromX18(toX18(v)), v);
    }
  });

  test('rejects a value finer than 18 decimals', () => {
    assert.throws(() => toX18('0.0000000000000000001'), RangeError);
  });

  test('rounds size toward zero on both sides', () => {
    const inc = toX18('0.02');
    assert.equal(roundToIncrement(toX18('0.05'), inc), toX18('0.04'));
    assert.equal(roundToIncrement(toX18('-0.05'), inc), toX18('-0.04'));
  });

  test('side is carried by the sign of amount', () => {
    assert.equal(signedAmount('buy', toX18('2')), toX18('2'));
    assert.equal(signedAmount('sell', toX18('2')), toX18('-2'));
    assert.equal(sideOf(toX18('2')), 'buy');
    assert.equal(sideOf(toX18('-2')), 'sell');
    assert.throws(() => sideOf(0n), /no side/);
  });
});
