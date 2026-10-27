import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'pricedrop.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS trackers (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    query          TEXT NOT NULL,
    product_id     TEXT,
    variation_id   TEXT,
    name           TEXT,
    brand          TEXT,
    quantity       TEXT,
    image_url      TEXT,
    product_url    TEXT,
    store_id       TEXT,
    target_price   REAL NOT NULL,
    last_price     REAL,
    last_mrp       REAL,
    last_in_stock  INTEGER,
    last_checked_at TEXT,
    last_error     TEXT,
    notified_at    TEXT,
    notified_price REAL,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
    price      REAL,
    mrp        REAL,
    in_stock   INTEGER,
    checked_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_history_tracker
    ON price_history(tracker_id, checked_at DESC);

  -- Single-row key/value for app state (e.g. last "session stale" email).
  CREATE TABLE IF NOT EXISTS app_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- District (movie ticketing) booking-open watches. Independent of the
  -- Swiggy trackers above; they share only this file and the mailer.
  CREATE TABLE IF NOT EXISTS movie_watches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    city_key        TEXT NOT NULL,
    content_id      TEXT NOT NULL,
    movie_name      TEXT,
    movie_slug      TEXT,
    poster_url      TEXT,
    release_date    TEXT,
    cinema_id       TEXT NOT NULL,
    cinema_name     TEXT,
    cinema_slug     TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    last_checked_at TEXT,
    last_error      TEXT,
    last_open       INTEGER,
    last_show_dates TEXT,
    last_status_note TEXT,
    -- JSON array of show dates already emailed about. This replaces the
    -- boolean latch the price trackers use: booking never closes again, so
    -- the question is not "did we notify" but "which dates have we notified".
    notified_dates  TEXT NOT NULL DEFAULT '[]',
    first_opened_at TEXT,
    notified_at     TEXT,
    created_at      TEXT NOT NULL,
    UNIQUE(content_id, cinema_id)
  );

  -- Deals discovery. Unlike trackers (which watch products you chose), these
  -- tables hold everything the category sweeps have ever seen, so that a
  -- product's *usual* price can be derived from its own history rather than
  -- from MRP. See src/deals/baseline.js for why MRP is not the yardstick.
  CREATE TABLE IF NOT EXISTS deal_products (
    variation_id  TEXT PRIMARY KEY,
    product_id    TEXT,
    name          TEXT,
    brand         TEXT,
    quantity      TEXT,
    image_url     TEXT,
    product_url   TEXT,
    store_id      TEXT,
    category      TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deal_observations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    variation_id TEXT NOT NULL REFERENCES deal_products(variation_id) ON DELETE CASCADE,
    price        REAL,
    mrp          REAL,
    in_stock     INTEGER,
    seen_at      TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_deal_obs
    ON deal_observations(variation_id, seen_at DESC);

  -- Same latch idea as trackers.notified_price, keyed by product instead.
  CREATE TABLE IF NOT EXISTS deal_alerts (
    variation_id   TEXT PRIMARY KEY REFERENCES deal_products(variation_id) ON DELETE CASCADE,
    notified_price REAL,
    notified_at    TEXT,
    baseline       REAL
  );
`);

const now = () => new Date().toISOString();

export function listTrackers() {
  return db.prepare(`SELECT * FROM trackers ORDER BY created_at DESC`).all();
}

export function activeTrackers() {
  return db
    .prepare(`SELECT * FROM trackers WHERE status = 'active' ORDER BY id`)
    .all();
}

export function getTracker(id) {
  return db.prepare(`SELECT * FROM trackers WHERE id = ?`).get(id);
}

export function addTracker({ query, product, targetPrice }) {
  const info = db
    .prepare(
      `INSERT INTO trackers
         (query, product_id, variation_id, name, brand, quantity, image_url,
          product_url, store_id, target_price, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      query,
      product.productId ?? null,
      product.variationId ?? null,
      product.name ?? null,
      product.brand ?? null,
      product.quantity ?? null,
      product.imageUrl ?? null,
      product.url ?? null,
      product.storeId ?? null,
      Number(targetPrice),
      now(),
    );
  return getTracker(Number(info.lastInsertRowid));
}

export function deleteTracker(id) {
  db.prepare(`DELETE FROM price_history WHERE tracker_id = ?`).run(id);
  db.prepare(`DELETE FROM trackers WHERE id = ?`).run(id);
}

