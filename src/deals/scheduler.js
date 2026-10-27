/**
 * Sweep loop for the deals view.
 *
 * Independent of the tracker scheduler in src/scheduler.js -- they share only
 * the browser session (serialised by withPage) and the mailer.
 */
import { sweep } from './catalogue.js';
import { config, daysAgoIso, evaluate } from './baseline.js';
import { sessionStatus } from '../swiggy/api.js';
import {
  dealRows,
  dealCatalogueStats,
  markDealNotified,
  clearDealNotified,
} from '../db.js';
import { sendDealDigest, mailerConfigured } from '../mailer.js';

const MINUTE = 60_000;

let running = false;
let timer = null;

export const state = {
  lastRunAt: null,
  lastError: null,
  lastResult: null,
  sweeping: false,
};

/**
 * Sweep cadence is time-of-day dependent.
 *
 * Instamart's deep discounts are flash sales: observed behaviour is a price
 * collapsing for roughly half an hour and then reverting, often with the stock
 * gone. A 6-hourly sweep catches about 8% of those. To see them at all the
 * sweep has to sample at least twice inside the window, so during the hours
 * when drops actually happen we sweep every 15 minutes, and outside them only
 * often enough to keep baselines fresh.
 */
const IST_OFFSET_MIN = 330; // Asia/Kolkata, no DST

