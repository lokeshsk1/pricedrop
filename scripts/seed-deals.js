/**
 * Seeds synthetic price history so the deal rule can be exercised immediately.
 *
 * Without this, verifying the feature would mean waiting a day for real sweeps
 * to accumulate the minimum number of readings.
 *
 *   node scripts/seed-deals.js            a spread of realistic cases
 *   node scripts/seed-deals.js --many 25  25 simultaneous deals (email cap test)
 *   node scripts/seed-deals.js --clear    remove everything it created
 */
import { db, recordDealSweep, pruneDealObservations } from '../src/db.js';
import { daysAgoIso } from '../src/deals/baseline.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d;
};

const PREFIX = 'SEED_';

if (has('--clear')) {
  const n = db
    .prepare(`DELETE FROM deal_products WHERE variation_id LIKE '${PREFIX}%'`)
    .run().changes;
  db.prepare(`DELETE FROM deal_observations WHERE variation_id LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM deal_alerts WHERE variation_id LIKE '${PREFIX}%'`).run();
  console.log(`removed ${n} seeded product(s)`);
  process.exit(0);
}

function product(id, name, quantity) {
  return {
    variationId: `${PREFIX}${id}`,
    productId: `${PREFIX}p${id}`,
    name,
    brand: 'Test',
    quantity,
    imageUrl: null,
    url: 'https://www.swiggy.com/instamart',
    storeId: '1404917',
  };
}

/** Write `prices` as observations spread over the preceding days. */
function seedSeries(p, prices, category = 'seeded') {
  const rows = prices.map((price, i) => ({
    product: p,
    category,
    price,
    mrp: Math.round(price * 2), // deliberately inflated, to prove MRP is ignored
    inStock: true,
    seenAt: daysAgoIso(prices.length - i),
  }));
  recordDealSweep(rows);
}

if (has('--many')) {
  const n = val('--many', 25);
  for (let i = 0; i < n; i++) {
    const p = product(`many${i}`, `Bulk Deal Product ${i + 1}`, '100 g');
    seedSeries(p, [100, 100, 100, 100, 100, 40 + i]);
  }
  console.log(`seeded ${n} products that are all currently deals`);
  process.exit(0);
}

// The cases that matter, mirroring the plan's verification table.
seedSeries(product('deal', 'Genuine Drop Biscuits', '200 g'), [100, 100, 100, 100, 100, 45]);
seedSeries(product('fake', 'Always Cheap Wafer', '75 g'), [39, 39, 39, 39, 39, 39]);
seedSeries(product('edge', 'Just Above Threshold', '1 L'), [100, 100, 100, 100, 100, 61]);
seedSeries(product('under', 'Just Below Threshold', '1 L'), [100, 100, 100, 100, 100, 59]);
seedSeries(product('thin', 'Too Few Readings', '500 g'), [100, 100, 45]);
seedSeries(product('old', 'Stale Observation', '1 kg'), [100, 100, 100, 100, 100, 50]);
db.prepare(
  `UPDATE deal_observations SET seen_at = ? WHERE variation_id = ?`,
).run(daysAgoIso(90), `${PREFIX}old`);

console.log('seeded:');
console.log('  SEED_deal   normally 100, now 45  -> expect DEAL (55% below)');
console.log('  SEED_fake   always 39, MRP 78     -> expect NOT a deal (the bias trap)');
console.log('  SEED_edge   normally 100, now 61  -> expect NOT a deal');
console.log('  SEED_under  normally 100, now 59  -> expect DEAL (41% below)');
console.log('  SEED_thin   only 3 readings       -> expect NOT a deal');
console.log('  SEED_old    all readings 90d old  -> expect excluded by window, and pruned');
