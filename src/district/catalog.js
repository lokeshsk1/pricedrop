/**
 * Movie and theatre lookup -- the two things you pick when creating a watch.
 *
 * Three public listing pages cover everything we need, and all three share the
 * same EDSResponse rail shape:
 *
 *   /movies/<city>-movie-tickets           now showing   (~34 movies)
 *   /movies/upcoming-movies-in-<city>      upcoming      (~199 movies)
 *   /movies/cinemas-in-<city>              every theatre (~55 in Chennai)
 *
 * Including the upcoming list is the point of the feature: the movie you want
 * an alert for is, by definition, usually one that has no showtimes yet.
 */
import { fetchPage } from './fetch.js';
import { parseRails, slugsFromHtml } from './normalize.js';

// These lists change on the order of days, and a search shouldn't cost three
// page loads. Cache per city.
const TTL_MS = 6 * 60 * 60_000;
// A catalogue built while one of the three pages was failing is missing whole
// categories -- usually every theatre. Holding that for six hours would leave
// the picker broken until a restart, so retry it soon instead.
const PARTIAL_TTL_MS = 5 * 60_000;
const cache = new Map();

async function loadCity(city) {
  const hit = cache.get(city);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;

  const paths = [
    `/movies/${city}-movie-tickets`,
    `/movies/upcoming-movies-in-${city}`,
    `/movies/cinemas-in-${city}`,
  ];

  const movies = new Map();
  const cinemas = new Map();
  const slugs = { movies: new Map(), cinemas: new Map() };
  const errors = [];

  // Sequential and tolerant: one page 404ing (a city we spelled wrong, a page
  // they renamed) should degrade the catalogue, not empty it.
  for (const path of paths) {
    let page;
    try {
      page = await fetchPage(path);
    } catch (err) {
      errors.push(`${path}: ${err.message}`);
      continue;
    }
    const { movies: ms, cinemas: cs } = parseRails(page.nd);
    for (const m of ms) if (!movies.has(m.contentId)) movies.set(m.contentId, m);
    for (const c of cs) if (!cinemas.has(c.cinemaId)) cinemas.set(c.cinemaId, c);

    const s = slugsFromHtml(page.html, city);
    for (const [id, slug] of s.movies) if (!slugs.movies.has(id)) slugs.movies.set(id, slug);
    for (const [id, slug] of s.cinemas) if (!slugs.cinemas.has(id)) slugs.cinemas.set(id, slug);
  }

  if (!movies.size && !cinemas.size) {
    throw new Error(
      `Could not load any District listings for "${city}". ` +
        (errors[0] ?? 'No rails in the response.'),
    );
  }

  const value = {
    city,
    movies: [...movies.values()].map((m) => ({ ...m, slug: slugs.movies.get(m.contentId) ?? null })),
    cinemas: [...cinemas.values()].map((c) => ({ ...c, slug: slugs.cinemas.get(c.cinemaId) ?? null })),
    errors,
  };
  cache.set(city, { at: Date.now(), ttl: errors.length ? PARTIAL_TTL_MS : TTL_MS, value });
  return value;
}

export function invalidateCatalog(city) {
  if (city) cache.delete(city);
  else cache.clear();
}

/**
 * Loose substring match, ranked so a prefix hit beats a mid-string one.
 * District's own search is behind the authenticated gateway, so we filter the
 * catalogue ourselves -- at a few hundred entries that is more than fine.
 */
function rank(list, q, key = 'name') {
  const needle = q.trim().toLowerCase();
  if (!needle) return list;
  const scored = [];
  for (const item of list) {
    const hay = String(item[key] ?? '').toLowerCase();
    const at = hay.indexOf(needle);
    if (at === -1) continue;
    scored.push({ item, score: at === 0 ? 0 : 1, at, len: hay.length });
  }
  scored.sort((a, b) => a.score - b.score || a.at - b.at || a.len - b.len);
  return scored.map((s) => s.item);
}

export async function searchMovies(city, query, { limit = 25 } = {}) {
  const { movies } = await loadCity(city);
  return rank(movies, query).slice(0, limit);
}

export async function searchTheatres(city, query, { limit = 25 } = {}) {
  const { cinemas } = await loadCity(city);
  return rank(cinemas, query).slice(0, limit);
}

export async function catalogStatus(city) {
  const { movies, cinemas, errors } = await loadCity(city);
  return { city, movies: movies.length, theatres: cinemas.length, errors };
}
