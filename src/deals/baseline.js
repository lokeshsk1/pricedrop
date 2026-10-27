/**
 * The deal rule.
 *
 * A product is a deal when it costs materially less than *it normally costs* --
 * not less than its MRP. That distinction is the whole point of this feature.
 *
 * Instamart MRPs are frequently inflated to manufacture a permanent discount.
 * Sampling 320 real products found e.g. `Sunfeast Dark Fantasy` at Rs39 against
 * an MRP of Rs90. Judged against MRP that is "57% off" every day forever, and
 * would alert endlessly. Judged against its own history the median settles at
 * Rs39, `39 < 0.6 x 39` is false, and it is correctly not a deal -- until it
 * actually falls to ~Rs22.
 *
 * Hence: baseline = median of recent observed prices, and the displayed
 * discount is `1 - price / baseline`, never `1 - price / mrp`.
 */

export const DEFAULTS = {
  ratio: 0.6, // deal when price < ratio x usual
  minObservations: 5, // readings before a product earns a baseline
  windowDays: 30, // trailing window the median is taken over
  retentionDays: 60, // how long observations are kept at all
  // How recently we must have SEEN the price for a deal to count as live.
  // Without this, a product that drops out of search results keeps its last
  // observed price forever and shows up as a current deal for days.
  maxAgeMinutes: 60,
};

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

let warnedRetention = false;

export function config(env = process.env) {
  const windowDays = num(env.DEAL_WINDOW_DAYS, DEFAULTS.windowDays);
  let retentionDays = num(env.DEAL_RETENTION_DAYS, DEFAULTS.retentionDays);

  // Retention shorter than the median window would silently truncate the
  // baseline: we would ask for a 30-day median and prune away everything past
  // day 14. Clamp instead of quietly computing a different number.
  if (retentionDays < windowDays) {
    if (!warnedRetention) {
      warnedRetention = true;
      console.warn(
        `[deals] DEAL_RETENTION_DAYS (${retentionDays}) is shorter than ` +
          `DEAL_WINDOW_DAYS (${windowDays}); raising retention to match so the ` +
          'median window stays fully populated.',
      );
    }
    retentionDays = windowDays;
  }

  return {
    ratio: num(env.DEAL_RATIO, DEFAULTS.ratio),
    minObservations: Math.max(1, Math.floor(num(env.DEAL_MIN_OBSERVATIONS, DEFAULTS.minObservations))),
    windowDays,
    retentionDays,
    maxAgeMinutes: num(env.DEAL_MAX_AGE_MINUTES, DEFAULTS.maxAgeMinutes),
    // history | mrp. Documented escape hatch so a cold catalogue isn't a blank
    // page for a day; the default is history because MRP produces fake deals.
    mode: env.DEAL_BASELINE === 'mrp' ? 'mrp' : 'history',
  };
}

export const daysAgoIso = (days, from = Date.now()) =>
  new Date(from - days * 86_400_000).toISOString();

/** Median of a numeric array. Exported so the maths can be tested directly. */
export function median(values) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export const percentBelow = (price, baseline) =>
  !baseline || !Number.isFinite(price) ? 0 : Math.round((1 - price / baseline) * 100);

/**
 * Turn one catalogue row (from dealRows()) into a deal verdict.
 *
 * `row.baseline` is the SQL-computed median in history mode; in mrp mode we
 * substitute the MRP instead, which is what makes the escape hatch a one-line
 * change rather than a second code path.
 */
export function evaluate(row, cfg, now = Date.now()) {
  const baseline = cfg.mode === 'mrp' ? row.mrp : row.baseline;
  const price = row.price;

  const enough = row.obs_count >= cfg.minObservations;
  const usable = Number.isFinite(baseline) && baseline > 0 && Number.isFinite(price);
  const inStock = Boolean(row.in_stock);

  // A price we last saw days ago is not a deal you can act on. Products fall
  // out of search results when they sell out or get delisted, and their final
  // observed price would otherwise linger as a "current" deal for the whole
  // retention window.
  const ageMinutes = (now - new Date(row.seen_at).getTime()) / 60000;
  const fresh = Number.isFinite(ageMinutes) && ageMinutes <= cfg.maxAgeMinutes;

  const isDeal = enough && usable && inStock && fresh && price < cfg.ratio * baseline;

  return {
    variationId: row.variation_id,
    productId: row.product_id,
    name: row.name,
    brand: row.brand,
    quantity: row.quantity,
    imageUrl: row.image_url,
    url: row.product_url,
    category: row.category,
    price,
    mrp: row.mrp,
    baseline: usable ? baseline : null,
    percentBelow: usable ? percentBelow(price, baseline) : 0,
    observations: row.obs_count,
    inStock,
    seenAt: row.seen_at,
    ageMinutes: Math.round(ageMinutes),
    fresh,
    notifiedPrice: row.notified_price ?? null,
    isDeal,
  };
}

/** Deals only, deepest discount first. */
export function selectDeals(rows, cfg) {
  return rows
    .map((r) => evaluate(r, cfg))
    .filter((d) => d.isDeal)
    .sort((a, b) => b.percentBelow - a.percentBelow);
}