export function updateTracker(id, { targetPrice, status }) {
  const t = getTracker(id);
  if (!t) return null;

  if (targetPrice != null) {
    // Changing the bar is a fresh intent, so clear the notification latch --
    // otherwise raising the target would never fire until the price bounced.
    db.prepare(
      `UPDATE trackers
          SET target_price = ?, notified_at = NULL, notified_price = NULL
        WHERE id = ?`,
    ).run(Number(targetPrice), id);
  }
  if (status) {
    db.prepare(`UPDATE trackers SET status = ? WHERE id = ?`).run(status, id);
  }
  return getTracker(id);
}

/** Record one observation: update the tracker's latest state + append history. */
export function recordCheck(id, { price, mrp, inStock, error = null }) {
  const ts = now();
  db.prepare(
    `UPDATE trackers
        SET last_price = ?, last_mrp = ?, last_in_stock = ?,
            last_checked_at = ?, last_error = ?
      WHERE id = ?`,
  ).run(
    price ?? null,
    mrp ?? null,
    inStock == null ? null : inStock ? 1 : 0,
    ts,
    error,
    id,
  );

  if (price != null) {
    db.prepare(
      `INSERT INTO price_history (tracker_id, price, mrp, in_stock, checked_at)
       VALUES (?,?,?,?,?)`,
    ).run(id, price, mrp ?? null, inStock ? 1 : 0, ts);
  }
}

export function markNotified(id, price) {
  db.prepare(
    `UPDATE trackers SET notified_at = ?, notified_price = ? WHERE id = ?`,
  ).run(now(), price, id);
}

/** Re-arm the latch so a future drop alerts again. */
export function clearNotified(id) {
  db.prepare(
    `UPDATE trackers SET notified_at = NULL, notified_price = NULL WHERE id = ?`,
  ).run(id);
}

export function history(id, limit = 50) {
  return db
    .prepare(
      `SELECT price, mrp, in_stock, checked_at
         FROM price_history WHERE tracker_id = ?
        ORDER BY checked_at DESC LIMIT ?`,
    )
    .all(id, limit);
}

export function getState(key) {
  return db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(key)?.value ?? null;
}