function parseHHMM(v, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

/** Minutes since midnight, in IST. */
function istMinutesNow(now = new Date()) {
  const utc = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (utc + IST_OFFSET_MIN) % 1440;
}

export function rushWindow() {
  return {
    start: parseHHMM(process.env.DEAL_RUSH_START, 8 * 60), // 08:00 IST
    end: parseHHMM(process.env.DEAL_RUSH_END, 22 * 60), // 22:00 IST
  };
}

export function inRushWindow(now = new Date()) {
  const { start, end } = rushWindow();
  const t = istMinutesNow(now);
  // Tolerate a window that wraps past midnight.
  return start <= end ? t >= start && t < end : t >= start || t < end;
}

function offPeakMinutes() {
  const n = Number(process.env.DEAL_SWEEP_INTERVAL_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 360; // 6h
}

function rushMinutes() {
  const n = Number(process.env.DEAL_RUSH_INTERVAL_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

/** The cadence that applies right now. */
export function intervalMinutes(now = new Date()) {
  return inRushWindow(now) ? rushMinutes() : offPeakMinutes();
}

function maxEmails() {
  const n = Number(process.env.DEAL_MAX_EMAILS_PER_SWEEP);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

/** Current deals, computed fresh from the catalogue. */
export function currentDeals() {
  const cfg = config();
  return rows(cfg)
    .map((r) => evaluate(r, cfg))
    .filter((d) => d.isDeal)
    .sort((a, b) => b.percentBelow - a.percentBelow);
}

/** Catalogue rows inside the current baseline window. */
function rows(cfg) {
  return dealRows({
    since: daysAgoIso(cfg.windowDays),
    minObservations: cfg.minObservations,
  });
}

export function status() {
  const cfg = config();
  const stats = dealCatalogueStats({
    since: daysAgoIso(cfg.windowDays),
    minObservations: cfg.minObservations,
  });
  return {
    ...stats,
    ...cfg,
    deals: currentDeals().length,
    lastRunAt: state.lastRunAt,
    lastError: state.lastError,
    lastResult: state.lastResult,
    sweeping: state.sweeping,
    intervalMinutes: intervalMinutes(),
  };
}

/**
 * Decide which deals are new, email them, and keep the latch.
 *
 * Same shape as the tracker latch: notify once when a product crosses below the
 * threshold, and only re-arm once it climbs back above. Without it every sweep
 * would re-send the same deal for as long as the sale lasted.
 */
/**
 * One email per sweep listing every newly-qualifying deal.
 *
 * Previously this sent one mail per product, which meant a sweep finding a
 * dozen drops produced a dozen mails. A single digest is far easier to scan,
 * and with flash sales lasting ~30 minutes what matters is seeing the whole
 * list at once, not receiving them one at a time.
 */
async function notify(deals) {
  if (!mailerConfigured()) return { sent: 0, reason: 'email not configured' };

  const fresh = deals.filter((d) => d.notifiedPrice == null);
  if (!fresh.length) return { sent: 0 };

  // Latch before sending: if the process dies mid-send we would rather miss
  // one alert than re-send it on every sweep after a restart.
  for (const deal of fresh) markDealNotified(deal.variationId, deal.price, deal.baseline);

  try {
    await sendDealDigest(fresh);
    return { sent: 1, deals: fresh.length };
  } catch (err) {
    for (const deal of fresh) clearDealNotified(deal.variationId);
    console.error('[deals] digest failed:', err.message);
    return { sent: 0, error: err.message };
  }
}

/**
 * Email every deal that is live right now, ignoring the latch.
 *
 * Manual action, for when you want the current picture on demand rather than
 * waiting for a sweep to find something new.
 */
export async function emailCurrentDeals() {
  if (!mailerConfigured()) throw new Error('Email is not configured.');
  const deals = currentDeals();
  if (!deals.length) return { sent: 0, deals: 0 };
  await sendDealDigest(deals, { title: 'Deals right now' });
  return { sent: 1, deals: deals.length };
}

/** Re-arm products that have climbed back above the threshold. */
export function rearm(allEvaluated) {
  let cleared = 0;
  for (const d of allEvaluated) {
    if (!d.isDeal && d.notifiedPrice != null) {
      clearDealNotified(d.variationId);
      cleared++;
    }
  }
  return cleared;
}

export async function runSweep() {
  if (running) return { skipped: 'already running' };
  running = true;
  state.sweeping = true;
  state.lastError = null;

  try {
    const session = await sessionStatus();
    if (session.needsLocation) {
      // Sweeping without a delivery location would fill the catalogue with some
      // arbitrary default store's prices, permanently corrupting every baseline.
      state.lastError = 'No delivery location set -- run `npm run login`.';
      console.warn(`[deals] ${state.lastError} Skipping sweep.`);
      return { skipped: 'no location' };
    }

    console.log('[deals] sweeping categories…');
    const result = await sweep({
      onProgress: ({ category, count, error, index, total }) => {
        const label = error ? `error: ${error}` : `${count} products`;
        console.log(`  · [${index + 1}/${total}] ${category}: ${label}`);
      },
    });

    // Evaluate the catalogue once, then split it: the deals drive emails, and
    // the rest drive re-arming. Two passes over the same list, one query.
    const cfg = config();
    const evaluated = rows(cfg).map((r) => evaluate(r, cfg));
    const deals = evaluated
      .filter((d) => d.isDeal)
      .sort((a, b) => b.percentBelow - a.percentBelow);

    const cleared = rearm(evaluated);
    const mail = await notify(deals);

    state.lastResult = {
      ...result,
      deals: deals.length,
      emailed: mail.sent ?? 0,
      rearmed: cleared,
    };
    console.log(
      `[deals] ${result.productsSeen} products, ${deals.length} deal(s), ` +
        `${mail.sent ?? 0} email(s), ${cleared} re-armed, ${result.pruned} pruned`,
    );
    return state.lastResult;
  } catch (err) {
    state.lastError = err.message;
    console.error('[deals] sweep failed:', err.message);
    return { error: err.message };
  } finally {
    state.lastRunAt = new Date().toISOString();
    state.sweeping = false;
    running = false;
  }
}

/**
 * Consecutive sweeps where most categories failed. Swiggy rate-limiting us is
 * the main risk of the faster rush cadence, so back off rather than hammer.
 */
let degraded = 0;

function nextDelayMs() {
  const base = intervalMinutes() * MINUTE;
  // Exponential backoff, capped, while sweeps keep failing.
  return degraded > 0 ? Math.min(base * 2 ** degraded, 60 * MINUTE) : base;
}

function noteResult(result) {
  const errors = result?.errors?.length ?? 0;
  const total = result?.categories ?? 0;
  if (total && errors > total / 2) degraded = Math.min(degraded + 1, 4);
  else degraded = 0;
}

function scheduleNext() {
  const delay = nextDelayMs();
  timer = setTimeout(async () => {
    const result = await runSweep();
    noteResult(result);
    scheduleNext();
  }, delay);
}

export function startDealScheduler() {
  const { start, end } = rushWindow();
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  console.log(
    `[deals] sweeping every ${rushMinutes()}m between ${hhmm(start)}-${hhmm(end)} IST, ` +
      `every ${offPeakMinutes()}m otherwise (now: ${intervalMinutes()}m)`,
  );

  // Offset from the tracker scheduler's 10s so the two don't contend for the
  // browser the moment the server boots.
  setTimeout(async () => {
    const result = await runSweep();
    noteResult(result);
    scheduleNext();
  }, 45_000);

  return () => clearTimeout(timer);
}
