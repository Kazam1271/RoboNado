/**
 * Nado gateway client — queries (reads, unsigned) and executes (writes, signed).
 *
 * The gateway reports failures as HTTP 200 with `status: "failure"` and a
 * numeric `error_code`, so every response has to be inspected rather than
 * trusting the status line. Codes are translated into messages that say what to
 * do about them, because several of the important ones are indistinguishable
 * from a bug in your signing if you only read the raw text.
 */

import { GATEWAY_REST, type Network } from './markets.ts';

/** The subset of Nado's error codes RoboNado can act on. */
export const ERROR_CODES: Record<number, string> = {
  1000: 'RateLimit',
  1004: 'Maintenance',
  2000: 'InvalidPriceIncrement',
  2001: 'InvalidAmountIncrement',
  2003: 'OrderAmountTooSmall',
  2004: 'OrderExpired',
  2006: 'UnhealthyOrder',
  2007: 'OraclePriceDifference',
  2008: 'PostOnlyOrderCrossesBook',
  2011: 'LateRecvExecution',
  2012: 'EarlyRecvExecution',
  2013: 'DigestAlreadyExists',
  2015: 'MarketNotFound',
  2020: 'OrderNotFound',
  2022: 'InvalidNonce',
  2024: 'NoPriorDeposit',
  2028: 'InvalidSigner',
  2031: 'FillOrKillNotFilled',
  2036: 'SubaccountHealthTooLow',
  2118: 'InvalidBuilder',
};

/**
 * Extra context for the codes whose raw message points somewhere unhelpful.
 * These are the ones that cost the most time to diagnose from the text alone.
 */
const HINTS: Record<number, string> = {
  2024:
    'This subaccount has never been funded. Deposit at least $5 USDT0 — the ' +
    'subaccount is created by the deposit, not by any separate registration.',
  2028:
    'Signature did not recover to the sender or a linked signer. On place_order ' +
    'the EIP-712 verifying contract is address(productId), NOT the endpoint — ' +
    'check that first before suspecting the key.',
  2118:
    'Builder ID is unregistered, or the fee rate is outside the bounds ' +
    'configured for it. Verify ROBONADO_BUILDER_ID matches an approved builder.',
  2007:
    'Limit price must sit between 20% and 500% of the oracle price. A price ' +
    'this far out is usually a decimal-scale mistake.',
  2011: 'Order arrived after its recv_time. Widen the nonce recv window.',
  2012: 'recv_time is more than 100s in the future. Narrow the nonce recv window.',
};

export class NadoApiError extends Error {
  code: number;
  codeName: string;
  requestType?: string;

  constructor(code: number, message: string, requestType?: string) {
    const name = ERROR_CODES[code] ?? 'UnknownError';
    const hint = HINTS[code];
    super(`[${code} ${name}] ${message}${hint ? `\n  → ${hint}` : ''}`);
    this.name = 'NadoApiError';
    this.code = code;
    this.codeName = name;
    this.requestType = requestType;
  }
}

interface GatewayResponse<T> {
  status: 'success' | 'failure';
  data?: T;
  error?: string;
  error_code?: number;
  request_type?: string;
}

export class NadoGateway {
  readonly network: Network;
  private readonly base: string;

  constructor(network: Network = 'testnet') {
    this.network = network;
    this.base = `${GATEWAY_REST[network]}/v1`;
  }

  private static unwrap<T>(body: GatewayResponse<T>): T {
    if (body.status === 'failure') {
      throw new NadoApiError(
        body.error_code ?? -1,
        body.error ?? 'no error message',
        body.request_type,
      );
    }
    return body.data as T;
  }

  /**
   * Reads. Unsigned, and cheap enough to poll.
   *
   * Sent as POST with `type` in the body rather than as a query string: the
   * GET form cannot express array parameters — `product_ids` comes back as
   * "invalid type: string, expected a sequence" however it is encoded — and
   * POST accepts every query type, so one path serves all of them.
   */
  async query<T = unknown>(type: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${this.base}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The gateway rejects requests that do not advertise a compression it
        // supports, with a message unrelated to the query itself.
        'Accept-Encoding': 'gzip, deflate, br',
      },
      body: JSON.stringify({ type, ...params }),
    });
    if (!res.ok && res.status !== 200) {
      const text = await res.text().catch(() => '');
      throw new Error(`query ${type} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return NadoGateway.unwrap((await res.json()) as GatewayResponse<T>);
  }

  /** Writes. The payload must already carry a valid signature. */
  async execute<T = unknown>(payload: unknown): Promise<T> {
    const res = await fetch(`${this.base}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok && res.status !== 200) {
      const text = await res.text().catch(() => '');
      throw new Error(`execute failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return NadoGateway.unwrap((await res.json()) as GatewayResponse<T>);
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async subaccountInfo(sender: string): Promise<SubaccountInfo> {
    return this.query<SubaccountInfo>('subaccount_info', { subaccount: sender });
  }

  /** True once the subaccount has been funded and therefore exists on-chain. */
  async subaccountExists(sender: string): Promise<boolean> {
    const info = await this.subaccountInfo(sender);
    return Boolean(info?.exists);
  }

  async marketPrices(productIds: number[]): Promise<MarketPrices> {
    return this.query<MarketPrices>('market_prices', { product_ids: productIds });
  }

  async openOrders(sender: string, productId: number): Promise<OpenOrders> {
    return this.query<OpenOrders>('subaccount_orders', {
      sender,
      product_id: productId,
    });
  }

  // ── Executes ───────────────────────────────────────────────────────────────

  async placeOrder(signedPayload: unknown): Promise<{ digest: string }> {
    return this.execute<{ digest: string }>(signedPayload);
  }

  async cancelOrders(signedPayload: unknown): Promise<unknown> {
    return this.execute(signedPayload);
  }
}

export interface SubaccountInfo {
  exists: boolean;
  subaccount?: string;
  spot_balances?: { product_id: number; balance: { amount: string } }[];
  perp_balances?: { product_id: number; balance: { amount: string } }[];
}

export interface MarketPrices {
  market_prices?: { product_id: number; bid_x18: string; ask_x18: string }[];
}

export interface OpenOrders {
  sender?: string;
  product_id?: number;
  orders?: { digest: string; price_x18: string; amount: string; unfilled_amount: string }[];
}
