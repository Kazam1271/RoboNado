/**
 * Estimated FX weekly session — used only to warn ahead of the close and the
 * open, never to gate a trade.
 *
 * guards.ts's `assertTradable`, driven by the venue's live `trading_status`,
 * is the only authoritative signal here; that status only ever tells you
 * what's true *right now*. A trader who opens a position twenty minutes
 * before the weekly close deserves a heads-up first, not just a rejection
 * once the guard has already flipped — and one whose position gets refused
 * on a Sunday deserves to know it reopens in ten minutes, not just that it's
 * closed.
 *
 * The forex week itself is a market convention, not a Nado-specific
 * parameter, and it shifts by up to an hour around daylight saving in New
 * York and Sydney depending on which source you read. This module uses the
 * widely-quoted fixed-UTC approximation — closes Friday 22:00 UTC, reopens
 * Sunday 22:00 UTC — accurate to within an hour year-round. Every string it
 * produces says "about" or "estimate", and every caller must treat
 * `trading_status`, not this module, as the final word on whether an order
 * will actually go through.
 */

import type { AssetClass } from './markets.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const OPEN_DAY_UTC = 0; // Sunday
const CLOSE_DAY_UTC = 5; // Friday
const SESSION_HOUR_UTC = 22;

/** How far ahead of a transition {@link fxSessionNote} starts warning. */
export const FX_WARNING_WINDOW_MS = 2 * HOUR_MS;

export interface FxSessionEstimate {
  /** Whether the weekly session is estimated open right now. */
  open: boolean;
  /** Which transition comes next. */
  next: 'open' | 'close';
  /** Milliseconds from `now` until that transition. Always >= 0. */
  msToTransition: number;
}

/** Midnight UTC of the most recent Sunday at or before `now`. */
function weekStartUtcMs(now: Date): number {
  const dayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dow = new Date(dayMs).getUTCDay();
  return dayMs - dow * DAY_MS;
}

/**
 * Where `now` falls in the estimated weekly FX session. The week is anchored
 * at the most recent Sunday 00:00 UTC, which contains exactly one open
 * boundary (Sunday 22:00 UTC) and one close boundary (Friday 22:00 UTC):
 * closed from week-start until the open, open until the close, closed again
 * from the close until next week's open.
 */
export function estimateFxSession(now: Date = new Date()): FxSessionEstimate {
  const weekStart = weekStartUtcMs(now);
  const openMs = weekStart + OPEN_DAY_UTC * DAY_MS + SESSION_HOUR_UTC * HOUR_MS;
  const closeMs = weekStart + CLOSE_DAY_UTC * DAY_MS + SESSION_HOUR_UTC * HOUR_MS;
  const t = now.getTime();

  if (t < openMs) return { open: false, next: 'open', msToTransition: openMs - t };
  if (t < closeMs) return { open: true, next: 'close', msToTransition: closeMs - t };
  return { open: false, next: 'open', msToTransition: openMs + 7 * DAY_MS - t };
}

/** Renders a millisecond duration as e.g. "1d 3h", "2h 14m", "9m". */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

/**
 * A proactive heads-up for an FX market approaching its weekly close or
 * open, or null when neither is imminent (or the market isn't FX at all).
 * Purely advisory: nothing reads this to decide whether an order is
 * allowed — see guards.ts for that.
 */
export function fxSessionNote(
  market: { assetClass: AssetClass; symbol: string },
  now: Date = new Date(),
): string | null {
  if (market.assetClass !== 'fx') return null;

  const session = estimateFxSession(now);
  if (session.msToTransition > FX_WARNING_WINDOW_MS) return null;

  return session.next === 'close'
    ? `${market.symbol} closes for the weekend in about ${formatDuration(session.msToTransition)} ` +
        `(estimate — trading_status is the final word).`
    : `${market.symbol} reopens in about ${formatDuration(session.msToTransition)} (estimate).`;
}

/**
 * Estimated time until FX reopens, for enriching the closed-market guard's
 * error message with something more useful than "it's closed." Null when
 * the estimate says it's open right now (the live status disagreeing with
 * that is exactly the case this module can't see, so callers should still
 * trust `trading_status` over this).
 */
export function fxReopenEta(now: Date = new Date()): string | null {
  const session = estimateFxSession(now);
  return session.open ? null : formatDuration(session.msToTransition);
}
