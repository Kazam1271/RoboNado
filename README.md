# RoboNado

**An AI trading copilot for the markets other Nado bots ignore.**

RoboNado trades commodities, FX, and equities on [Nado](https://nado.xyz) — the
unified spot/perp/margin CLOB on Ink L2 — through plain-language instructions.
Not another BTC perp bot with a chat box on top.

> **Status: pre-alpha.** The order construction and EIP-712 signing layer is
> complete and tested. No orders have been placed against a live book yet. See
> [Roadmap](#roadmap).

---

## Why these markets

Nado lists **29 non-crypto perpetuals — 39% of its perp book**:

| Class | Markets |
| --- | --- |
| Commodities | Crude oil (WTI), Silver (XAG), Gold (XAUT) |
| FX | EUR/USD, GBP/USD, USD/JPY |
| Indices | S&P 500 (SPY), Nasdaq 100 (QQQ) |
| Equities | NVDA, TSLA, AAPL, MSFT, META, GOOGL, AMZN, AMD, AVGO, MSTR, SpaceX, Circle, and more |

Every trading bot in the ecosystem points at BTC and ETH. Meanwhile a trader who
wants to short oil, hedge with silver, and hold TSLA exposure in the same margin
account has no tooling at all — despite Nado's unified margin engine being the
only place that portfolio can exist as *one* account.

That is the gap RoboNado fills.

## Why these markets need different code

Non-crypto markets are not crypto markets with different tickers. Three
differences break any bot that assumes otherwise:

**They close.** FX follows real market hours. Outside them the venue reports
`soft_reduce_only` and refuses to open positions. A crypto-native bot surfaces a
bare error code; RoboNado says *"FX is closed until the weekly open — but I can
still close your existing EUR position."*

**FX is isolated-margin only.** `isolated_only: true` on all three pairs. An
order that doesn't set the isolated bit and pack margin into the appendix's
value bits is rejected 100% of the time.

**Fee economics invert.** Nado's taker fee on FX is **0.7bps** against **3.5bps**
elsewhere. The 1bps builder fee from Nado's own integration example would be
**143% of the venue's own fee** — you'd more than double the cost of trading FX.
RoboNado tiers its builder fee by asset class so the burden stays near-constant:

| Class | Our fee | Share of venue taker fee |
| --- | --- | --- |
| FX | 0.2bps | 29% |
| Commodity | 1bps | 29% |
| Equity | 1bps | 29% |

Run `npm run markets` to see this computed against live mainnet data.

---

## Quick start

Requires **Node 22.6+** (the sources are erasable TypeScript and run directly —
no build step).

```bash
npm install
npm test          # 33 tests
npm run markets   # live non-crypto surface, status, fee burden
npm run dry-run   # build + sign real orders against Ink Sepolia, send nothing
```

`dry-run` generates a throwaway key each run and submits nothing. Sample output:

```
── WTI-PERP  (commodity, id 90, live)
   buy 100 @ 58
   appendix   3689348814753735021000917249
              isolated=true builderId=42 fee=1bps (policy 1bps)
   digest     0x9067c7c79b12aa2e6baf6c6dc67136c1eb348d31534b6aa43fa9b0e7ac3e38a6
   our fee    0.580000 USDT0 on this order

── EURUSD-PERP  (fx, id 92, soft_reduce_only)
   blocked by guard: EURUSD-PERP is closed for new positions — FX follows
   real market hours and is reduce-only outside them.
```

### Trading for real

Orders need a funded subaccount. On testnet both inputs are free:

1. Mint testnet USDT0 at [testnet.nado.xyz/portfolio/faucet](https://testnet.nado.xyz/portfolio/faucet) — **at least $5**, or the subaccount is never created
2. Get Ink Sepolia ETH for gas from [Ink's faucets](https://docs.inkonchain.com/tools/faucets)

---

## Architecture

| Module | Responsibility |
| --- | --- |
| `src/markets.ts` | Live market registry; classifies the non-crypto planes |
| `src/guards.ts` | Trading-status guard, isolated-margin check, fee policy |
| `src/appendix.ts` | The bit-packed 128-bit order appendix, including builder code |
| `src/signing.ts` | EIP-712 domains, per-product verifying contract, digest, signer |
| `src/subaccount.ts` | bytes32 sender encoding |
| `src/nonce.ts` | 44-bit recv-time / 20-bit random nonce packing |
| `src/units.ts` | x18 fixed-point, increment rounding, side-from-sign |
| `src/order.ts` | Composes the above into a validated, signed order |

### Three decisions worth explaining

**The verifying contract is per-product.** Nado signs `place_order` against
`address(productId)` — the 20-byte rendering of the product id — not the
endpoint address. Every market has a different EIP-712 domain. Signing against
the endpoint produces a structurally valid signature the sequencer rejects, with
an error that doesn't name the cause. Tests assert that a signature for WTI does
not verify as EURUSD, and that a testnet signature does not verify on mainnet.

**Market config is read live, never hardcoded.** `isolated_only` genuinely
differs between networks: WTI, XAG, SPY, QQQ, NVDA, TSLA and AAPL are
isolated-only on testnet but cross-margin on mainnet. Config copied from testnet
would build every one of those orders wrong in production.

**No floating point past the parse.** Prices and sizes are x18 integers. A
decimal slip is not a rounding error, it is a factor of ten — a limit buy placed
10× above market fills instantly against the whole book. All conversion goes
through `units.ts` on strings, and `bigint` from there down.

---

## Roadmap

- [x] Market registry, asset-class classification, fee policy
- [x] Order appendix encoding with builder codes
- [x] EIP-712 signing, subaccount encoding, nonce packing
- [ ] Gateway REST/WS client — place, cancel, and read back a resting order
- [ ] Position and health queries across the unified margin account
- [ ] Natural-language intent layer
- [ ] Market-hours awareness: pre-open warnings, weekly FX open/close
- [ ] Telegram interface

## Builder codes

RoboNado is built to run as a registered Nado builder. Attribution is a single
config value (`ROBONADO_BUILDER_ID`); with it unset, orders are placed
unattributed and **no fee is charged to anyone**. Fee rates come from asset-class
policy in `guards.ts` rather than per-call arguments, so a market's rate cannot
drift by accident.

## Security

- Never commit a private key. `.env` and `*.key` are gitignored.
- `dry-run` uses an ephemeral generated key and submits nothing.
- Linked signers are supported by design: the signing layer accepts any viem
  `Account`, so a trading-only key can sign while the funding wallet stays cold.

## License

MIT