export function setState(key, value) {
  db.prepare(
    `INSERT INTO app_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(value));
}

/* ------------------------------------------------ District movie watches -- */

const parseDates = (json) => {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** Widen a row with its parsed JSON columns so callers never touch the text. */
function hydrateWatch(row) {
  if (!row) return row;
  return {
    ...row,
    notifiedDates: parseDates(row.notified_dates),
    lastShowDates: parseDates(row.last_show_dates),
  };
}

export function listWatches() {
  return db
    .prepare(`SELECT * FROM movie_watches ORDER BY created_at DESC`)
    .all()
    .map(hydrateWatch);
}

export function activeWatches() {
  return db
    .prepare(`SELECT * FROM movie_watches WHERE status = 'active' ORDER BY id`)
    .all()
    .map(hydrateWatch);
}

export function getWatch(id) {
  return hydrateWatch(db.prepare(`SELECT * FROM movie_watches WHERE id = ?`).get(id));
}

export function findWatch(contentId, cinemaId) {
  return hydrateWatch(
    db
      .prepare(`SELECT * FROM movie_watches WHERE content_id = ? AND cinema_id = ?`)
      .get(String(contentId), String(cinemaId)),
  );
}

export function addWatch({ city, movie, theatre }) {
  const info = db
    .prepare(
      `INSERT INTO movie_watches
         (city_key, content_id, movie_name, movie_slug, poster_url, release_date,
          cinema_id, cinema_name, cinema_slug, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      city,
      String(movie.contentId),
      movie.name ?? null,
      movie.slug ?? null,
      movie.poster ?? null,
      movie.releaseDate ?? null,
      String(theatre.cinemaId),
      theatre.name ?? null,
      theatre.slug ?? null,
      now(),
    );
  return getWatch(Number(info.lastInsertRowid));
}

export function deleteWatch(id) {
  db.prepare(`DELETE FROM movie_watches WHERE id = ?`).run(id);
}

export function updateWatch(id, { status }) {
  if (status) db.prepare(`UPDATE movie_watches SET status = ? WHERE id = ?`).run(status, id);
  return getWatch(id);
}

/** Record one observation. Mirrors recordCheck() for the price trackers. */
export function recordWatchCheck(id, { open, showDates, note = null, error = null }) {
  db.prepare(
    `UPDATE movie_watches
        SET last_checked_at = ?, last_open = ?, last_show_dates = ?,
            last_status_note = ?, last_error = ?
      WHERE id = ?`,
  ).run(
    now(),
    open == null ? null : open ? 1 : 0,
    JSON.stringify(showDates ?? []),
    note,
    error,
    id,
  );
}

/**
 * Union `dates` into the watch's notified set.
 *
 * Union rather than replace: District's showDates only ever covers the window
 * currently on sale, so dates drop off the front as they pass. Replacing would
 * let an old date re-enter the set and trigger a duplicate email.
 */
export function markWatchNotified(id, dates) {
  const w = getWatch(id);
  if (!w) return null;
  const merged = [...new Set([...w.notifiedDates, ...dates])].sort();
  db.prepare(
    `UPDATE movie_watches
        SET notified_dates = ?, notified_at = ?,
            first_opened_at = COALESCE(first_opened_at, ?)
      WHERE id = ?`,
  ).run(JSON.stringify(merged), now(), now(), id);
  return getWatch(id);
}

/**
 * Overwrite the notified set outright, rather than unioning into it.
 *
 * Only used to undo markWatchNotified() when the email that was supposed to
 * follow it failed to send -- otherwise a transient SMTP error would silently
 * consume the one alert this watch exists to deliver.
 */
export function setWatchNotified(id, { dates, notifiedAt = null, firstOpenedAt = null }) {
  db.prepare(
    `UPDATE movie_watches
        SET notified_dates = ?, notified_at = ?, first_opened_at = ?
      WHERE id = ?`,
  ).run(JSON.stringify(dates ?? []), notifiedAt, firstOpenedAt, id);
  return getWatch(id);
}

/* -------------------------------------------------------- Deals discovery -- */

/**
 * Record that a sweep saw this product. Identity is variation_id (the stable
 * per-pack-size id), so "Amul Taaza 500 ml" and "1 L" stay separate rows.
 */
export function upsertDealProduct(product, category) {
  const ts = now();
  db.prepare(
    `INSERT INTO deal_products
       (variation_id, product_id, name, brand, quantity, image_url,
        product_url, store_id, category, first_seen_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(variation_id) DO UPDATE SET
       name        = excluded.name,
       brand       = excluded.brand,
       quantity    = excluded.quantity,
       image_url   = excluded.image_url,
       product_url = excluded.product_url,
       store_id    = excluded.store_id,
       last_seen_at = excluded.last_seen_at`,
  ).run(
    product.variationId,
    product.productId ?? null,
    product.name ?? null,
    product.brand ?? null,
    product.quantity ?? null,
    product.imageUrl ?? null,
    product.url ?? null,
    product.storeId ?? null,
    category ?? null,
    ts,
    ts,
  );
}

export function recordDealObservation(variationId, { price, mrp, inStock, seenAt } = {}) {
  db.prepare(
    `INSERT INTO deal_observations (variation_id, price, mrp, in_stock, seen_at)
     VALUES (?,?,?,?,?)`,
  ).run(
    variationId,
    price ?? null,
    mrp ?? null,
    inStock == null ? null : inStock ? 1 : 0,
    seenAt || now(),
  );
}

/** Insert many observations in one transaction -- a sweep writes ~1000 rows. */
export function recordDealSweep(rows) {
  const insertProduct = db.prepare(
    `INSERT INTO deal_products
       (variation_id, product_id, name, brand, quantity, image_url,
        product_url, store_id, category, first_seen_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(variation_id) DO UPDATE SET
       name=excluded.name, brand=excluded.brand, quantity=excluded.quantity,
       image_url=excluded.image_url, product_url=excluded.product_url,
       store_id=excluded.store_id, last_seen_at=excluded.last_seen_at`,
  );
  const insertObs = db.prepare(
    `INSERT INTO deal_observations (variation_id, price, mrp, in_stock, seen_at)
     VALUES (?,?,?,?,?)`,
  );

  db.exec('BEGIN');
  try {
    for (const { product, category, price, mrp, inStock, seenAt } of rows) {
      const ts = seenAt || now();
      insertProduct.run(
        product.variationId,
        product.productId ?? null,
        product.name ?? null,
        product.brand ?? null,
        product.quantity ?? null,
        product.imageUrl ?? null,
        product.url ?? null,
        product.storeId ?? null,
        category ?? null,
        ts,
        ts,
      );
      insertObs.run(
        product.variationId,
        price ?? null,
        mrp ?? null,
        inStock == null ? null : inStock ? 1 : 0,
        ts,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

/**
 * Every catalogued product that has enough recent readings, with the median of
 * those readings as its baseline and its latest reading as the current price.
 *
 * The median is computed in SQL rather than by pulling every observation into
 * JS -- the table holds ~1000 products x several readings a day, and only the
 * summary is ever needed.
 */
export function dealRows({ since, minObservations }) {
  return db
    .prepare(
      `WITH recent AS (
         SELECT * FROM deal_observations WHERE seen_at >= ? AND price IS NOT NULL
       ),
       stats AS (
         SELECT variation_id, COUNT(*) AS obs_count FROM recent GROUP BY variation_id
       ),
       med AS (
         -- Median: average the middle one (odd n) or middle two (even n).
         SELECT variation_id, AVG(price) AS baseline FROM (
           SELECT variation_id, price,
                  ROW_NUMBER() OVER (PARTITION BY variation_id ORDER BY price) AS rn,
                  COUNT(*)     OVER (PARTITION BY variation_id)                AS cnt
             FROM recent
         ) WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
         GROUP BY variation_id
       ),
       latest AS (
         SELECT variation_id, price, mrp, in_stock, seen_at FROM (
           SELECT *, ROW_NUMBER() OVER (
                       PARTITION BY variation_id ORDER BY seen_at DESC, id DESC
                     ) AS rn
             FROM recent
         ) WHERE rn = 1
       )
       SELECT p.variation_id, p.product_id, p.name, p.brand, p.quantity,
              p.image_url, p.product_url, p.category,
              s.obs_count, m.baseline,
              l.price, l.mrp, l.in_stock, l.seen_at,
              a.notified_price, a.notified_at
         FROM deal_products p
         JOIN stats  s ON s.variation_id = p.variation_id
         JOIN med    m ON m.variation_id = p.variation_id
         JOIN latest l ON l.variation_id = p.variation_id
         LEFT JOIN deal_alerts a ON a.variation_id = p.variation_id
        WHERE s.obs_count >= ?`,
    )
    .all(since, minObservations);
}

export function dealProductHistory(variationId, limit = 120) {
  return db
    .prepare(
      `SELECT price, mrp, in_stock, seen_at
         FROM deal_observations WHERE variation_id = ?
        ORDER BY seen_at DESC LIMIT ?`,
    )
    .all(variationId, limit);
}

export function dealCatalogueStats({ since, minObservations }) {
  const products = db.prepare(`SELECT COUNT(*) AS n FROM deal_products`).get().n;
  const observations = db.prepare(`SELECT COUNT(*) AS n FROM deal_observations`).get().n;
  const withBaseline = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT variation_id FROM deal_observations
          WHERE seen_at >= ? AND price IS NOT NULL
          GROUP BY variation_id HAVING COUNT(*) >= ?
       )`,
    )
    .get(since, minObservations).n;
  return { products, observations, withBaseline };
}

/** Bound growth. Observations older than the retention window are dead weight. */
export function pruneDealObservations(beforeIso) {
  const info = db.prepare(`DELETE FROM deal_observations WHERE seen_at < ?`).run(beforeIso);
  return Number(info.changes ?? 0);
}

export function markDealNotified(variationId, price, baseline) {
  db.prepare(
    `INSERT INTO deal_alerts (variation_id, notified_price, notified_at, baseline)
     VALUES (?,?,?,?)
     ON CONFLICT(variation_id) DO UPDATE SET
       notified_price = excluded.notified_price,
       notified_at    = excluded.notified_at,
       baseline       = excluded.baseline`,
  ).run(variationId, price, now(), baseline ?? null);
}

/** Re-arm so the same product can alert again after the price recovers. */
export function clearDealNotified(variationId) {
  db.prepare(`DELETE FROM deal_alerts WHERE variation_id = ?`).run(variationId);
}

/* ------------------------------------------- Tracker percentage-drop rule -- */

/**
 * A tracker's "usual" price: the median of its own recent readings.
 *
 * Same median-in-SQL trick as dealRows(), but over price_history, so a tracked
 * product gets a percentage-drop trigger on top of its absolute target price.
 * A product that normally costs Rs800 halving to Rs400 is obviously worth an
 * email, but would never cross a target set at Rs60.
 *
 * Note these readings are time-weighted: recordCheck() appends one row per
 * cycle, so a price that held for days contributes far more rows than one that
 * held for an hour. That is the desired behaviour for "what it usually costs".
 */
export function trackerBaseline(trackerId, { since, minObservations = 5 } = {}) {
  const row = db
    .prepare(
      `WITH recent AS (
         SELECT price FROM price_history
          WHERE tracker_id = ? AND checked_at >= ? AND price IS NOT NULL
       ),
       ranked AS (
         SELECT price,
                ROW_NUMBER() OVER (ORDER BY price) AS rn,
                COUNT(*)     OVER ()               AS cnt
           FROM recent
       )
       SELECT (SELECT COUNT(*) FROM recent) AS obs_count,
              (SELECT AVG(price) FROM ranked
                WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)) AS baseline`,
    )
    .get(trackerId, since);

  if (!row || row.obs_count < minObservations) {
    return { baseline: null, observations: row?.obs_count ?? 0 };
  }
  return { baseline: row.baseline, observations: row.obs_count };
}
