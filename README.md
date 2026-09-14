# RoboNado

**An AI trading copilot for every market on [Nado](https://nado.xyz) — one
account, one conversation.**

RoboNado trades all of it — BTC and ETH perps alongside commodities, FX, index
and single-name equities — on Nado's unified spot/perp/margin CLOB on Ink L2,
through plain-language instructions. Not another BTC perp bot with a chat box
on top, and not a bot that stops at the tickers everyone else already covers.

> **Status: pre-alpha.** Every layer — order construction, EIP-712 signing,
> the gateway client, position/health queries, the intent layer, and the
> Telegram interface — is built and tested, and a real order has been placed,
> read back, and cancelled against a live testnet book. Not yet run
> unsupervised or on mainnet. See [Roadmap](#roadmap).

---

## Universal coverage, correctly handled

Run `npm run markets` for the live count, but as of writing Nado lists **82
perpetuals**, and **29 of them — about 35% — are not crypto**:

| Class | Markets |
| --- | --- |
| Crypto | BTC, ETH, SOL, XRP, DOGE, and 50+ more |
| Commodities | Crude oil (WTI), Silver (XAG), Gold (XAUT) |
| FX | EUR/USD, GBP/USD, USD/JPY |
| Indices | S&P 500 (SPY), Nasdaq 100 (QQQ) |
| Equities | NVDA, TSLA, AAPL, MSFT, META, GOOGL, AMZN, AMD, AVGO, MSTR, SpaceX, Circle, and more |

RoboNado trades every one of them from one conversation. That matters because
Nado's margin engine is unified — a trader who wants to short oil, hedge with
silver, and hold TSLA and SOL exposure in the same account needs one bot that
understands the whole account, not four single-purpose ones that each see
their own slice of it.

Most trading bots in the ecosystem stop at BTC and ETH, because the other 29
markets don't play by crypto's rules — get those wrong and orders fail
silently or cost more than they should. RoboNado handles both halves
correctly, in the same copilot.

By default every asset class is tradable; an operator who wants a narrower
mandate sets `ROBONADO_ASSET_CLASSES` (see [.env.example](.env.example)) — to
`commodity,fx,equity`, say, to run a crypto-free deployment.

## Why the non-crypto planes need different code

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
| Crypto | 1bps | 29% |

Run `npm run markets` to see this computed against live data across every
listing, or `npm run markets -- --wedge` to see just the non-crypto planes.

---

## Quick start

Requires **Node 22.6+** (the sources are erasable TypeScript and run directly —
no build step).

```bash
npm install
npm test          # 72 tests
npm run markets   # live trading surface across every asset class, status, fee burden
npm run dry-run   # build + sign real orders against Ink Sepolia, send nothing
```

`dry-run` generates a throwaway key each run and submits nothing. Sample output:

```
── BTC-PERP  (crypto, id 2, live)
   buy 0.01 @ 65000
   appendix   1
              isolated=false builderId=0 fee=0bps (policy 1bps)
   digest     0x6b416fcbe9e919407b2eb7b569f9b59d6743ed3afef38a8f3f5dca1dfaf9cde7
   our fee    0 USDT0 on this order

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
| `src/markets.ts` | Live registry of every Nado market; classifies each into crypto, commodity, fx or equity |
| `src/guards.ts` | Trading-status guard, isolated-margin check, fee policy |
| `src/policy.ts` | Risk limits enforced in code — order size, exposure, leverage, allowed asset classes |
| `src/resolve.ts` | Plain-name → symbol resolution ("gold", "bitcoin", "cable") across every class |
| `src/appendix.ts` | The bit-packed 128-bit order appendix, including builder code |
| `src/signing.ts` | EIP-712 domains, per-product verifying contract, digest, signer |
| `src/subaccount.ts` | bytes32 sender encoding |
| `src/nonce.ts` | 44-bit recv-time / 20-bit random nonce packing |
| `src/units.ts` | x18 fixed-point, increment rounding, side-from-sign |
| `src/order.ts` | Composes the above into a validated, signed order |
| `src/gateway.ts` | REST client — queries, order placement, cancellation |
| `src/positions.ts` | Reads positions and health off the unified margin account |
| `src/tools.ts` | The model's tool surface; `place_order` prepares but never signs |
| `src/agent.ts` | The Claude-driven copilot loop and system prompt |
| `src/bot.ts` / `src/telegram.ts` | Telegram front end — slash commands plus free-text chat |
| `src/config.ts` | Env-driven network and asset-class selection, never a silent default toward mainnet |

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
- [x] Gateway REST client — place, cancel, and read back a resting order
- [x] Position and health queries across the unified margin account
- [x] Natural-language intent layer
- [x] Telegram interface
- [x] Universal coverage — every asset class tradable by default, not just the non-crypto planes
- [x] A first live order placed, read back, and cancelled against a resting testnet book
- [ ] Market-hours pre-open warnings ahead of the weekly FX open, not just the closed-market guard

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
