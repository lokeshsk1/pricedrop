import { withPage, INSTAMART_URL } from './browser.js';
import { normalizeSearchResponse } from './normalize.js';

const SEARCH_PATH = '/api/instamart/search/v2';

function searchQs(storeId = '') {
  const p = new URLSearchParams({
    offset: '0',
    ageConsent: 'false',
    voiceSearchTrackingId: '',
    storeId: storeId || '',
    primaryStoreId: storeId || '',
    secondaryStoreId: '',
  });
  return `${SEARCH_PATH}?${p}`;
}

function searchBody(query) {
  return {
    facets: [],
    sortAttribute: '',
    query,
    search_results_offset: '0',
    page_type: 'INSTAMART_SEARCH_PAGE',
    is_pre_search_tag: false,
  };
}

/**
 * Primary strategy: run the API call from inside the page.
 *
 * Being same-origin, this inherits cookies, the AWS WAF bot token and the
 * location/store context automatically -- which is precisely what a plain HTTP
 * client cannot do (curl gets 403). It also skips a full page render, so a
 * scheduled re-check costs one XHR instead of a page load.
 */
async function searchViaFetch(page, query, storeId) {
  return page.evaluate(
    async ({ url, body }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON => bot challenge or error page */
      }
      return { status: res.status, json, snippet: text.slice(0, 200) };
    },
    { url: searchQs(storeId), body: searchBody(query) },
  );
}

/**
 * Fallback: drive the real search page and capture its own XHR.
 *
 * Slower, but it survives Swiggy changing the request signature/headers, since
 * the page's own JS builds the request for us.
 */
async function searchViaPage(page, query) {
  const url = `https://www.swiggy.com/instamart/search?custom_back=true&query=${encodeURIComponent(query)}`;

  const captured = new Promise((resolve) => {
    const onResponse = async (res) => {
      if (!res.url().includes(SEARCH_PATH)) return;
      try {
        const json = await res.json();
        page.off('response', onResponse);
        resolve({ status: res.status(), json });
      } catch {
        /* keep waiting for a parseable one */
      }
    };
    page.on('response', onResponse);
    setTimeout(() => {
      page.off('response', onResponse);
      resolve(null);
    }, 25000);
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return captured;
}

/** Search Instamart. Returns normalized products for the session's store. */
export async function search(query, { storeId = '' } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];

  return withPage(async (page) => {
    let res = await searchViaFetch(page, q, storeId).catch(() => null);

    if (!res || res.status !== 200 || !res.json?.data?.cards) {
      const fallback = await searchViaPage(page, q);
      if (!fallback?.json) {
        const why = res ? `status ${res.status}` : 'fetch threw';
        throw new Error(`Instamart search failed (${why}). Session may need re-login.`);
      }
      res = fallback;
    }

    return normalizeSearchResponse(res.json);
  });
}

/**
 * Re-check one tracked product's price.
 *
 * Deliberately reuses search() with the tracker's original query and re-matches
 * on variationId, rather than hitting a product-detail endpoint. One code path
 * to maintain, and variationId pins the exact pack size so we can never drift
 * onto a different variant.
 */
export async function fetchPrice({ query, variationId, productId, storeId }) {
  const results = await search(query, { storeId });

  const hit =
    results.find((p) => p.variationId === variationId) ||
    (productId ? results.find((p) => p.productId === productId) : null);

  if (!hit) {
    return { found: false, results: results.length };
  }
  return { found: true, ...hit };
}

// A session check costs a full page load, and both the UI poll and every
// scheduler cycle ask for it. Cache it briefly so we aren't re-loading the
// Instamart homepage every few seconds.
const SESSION_TTL_MS = 5 * 60_000;
let sessionCache = { at: 0, value: null };

export function invalidateSessionCache() {
  sessionCache = { at: 0, value: null };
}

/**
 * Session health: is a delivery location set on this profile?
 *
 * Swiggy renders "Add your location" until an address is chosen, and only then
 * resolves a real store. Without it, prices come from an arbitrary default
 * store and would be wrong for the user.
 */
export async function sessionStatus({ force = false } = {}) {
  if (!force && sessionCache.value && Date.now() - sessionCache.at < SESSION_TTL_MS) {
    return sessionCache.value;
  }

  return withPage(async (page) => {
    let storeId = null;
    const onRequest = (req) => {
      const m = req.url().match(/[?&]primaryStoreId=(\d+)/);
      if (m) storeId = m[1];
    };
    page.on('request', onRequest);

    await page.goto(INSTAMART_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    page.off('request', onRequest);

    const info = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      return {
        needsLocation: /Add your location/i.test(text),
        // The header shows the chosen address once one is set.
        header: text.split('\n').slice(0, 3).join(' ').trim(),
      };
    });

    const value = {
      ok: !info.needsLocation,
      needsLocation: info.needsLocation,
      address: info.needsLocation ? null : info.header,
      storeId,
    };
    sessionCache = { at: Date.now(), value };
    return value;
  });
}
