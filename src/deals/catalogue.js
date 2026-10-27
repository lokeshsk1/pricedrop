/**
 * Builds the price catalogue the deal rule reads from.
 *
 * A sweep records EVERY product it sees, at whatever price it is currently
 * selling for -- not just the discounted ones. That is deliberate and load
 * bearing: if we only ever observed products while they were on offer, each
 * product's median would be computed from sale prices only, the baseline would
 * collapse toward the sale price, and real drops would stop registering.
 *
 * For the same reason the sweep must use Swiggy's default relevance sort. The
 * API also offers `discountPercentHighToLow`, which looks like a cheap way to
 * find deals and would quietly poison the baseline. See assertUnbiased() below.
 */
import { search } from '../swiggy/api.js';
import { recordDealSweep, pruneDealObservations } from '../db.js';
import { seeds } from './seeds.js';
import { config, daysAgoIso } from './baseline.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Same courtesy gap the tracker checks use, for the same reason.
const jitter = () => sleep(2000 + Math.random() * 2000);

/**
 * Guard the one mistake that would silently invalidate every baseline.
 * search() takes no sort argument today; if one is ever added, a discount sort
 * must never reach the sweep.
 */
export function assertUnbiased(opts = {}) {
  const sort = opts.sortAttribute || opts.sort || '';
  if (/discount/i.test(sort)) {
    throw new Error(
      `Refusing to sweep with sort "${sort}": observing products only while ` +
        'discounted biases every median downward and breaks deal detection.',
    );
  }
  return true;
}

/**
 * One full pass over the seed categories.
 *
 * Returns per-seed counts. Individual seed failures are collected rather than
 * thrown -- one bad category should degrade the sweep, not abort it.
 */
export async function sweep({ onProgress } = {}) {
  const cfg = config();
  const list = seeds();
  const startedAt = new Date().toISOString();

  let productsSeen = 0;
  const errors = [];

  for (const [i, category] of list.entries()) {
    try {
      assertUnbiased();
      const products = await search(category);

      const rows = products
        .filter((p) => p.variationId && Number.isFinite(p.price))
        .map((p) => ({
          product: p,
          category,
          price: p.price,
          mrp: p.mrp,
          inStock: p.inStock,
          seenAt: new Date().toISOString(),
        }));

      if (rows.length) recordDealSweep(rows);
      productsSeen += rows.length;
      onProgress?.({ category, count: rows.length, index: i, total: list.length });
    } catch (err) {
      errors.push({ category, error: err.message });
      onProgress?.({ category, error: err.message, index: i, total: list.length });
    }

    if (i < list.length - 1) await jitter();
  }

  const pruned = pruneDealObservations(daysAgoIso(cfg.retentionDays));

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    categories: list.length,
    productsSeen,
    pruned,
    errors,
  };
}
