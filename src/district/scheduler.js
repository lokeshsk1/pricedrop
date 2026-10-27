/**
 * The District watch loop.
 *
 * Separate from the Swiggy scheduler on purpose: the two answer different
 * questions and latch differently. A price tracker asks "is it cheap yet" and
 * re-arms when the price climbs back; a booking watch asks "can I buy tickets
 * yet", and that never becomes false again -- so instead of a boolean latch it
 * keeps the set of show dates it has already emailed about, and alerts on any
 * date that isn't in it. Watches stay active until you pause or delete them.
 */
import { checkBooking } from './sessions.js';
import {
  activeWatches,
  getWatch,
  recordWatchCheck,
  markWatchNotified,
  setWatchNotified,
} from '../db.js';
import { sendBookingOpenAlert, sendNewDatesAlert, mailerConfigured } from '../mailer.js';

const MINUTE = 60_000;

let running = false;
let timer = null;

// runCycle() guards itself, but the per-row "check" button calls checkWatch()
// directly and can land mid-cycle. Both would read first_opened_at as null
// across the network round-trip, both would mark, and both would send -- the
// exact duplicate the latch exists to prevent. One check per watch at a time.
const inFlight = new Set();

export const state = {
  lastRunAt: null,
  lastError: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Same courtesy gap the Swiggy checks use, for the same reason.
const jitter = () => sleep(2000 + Math.random() * 2000);

/** A short human line for the UI explaining what we saw this cycle. */
function statusNote(snap) {
  if (snap.open) return snap.futureShowMessage || 'Booking open at this theatre';
  if (snap.futureShowMessage) return snap.futureShowMessage;
  // Deliberately not a count: theatresPlaying only covers the default
  // language group, so quoting it as a total would be wrong.
  if (snap.theatresPlaying > 0) return 'On sale elsewhere in the city, not at this theatre yet';
  return 'No shows listed yet';
}

/**
 * Decide whether this observation should send an email, and keep the latch.
 *
 * Two distinct alerts: the first time the theatre has any bookable show, and
 * thereafter any show date District puts on sale that we haven't mentioned.
 */
async function evaluateAlert(watch, snap) {
  if (!snap.open) return { fired: false };

  // A paused watch is the user saying "stop telling me about this". The cycle
  // already skips them, but the per-row "check" button calls checkWatch()
  // directly, and that shouldn't put an email in their inbox either.
  if (watch.status !== 'active') return { fired: false, reason: 'watch is paused' };

  if (!mailerConfigured()) return { fired: false, reason: 'email not configured' };

  const dates = snap.showDates.length
    ? snap.showDates
    : snap.selectedShowDate
      ? [snap.selectedShowDate]
      : [];

  // Snapshot the latch so a failed send can be undone; otherwise one SMTP
  // hiccup would permanently swallow the alert this watch exists for.
  const before = {
    dates: watch.notifiedDates,
    notifiedAt: watch.notified_at,
    firstOpenedAt: watch.first_opened_at,
  };
  const rollback = () => setWatchNotified(watch.id, before);

  // Mark BEFORE awaiting the send: if the process dies mid-send we would
  // rather miss one alert than re-send on every restart.
  if (!watch.first_opened_at) {
    markWatchNotified(watch.id, dates);
    try {
      await sendBookingOpenAlert(watch, snap);
    } catch (err) {
      rollback();
      throw err;
    }
    return { fired: true, kind: 'booking-open', dates };
  }

  const newDates = dates.filter((d) => !watch.notifiedDates.includes(d));
  if (!newDates.length) return { fired: false, reason: 'already notified' };

  markWatchNotified(watch.id, newDates);
  try {
    await sendNewDatesAlert(watch, snap, newDates);
  } catch (err) {
    rollback();
    throw err;
  }
  return { fired: true, kind: 'new-dates', dates: newDates };
}

/** Check one watch. Never throws; failures are recorded on the row. */
export async function checkWatch(id) {
  const watch = getWatch(id);
  if (!watch) return { ok: false, error: 'not found' };
  if (inFlight.has(id)) return { ok: false, error: 'already being checked' };
  inFlight.add(id);

  let snap;
  try {
    snap = await checkBooking({
      city: watch.city_key,
      contentId: watch.content_id,
      movieSlug: watch.movie_slug,
      cinemaId: watch.cinema_id,
      cinemaSlug: watch.cinema_slug,
    });
  } catch (err) {
    // Only a failed *observation* resets the row's state.
    recordWatchCheck(id, {
      open: null,
      showDates: watch.lastShowDates,
      note: watch.last_status_note,
      error: err.message,
    });
    inFlight.delete(id);
    return { ok: false, error: err.message };
  }

  const note = statusNote(snap);
  recordWatchCheck(id, { open: snap.open, showDates: snap.showDates, note });

  try {
    const alert = await evaluateAlert(watch, snap);
    return { ok: true, open: snap.open, note, ...alert };
  } catch (err) {
    // The observation above was correct and stays; record only that the email
    // failed. Re-running recordWatchCheck with the pre-check values here would
    // show "waiting" at the exact moment booking opened.
    recordWatchCheck(id, {
      open: snap.open,
      showDates: snap.showDates,
      note,
      error: `Alert email failed: ${err.message}`,
    });
    return { ok: false, open: snap.open, note, error: err.message };
  } finally {
    inFlight.delete(id);
  }
}

export async function runCycle() {
  if (running) return { skipped: 'already running' };
  running = true;
  state.lastError = null;

  try {
    const watches = activeWatches();
    if (!watches.length) return { checked: 0 };

    console.log(`[district] checking ${watches.length} watch(es)…`);
    let fired = 0;

    // Sequential, like the price checks -- these are plain page loads, but
    // there is no reason to hit District in a burst.
    for (const [i, w] of watches.entries()) {
      const r = await checkWatch(w.id);
      if (r.fired) fired++;
      const label = r.ok
        ? `${r.open ? 'OPEN' : 'closed'}${r.fired ? ` → ALERT SENT (${r.kind})` : ''}`
        : `error: ${r.error}`;
      console.log(`  · ${w.movie_name} @ ${w.cinema_name}: ${label}`);
      if (i < watches.length - 1) await jitter();
    }

    return { checked: watches.length, fired };
  } catch (err) {
    state.lastError = err.message;
    console.error('[district] cycle failed:', err.message);
    return { error: err.message };
  } finally {
    state.lastRunAt = new Date().toISOString();
    running = false;
  }
}

export function intervalMinutes() {
  return Math.max(1, Number(process.env.DISTRICT_CHECK_INTERVAL_MINUTES) || 10);
}

export function startDistrictScheduler() {
  const minutes = intervalMinutes();
  console.log(`[district] every ${minutes} minute(s)`);

  // Offset from the Swiggy scheduler's 10s kick so the two don't start
  // together on boot.
  setTimeout(() => { runCycle(); }, 20_000);
  timer = setInterval(() => { runCycle(); }, minutes * MINUTE);
  return () => clearInterval(timer);
}
