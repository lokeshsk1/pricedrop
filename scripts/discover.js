/**
 * Endpoint discovery harness.
 *
 * Swiggy's Instamart API is undocumented and blocks plain HTTP clients, so the
 * request/response shape has to be observed from a real browser session.
 * This script drives a search and dumps every /api/instamart/* call it sees.
 *
 *   npm run discover -- "amul milk"          headless, uses saved profile
 *   npm run discover -- "amul milk" --headed opens a visible window
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getContext, closeBrowser, INSTAMART_URL } from '../src/swiggy/browser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'discovery');

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const query = args.find((a) => !a.startsWith('--')) || 'amul milk';

const captured = [];

function short(s, n = 300) {
  if (typeof s !== 'string') return s;
  return s.length > n ? `${s.slice(0, n)}… (${s.length} bytes)` : s;
}

const ctx = await getContext({ headless: !headed });
const page = ctx.pages()[0] || (await ctx.newPage());

page.on('response', async (res) => {
  const url = res.url();
  if (!/\/api\/instamart\//.test(url)) return;

  const req = res.request();
  const entry = {
    method: req.method(),
    url,
    status: res.status(),
    postData: req.postData() || null,
    requestHeaders: req.headers(),
  };

  try {
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    if (ct.includes('json')) entry.body = await res.json();
    else entry.body = short(await res.text());
  } catch (err) {
    entry.bodyError = err.message;
  }

  captured.push(entry);
  console.log(`  [${entry.status}] ${entry.method} ${url.slice(0, 130)}`);
});

console.log(`\n→ Loading ${INSTAMART_URL} (headless=${!headed})`);
await page.goto(INSTAMART_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);

console.log(`   title:   ${JSON.stringify(await page.title())}`);
console.log(`   url:     ${page.url()}`);
const bodyLen = await page.evaluate(() => document.body?.innerText?.length ?? 0);
console.log(`   text len: ${bodyLen}`);

const cookies = await ctx.cookies('https://www.swiggy.com');
console.log(`\n→ Cookies (${cookies.length}):`);
for (const c of cookies) console.log(`   ${c.name} = ${short(c.value, 120)}`);

console.log(`\n→ Searching for ${JSON.stringify(query)} via the search page`);
const searchUrl = `https://www.swiggy.com/instamart/search?custom_back=true&query=${encodeURIComponent(query)}`;
await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);

const searchTextLen = await page.evaluate(() => document.body?.innerText?.length ?? 0);
console.log(`   search page text len: ${searchTextLen}`);

fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, `capture-${Date.now()}.json`);
fs.writeFileSync(
  file,
  JSON.stringify({ query, cookies, captured, searchTextLen, bodyLen }, null, 2),
);
console.log(`\n→ Captured ${captured.length} instamart API call(s)`);
console.log(`→ Wrote ${file}`);

if (headed) {
  console.log('\nHeaded mode: browser stays open 120s so you can interact.');
  await page.waitForTimeout(120000);
}

await closeBrowser();
process.exit(0);
