import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import express from 'express';

import { search, sessionStatus } from './swiggy/api.js';
import { closeBrowser } from './swiggy/browser.js';
import {
  listTrackers, addTracker, deleteTracker, updateTracker, getTracker, history,
  listWatches, addWatch, deleteWatch, updateWatch, getWatch, findWatch,
} from './db.js';
import { startScheduler, runCycle, checkTracker, state } from './scheduler.js';
import { sendTestEmail, mailerConfigured } from './mailer.js';
import { searchMovies, searchTheatres, catalogStatus } from './district/catalog.js';
import { CITY_DEFAULT } from './district/normalize.js';
import {
  startDistrictScheduler,
  runCycle as runDistrictCycle,
  checkWatch,
  intervalMinutes as districtInterval,
  state as districtState,
} from './district/scheduler.js';
import {
  startDealScheduler,
  runSweep as runDealSweep,
  currentDeals,
  status as dealStatus,
  emailCurrentDeals,
} from './deals/scheduler.js';
import { dealProductHistory } from './db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

/** Wrap async handlers so a rejection becomes a 500 instead of a hang. */
const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(`[api] ${req.method} ${req.path}:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
};

app.get('/api/session', wrap(async (_req, res) => {
  const s = await sessionStatus();
  state.session = s;
  res.json({
    ...s,
    emailConfigured: mailerConfigured(),
    lastRunAt: state.lastRunAt,
    lastError: state.lastError,
    intervalMinutes: Math.max(1, Number(process.env.CHECK_INTERVAL_MINUTES) || 15),
  });
}));

app.get('/api/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing search query' });
  res.json({ products: await search(q) });
}));

app.get('/api/trackers', wrap((_req, res) => {
  res.json({ trackers: listTrackers() });
}));

app.post('/api/trackers', wrap((req, res) => {
  const { query, product, targetPrice } = req.body || {};
  const price = Number(targetPrice);

  if (!query || !product?.variationId) {
    return res.status(400).json({ error: 'query and product are required' });
  }
  if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ error: 'targetPrice must be a positive number' });
  }
  res.status(201).json({ tracker: addTracker({ query, product, targetPrice: price }) });
}));

app.patch('/api/trackers/:id', wrap((req, res) => {
  const { targetPrice, status } = req.body || {};
  if (status && !['active', 'paused'].includes(status)) {
    return res.status(400).json({ error: 'status must be active or paused' });
  }
  // `null` arrives here whenever the client sent NaN (JSON has no NaN), so it
  // must be rejected rather than treated as "field omitted" -- otherwise the
  // update is skipped and the caller still gets a 200.
  if ('targetPrice' in (req.body || {}) && !(Number(targetPrice) > 0)) {
    return res.status(400).json({ error: 'targetPrice must be a positive number' });
  }
  const t = updateTracker(Number(req.params.id), { targetPrice, status });
  if (!t) return res.status(404).json({ error: 'Tracker not found' });
  res.json({ tracker: t });
}));

app.delete('/api/trackers/:id', wrap((req, res) => {
  deleteTracker(Number(req.params.id));
  res.json({ ok: true });
}));

app.get('/api/trackers/:id/history', wrap((req, res) => {
  res.json({ history: history(Number(req.params.id)) });
}));

app.post('/api/trackers/:id/check', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!getTracker(id)) return res.status(404).json({ error: 'Tracker not found' });
  const result = await checkTracker(id);
  res.json({ result, tracker: getTracker(id) });
}));

app.post('/api/check-all', wrap(async (_req, res) => {
  res.json({ result: await runCycle() });
}));

app.post('/api/test-email', wrap(async (_req, res) => {
  if (!mailerConfigured()) {
    return res.status(400).json({
      error: 'Email not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD in .env',
    });
  }
  await sendTestEmail();
  res.json({ ok: true, sentTo: process.env.ALERT_EMAIL || process.env.GMAIL_USER });
}));

/* ------------------------------------------------- District movie watches -- */

const districtCity = () => process.env.DISTRICT_CITY || CITY_DEFAULT;

/**
 * City slugs go straight into District URLs and into the catalogue's cache
 * key, so an arbitrary query value would both shape outbound requests and
 * grow that cache without bound. District slugs are plain kebab-case.
 */
function cityFrom(req) {
  const raw = req.query.city;
  if (raw == null || raw === '') return districtCity();
  const city = String(raw).toLowerCase();
  if (!/^[a-z0-9-]{2,40}$/.test(city)) return null;
  return city;
}

app.get('/api/district/status', wrap(async (_req, res) => {
  const city = districtCity();
  // A catalogue failure shouldn't blank the panel -- report it inline instead.
  let catalog = null;
  let error = null;
  try {
    catalog = await catalogStatus(city);
  } catch (err) {
    error = err.message;
  }
  res.json({
    city,
    catalog,
    catalogError: error,
    emailConfigured: mailerConfigured(),
    lastRunAt: districtState.lastRunAt,
    lastError: districtState.lastError,
    intervalMinutes: districtInterval(),
  });
}));

app.get('/api/district/movies', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing search query' });
  const city = cityFrom(req);
  if (!city) return res.status(400).json({ error: 'Invalid city slug' });
  res.json({ movies: await searchMovies(city, q) });
}));

app.get('/api/district/theatres', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing search query' });
  const city = cityFrom(req);
  if (!city) return res.status(400).json({ error: 'Invalid city slug' });
  res.json({ theatres: await searchTheatres(city, q) });
}));

app.get('/api/district/watches', wrap((_req, res) => {
  res.json({ watches: listWatches() });
}));

app.post('/api/district/watches', wrap((req, res) => {
  const { movie, theatre, city } = req.body || {};
  if (!movie?.contentId || !theatre?.cinemaId) {
    return res.status(400).json({ error: 'movie and theatre are required' });
  }
  // The table has a UNIQUE(content_id, cinema_id); answer clearly rather than
  // letting the constraint surface as a 500.
  if (findWatch(movie.contentId, theatre.cinemaId)) {
    return res.status(409).json({ error: 'You are already watching that movie at that theatre' });
  }
  res.status(201).json({
    watch: addWatch({ city: city || districtCity(), movie, theatre }),
  });
}));

app.patch('/api/district/watches/:id', wrap((req, res) => {
  const { status } = req.body || {};
  if (status && !['active', 'paused'].includes(status)) {
    return res.status(400).json({ error: 'status must be active or paused' });
  }
  const w = updateWatch(Number(req.params.id), { status });
  if (!w) return res.status(404).json({ error: 'Watch not found' });
  res.json({ watch: w });
}));

app.delete('/api/district/watches/:id', wrap((req, res) => {
  deleteWatch(Number(req.params.id));
  res.json({ ok: true });
}));

app.post('/api/district/watches/:id/check', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!getWatch(id)) return res.status(404).json({ error: 'Watch not found' });
  const result = await checkWatch(id);
  res.json({ result, watch: getWatch(id) });
}));

app.post('/api/district/check-all', wrap(async (_req, res) => {
  res.json({ result: await runDistrictCycle() });
}));

/* -------------------------------------------------------- Deals discovery -- */

app.get('/api/deals', wrap((_req, res) => {
  res.json({ deals: currentDeals(), status: dealStatus() });
}));

app.get('/api/deals/status', wrap((_req, res) => {
  res.json(dealStatus());
}));

app.get('/api/deals/:variationId/history', wrap((req, res) => {
  res.json({ history: dealProductHistory(String(req.params.variationId)) });
}));

app.post('/api/deals/sweep', wrap(async (_req, res) => {
  res.json({ result: await runDealSweep() });
}));

app.post('/api/deals/email', wrap(async (_req, res) => {
  res.json({ result: await emailCurrentDeals() });
}));

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
  console.log(`\n  PriceDrop → http://localhost:${port}`);
  if (!mailerConfigured()) {
    console.log('  ⚠  Email not configured — copy .env.example to .env and fill it in.');
  }
  startScheduler();
  startDistrictScheduler();
  startDealScheduler();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, async () => {
    console.log('\n  shutting down…');
    server.close();
    await closeBrowser();
    process.exit(0);
  });
}
