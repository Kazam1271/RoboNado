/**
 * EIP-712 signing for Nado executes.
 *
 * The trap here is the verifying contract. For `place_order` it is NOT the
 * endpoint address — it is `address(productId)`, the 20-byte big-endian
 * rendering of the product id, so every market signs against a different
 * domain. Signing an order against the endpoint yields a perfectly valid
 * signature that the sequencer rejects, and the error does not point at the
 * cause. Every other execute does use the endpoint.
 */

import { hashTypedData, type Account, type TypedDataDomain } from 'viem';

import type { Network } from './markets.ts';

export const DOMAIN_NAME = 'Nado';
export const DOMAIN_VERSION = '0.0.1';

/** From the `contracts` query on each gateway. */
export const CHAIN_ID: Record<Network, number> = {
  mainnet: 57073, // Ink
  testnet: 763373, // Ink Sepolia
};

export const ENDPOINT_ADDRESS: Record<Network, `0x${string}`> = {
  mainnet: '0x05ec92d78ed421f3d3ada77ffde167106565974e',
  testnet: '0x698d87105274292b5673367dec81874ce3633ac2',
};

export const ORDER_TYPES = {
  Order: [
    { name: 'sender', type: 'bytes32' },
    { name: 'priceX18', type: 'int128' },
    { name: 'amount', type: 'int128' },
    { name: 'expiration', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
    { name: 'appendix', type: 'uint128' },
  ],
} as const;

/**
 * The 20-byte big-endian representation of a product id, used as the EIP-712
 * verifying contract when signing an order for that product.
 */
export function orderVerifyingContract(productId: number): `0x${string}` {
  if (!Number.isInteger(productId) || productId < 0 || productId > 0xffffffff) {
    throw new RangeError('productId must be a uint32');
  }
  return `0x${productId.toString(16).padStart(40, '0')}`;
}

export function orderDomain(network: Network, productId: number): TypedDataDomain {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: CHAIN_ID[network],
    verifyingContract: orderVerifyingContract(productId),
  };
}

/** Domain for every execute other than place_order. */
export function endpointDomain(network: Network): TypedDataDomain {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: CHAIN_ID[network],
    verifyingContract: ENDPOINT_ADDRESS[network],
  };
}

/** The signed payload. Field names and order match the Solidity struct. */
export interface OrderMessage {
  sender: `0x${string}`;
  priceX18: bigint;
  amount: bigint;
  expiration: bigint;
  nonce: bigint;
  appendix: bigint;
}

/** The order digest — also the id used to track and cancel the order. */
export function orderDigest(
  network: Network,
  productId: number,
  order: OrderMessage,
): `0x${string}` {
  return hashTypedData({
    domain: orderDomain(network, productId),
    types: ORDER_TYPES,
    primaryType: 'Order',
    message: order,
  });
}

/**
 * Signs an order. `account` may be the subaccount owner or a linked signer;
 * both are cryptographically valid to the sequencer.
 */
export async function signOrder(
  account: Account,
  network: Network,
  productId: number,
  order: OrderMessage,
): Promise<`0x${string}`> {
  if (!account.signTypedData) {
    throw new Error('account cannot sign typed data (is it a JSON-RPC account?)');
  }
  return account.signTypedData({
    domain: orderDomain(network, productId),
    types: ORDER_TYPES,
    primaryType: 'Order',
    message: order,
  });
}

/** Serialises an order for the gateway, which expects decimal strings. */
export function serializeOrder(order: OrderMessage) {
  return {
    sender: order.sender,
    priceX18: order.priceX18.toString(),
    amount: order.amount.toString(),
    expiration: order.expiration.toString(),
    nonce: order.nonce.toString(),
    appendix: order.appendix.toString(),
  };
}

// ── Cancellations ────────────────────────────────────────────────────────────
// Unlike orders, cancellations sign against the endpoint address, not
// address(productId) — one domain covers a cancel spanning several products.

export const CANCELLATION_TYPES = {
  Cancellation: [
    { name: 'sender', type: 'bytes32' },
    { name: 'productIds', type: 'uint32[]' },
    { name: 'digests', type: 'bytes32[]' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

export interface CancellationMessage {
  sender: `0x${string}`;
  productIds: number[];
  digests: `0x${string}`[];
  nonce: bigint;
}

export async function signCancellation(
  account: Account,
  network: Network,
  message: CancellationMessage,
): Promise<`0x${string}`> {
  if (!account.signTypedData) {
    throw new Error('account cannot sign typed data');
  }
  return account.signTypedData({
    domain: endpointDomain(network),
    types: CANCELLATION_TYPES,
    primaryType: 'Cancellation',
    message,
  });
}

export function serializeCancellation(message: CancellationMessage) {
  return {
    sender: message.sender,
    productIds: message.productIds,
    digests: message.digests,
    nonce: message.nonce.toString(),
  };
}
