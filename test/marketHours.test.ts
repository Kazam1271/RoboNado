import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateFxSession,
  formatDuration,
  fxReopenEta,
  fxSessionNote,
  FX_WARNING_WINDOW_MS,
} from '../src/marketHours.ts';
import type { AssetClass } from '../src/markets.ts';

// All fixed points land in the same real week: Sun 2026-09-13 through Sat
// 2026-09-19 (UTC). Confirmed against the session's actual clock, which read
// Monday 2026-09-14 18:24 UTC.
const WED_NOON = new Date('2026-09-16T12:00:00.000Z');
const FRI_90MIN_BEFORE_CLOSE = new Date('2026-09-18T20:30:00.000Z');
const FRI_AT_CLOSE = new Date('2026-09-18T22:00:00.000Z');
const FRI_1H_AFTER_CLOSE = new Date('2026-09-18T23:00:00.000Z');
const SUN_1H_BEFORE_OPEN = new Date('2026-09-20T21:00:00.000Z');
const SUN_AT_OPEN = new Date('2026-09-20T22:00:00.000Z');

describe('estimateFxSession', () => {
  test('mid-week is open, counting down to the Friday close', () => {
    const s = estimateFxSession(WED_NOON);
    assert.equal(s.open, true);
    assert.equal(s.next, 'close');
    // Wed 12:00 -> Fri 22:00 is 2 days 10 hours.
    assert.equal(s.msToTransition, (2 * 24 + 10) * 60 * 60 * 1000);
  });

  test('the close instant itself counts as already closed', () => {
    const s = estimateFxSession(FRI_AT_CLOSE);
    assert.equal(s.open, false);
    assert.equal(s.next, 'open');
    // Fri 22:00 -> next Sun 22:00 is 2 days.
    assert.equal(s.msToTransition, 2 * 24 * 60 * 60 * 1000);
  });

  test('shortly after the close, counting down to Sunday reopen', () => {
    const s = estimateFxSession(FRI_1H_AFTER_CLOSE);
    assert.equal(s.open, false);
    assert.equal(s.next, 'open');
    // Fri 23:00 -> Sun 22:00 is 1 day 23 hours.
    assert.equal(s.msToTransition, (1 * 24 + 23) * 60 * 60 * 1000);
  });

  test('the open instant itself counts as already open', () => {
    const s = estimateFxSession(SUN_AT_OPEN);
    assert.equal(s.open, true);
    assert.equal(s.next, 'close');
    // Sun 22:00 -> Fri 22:00 is 5 days.
    assert.equal(s.msToTransition, 5 * 24 * 60 * 60 * 1000);
  });
});

describe('formatDuration', () => {
  test('renders minutes only under an hour', () => {
    assert.equal(formatDuration(45 * 60_000), '45m');
    assert.equal(formatDuration(0), '0m');
  });

  test('renders hours and minutes under a day', () => {
    assert.equal(formatDuration(90 * 60_000), '1h 30m');
  });

  test('renders days, hours and minutes past a day', () => {
    assert.equal(formatDuration((2 * 24 + 3) * 60 * 60_000), '2d 3h 0m');
  });

  test('never goes negative', () => {
    assert.equal(formatDuration(-5000), '0m');
  });
});

const fx = (symbol = 'EURUSD-PERP') => ({ assetClass: 'fx' as AssetClass, symbol });
const commodity = (symbol = 'WTI-PERP') => ({ assetClass: 'commodity' as AssetClass, symbol });

describe('fxSessionNote', () => {
  test('is null for a non-fx market at any time, including right at the close', () => {
    assert.equal(fxSessionNote(commodity(), FRI_90MIN_BEFORE_CLOSE), null);
  });

  test('is null mid-week, far from either transition', () => {
    assert.equal(fxSessionNote(fx(), WED_NOON), null);
  });

  test('warns ahead of the weekend close, inside the window', () => {
    const note = fxSessionNote(fx('EURUSD-PERP'), FRI_90MIN_BEFORE_CLOSE);
    assert.match(note!, /EURUSD-PERP closes for the weekend in about 1h 30m/);
    assert.match(note!, /estimate/);
  });

  test('fires right at the edge of the warning window, inclusive', () => {
    const atEdge = new Date(FRI_AT_CLOSE.getTime() - FX_WARNING_WINDOW_MS);
    assert.notEqual(fxSessionNote(fx(), atEdge), null);

    const justOutside = new Date(atEdge.getTime() - 1);
    assert.equal(fxSessionNote(fx(), justOutside), null);
  });

  test('is null once closed but far from reopening', () => {
    assert.equal(fxSessionNote(fx(), FRI_1H_AFTER_CLOSE), null);
  });

  test('warns ahead of the weekly reopen, inside the window', () => {
    const note = fxSessionNote(fx('GBPUSD-PERP'), SUN_1H_BEFORE_OPEN);
    assert.match(note!, /GBPUSD-PERP reopens in about 1h 0m/);
  });
});

describe('fxReopenEta', () => {
  test('is null while the estimate says the session is open', () => {
    assert.equal(fxReopenEta(WED_NOON), null);
  });

  test('matches the session estimate once closed', () => {
    assert.equal(fxReopenEta(FRI_1H_AFTER_CLOSE), formatDuration(estimateFxSession(FRI_1H_AFTER_CLOSE).msToTransition));
  });
});
