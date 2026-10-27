import { fetchPrice, sessionStatus } from './swiggy/api.js';
import {
  activeTrackers,
  getTracker,
  recordCheck,
  markNotified,
  clearNotified,
  getState,
  setState,
  trackerBaseline,
} from './db.js';
import { daysAgoIso } from './deals/baseline.js';
import { sendDropAlert, sendSessionStaleAlert, mailerConfigured } from './mailer.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let running = false;
let timer = null;

export const state = {
  lastRunAt: null,
  lastError: null,
  session: { ok: null, needsLocation: null, address: null, storeId: null },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Small random gap between products so we don't look like a burst of traffic.
const jitter = () => sleep(2000 + Math.random() * 2000);

/**
 * Decide whether this observation should fire an email, and keep the latch.
 *
 * The latch is the whole point: without it a product sitting below target would
 * email on every single cycle. We notify once when the price crosses down, and
 * only re-arm once it goes back above the target.
 */
function dropRatio() {
  const n = Number(process.env.TRACKER_DROP_RATIO);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.6;
}

function dropMinObservations() {
  const n = Number(process.env.TRACKER_MIN_OBSERVATIONS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

/**
 * Why a tracker should alert, or null.
 *
 * Two independent triggers:
 *   target -- price at or below the figure you set. Absolute, always active.
 *   drop   -- price far below what this product *usually* costs, from its own
 *             price_history. Catches the case an absolute target cannot: a
 *             Rs800 product halving to Rs400 never crosses a Rs60 target, but
 *             is obviously worth knowing about.
 *
 * Either is sufficient. They share one latch, so a price that satisfies both
 * still sends a single email.
 */
export function alertReason(tracker, current) {
  if (!current.inStock) return null;

  const { baseline, observations } = trackerBaseline(tracker.id, {
    since: daysAgoIso(30),
    minObservations: dropMinObservations(),
  });

  const ratio = dropRatio();
  const threshold = baseline ? ratio * baseline : null;
  const byTarget = current.price <= tracker.target_price;
  const byDrop = threshold != null && current.price < threshold;

  if (!byTarget && !byDrop) return null;

  return {
    kind: byTarget && byDrop ? 'both' : byTarget ? 'target' : 'drop',
    baseline,
    observations,
    percentBelow: baseline ? Math.round((1 - current.price / baseline) * 100) : null,
    threshold,
  };
}

async function evaluateAlert(tracker, current) {
  const reason = alertReason(tracker, current);

  if (!reason) {
    if (tracker.notified_price != null) clearNotified(tracker.id);
    return { fired: false };
  }

  if (tracker.notified_price != null) return { fired: false, reason: 'already notified' };

  if (!mailerConfigured()) {
    return { fired: false, reason: 'email not configured' };
  }

  // markNotified BEFORE awaiting the send: if the process dies mid-send we'd
  // rather miss one alert than spam on every restart.
  markNotified(tracker.id, current.price);
  try {
    await sendDropAlert(tracker, current, reason);
    return { fired: true, why: reason.kind, percentBelow: reason.percentBelow };
  } catch (err) {
    clearNotified(tracker.id); // genuine send failure -> allow a retry next cycle
    throw err;
  }
}

/** Check one tracker. Never throws; failures are recorded on the row. */
export async function checkTracker(id) {
  const tracker = getTracker(id);
  if (!tracker) return { ok: false, error: 'not found' };

  try {
    const res = await fetchPrice({
      query: tracker.query,
      variationId: tracker.variation_id,
      productId: tracker.product_id,
      storeId: tracker.store_id,
    });

    if (!res.found) {
      recordCheck(id, {
        price: null,
        mrp: null,
        inStock: false,
        error: `Not found in ${res.results} search results for "${tracker.query}"`,
      });
      return { ok: false, error: 'product not found in search results' };
    }

    recordCheck(id, { price: res.price, mrp: res.mrp, inStock: res.inStock });

    // evaluateAlert needs the pre-update last_price to render "was -> now".
    const alert = await evaluateAlert(tracker, res);
    return { ok: true, price: res.price, inStock: res.inStock, ...alert };
  } catch (err) {
    recordCheck(id, { price: null, mrp: null, inStock: null, error: err.message });
    return { ok: false, error: err.message };
  }
}

async function warnSessionStaleOnce() {
  const last = Number(getState('session_stale_emailed_at') || 0);
  if (Date.now() - last < DAY) return;
  if (!mailerConfigured()) return;
  try {
    await sendSessionStaleAlert();
    setState('session_stale_emailed_at', Date.now());
  } catch (err) {
    console.error('[scheduler] could not send session-stale email:', err.message);
  }
}

export async function runCycle() {
  if (running) return { skipped: 'already running' };
  running = true;
  state.lastError = null;

  try {
    state.session = await sessionStatus();

    if (state.session.needsLocation) {
      state.lastError = 'No delivery location set — run `npm run login`.';
      console.warn(`[scheduler] ${state.lastError} Skipping cycle.`);
      await warnSessionStaleOnce();
      return { skipped: 'no location' };
    }

    const trackers = activeTrackers();
    if (!trackers.length) return { checked: 0 };

    console.log(`[scheduler] checking ${trackers.length} tracker(s)…`);
    let fired = 0;

    // Sequential on purpose: one shared browser context, and it keeps our
    // request rate gentle.
    for (const [i, t] of trackers.entries()) {
      const r = await checkTracker(t.id);
      if (r.fired) fired++;
      const label = r.ok ? `₹${r.price}${r.fired ? ' → ALERT SENT' : ''}` : `error: ${r.error}`;
      console.log(`  · ${t.name} (${t.quantity || '—'}): ${label}`);
      if (i < trackers.length - 1) await jitter();
    }

    return { checked: trackers.length, fired };
  } catch (err) {
    state.lastError = err.message;
    console.error('[scheduler] cycle failed:', err.message);
    return { error: err.message };
  } finally {
    state.lastRunAt = new Date().toISOString();
    running = false;
  }
}

export function startScheduler() {
  const minutes = Math.max(1, Number(process.env.CHECK_INTERVAL_MINUTES) || 15);
  console.log(`[scheduler] every ${minutes} minute(s)`);

  setTimeout(() => { runCycle(); }, 10_000);
  timer = setInterval(() => { runCycle(); }, minutes * MINUTE);
  return () => clearInterval(timer);
}
