/**
 * The single place District data enters this app.
 *
 * Unlike Swiggy, District serves its pages to plain HTTP clients -- no bot
 * challenge, no cookies, no browser needed. Every page is Next.js SSR and
 * embeds its whole server payload in a __NEXT_DATA__ script tag, so one GET
 * gives us the same JSON the page itself renders from.
 *
 * District *does* have a JSON gateway (/gw/consumer/movies/v3/movie) which
 * accepts date + cinemaIds and would answer our question exactly, but it
 * returns 401 "Access token not found" without a session. If we ever obtain a
 * token, this file is the only one that has to change: everything downstream
 * consumes the shapes in normalize.js, not raw responses.
 */

export const BASE = 'https://www.district.in';

// Node's default fetch UA is an obvious bot tell. District doesn't currently
// block it, but there's no reason to advertise.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const NEXT_DATA =
  /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

/**
 * GET a District page and return both its raw HTML and its parsed
 * __NEXT_DATA__ payload. The HTML is kept because canonical slugs only exist
 * in the markup -- the JSON payload doesn't carry them.
 */
export async function fetchPage(path, { timeoutMs = 20000 } = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        'user-agent': UA,
        'accept-language': 'en-IN,en;q=0.9',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Timeouts and DNS/socket errors both land here; give them one shape.
    throw new Error(`District request failed (${path}): ${err.message}`);
  }

  if (!res.ok) throw new Error(`District returned ${res.status} for ${path}`);

  const html = await res.text();
  const m = html.match(NEXT_DATA);
  if (!m) {
    // Either they moved off this rendering strategy, or we were served an
    // error/interstitial page. Both mean normalize.js can't help us.
    throw new Error(`No __NEXT_DATA__ in District response for ${path}`);
  }

  try {
    return { html, nd: JSON.parse(m[1]) };
  } catch (err) {
    throw new Error(`Malformed __NEXT_DATA__ for ${path}: ${err.message}`);
  }
}

/** Most callers only want the payload. */
export async function fetchNextData(path, opts) {
  return (await fetchPage(path, opts)).nd;
}
