/**
 * One-time interactive login: `npm run login`
 *
 * Opens a real browser window against the persistent profile so you can pick
 * your delivery address in Swiggy's own UI. Instamart resolves the store (and
 * therefore the prices) from that address, so every headless check afterwards
 * depends on this being set. Cookies and local storage live in the profile
 * directory, so this is normally needed only once.
 */
import readline from 'node:readline';
import { getContext, closeBrowser, PROFILE_DIR, INSTAMART_URL } from './browser.js';

const POLL_MS = 2000;

function waitForEnter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question('', () => { rl.close(); resolve('enter'); }));
}

async function waitForLocation(page) {
  for (;;) {
    await page.waitForTimeout(POLL_MS);
    const set = await page
      .evaluate(() => !/Add your location/i.test(document.body?.innerText || ''))
      .catch(() => false);
    if (set) return 'detected';
  }
}

console.log('\n  PriceDrop — Swiggy Instamart login');
console.log(`  profile: ${PROFILE_DIR}\n`);

const ctx = await getContext({ headless: false });
const page = ctx.pages()[0] || (await ctx.newPage());

let storeId = null;
page.on('request', (req) => {
  const m = req.url().match(/[?&]primaryStoreId=(\d+)/);
  if (m && m[1]) storeId = m[1];
});

await page.goto(INSTAMART_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

console.log('  A browser window is open.');
console.log('  1. Click "Add your location" and choose your delivery address.');
console.log('  2. Wait until Instamart shows products for your area.\n');
console.log('  Detecting automatically… or press Enter here when done.\n');

// Whichever happens first: we detect the location, or you tell us you're done.
await Promise.race([waitForLocation(page), waitForEnter()]);
await page.waitForTimeout(2500);

const info = await page
  .evaluate(() => {
    const text = document.body?.innerText || '';
    return {
      needsLocation: /Add your location/i.test(text),
      header: text.split('\n').slice(0, 3).join(' ').trim(),
    };
  })
  .catch(() => ({ needsLocation: true, header: '' }));

if (info.needsLocation) {
  console.log('  ⚠  No delivery location detected yet.');
  console.log('     Price checks will use an arbitrary default store until one is set.');
  console.log('     Re-run `npm run login` and pick an address to fix this.\n');
} else {
  console.log('  ✓ Location saved.');
  console.log(`    address: ${info.header || '(shown in header)'}`);
  if (storeId) console.log(`    storeId: ${storeId}`);
  console.log('\n  You can now run `npm start`.\n');
}

await closeBrowser();
process.exit(info.needsLocation ? 1 : 0);
