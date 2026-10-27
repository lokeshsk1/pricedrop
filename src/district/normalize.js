/**
 * Translates District's __NEXT_DATA__ payloads into flat shapes.
 *
 * This file is the blast radius for District changing their site. Everything
 * downstream (catalog, sessions, scheduler, mailer, UI) depends only on what
 * this module returns, never on District's raw JSON.
 *
 * Observed payloads (captured 2026-09-18), all under
 * `props.pageProps.data.serverState`:
 *
 *   Movie page   /movies/<any>-in-<city>-MV<contentId>
 *     movieData[contentId]      present when nothing is bookable yet
 *     mdpV2MovieData[contentId] replaces it once shows exist; same inner shape
 *     movieSessions[eventCode]  absent entirely until booking opens
 *       meta.showDates[]          every date the movie has shows, city-wide
 *       meta.selectedShowDate     the date arrangedSessions describes
 *       meta.isFutureShow         true when the earliest date is not today
 *       meta.futureShowMessage    e.g. "Advance bookings open for Sunday shows"
 *       arrangedSessions[]        one entry per cinema (entityCode = cinemaId)
 *     mdpV2MovieData[contentId].movie   name, poster, censor, release_date
 *
 *   Cinema page  /movies/<any>-in-<city>-CD<cinemaId>
 *     [cinemaId].meta.cinema          name, address
 *     [cinemaId].meta.groupedMovies[] contentId + totalSessionCount, today only
 *     [cinemaId].arrangedSessions[]   one entry per movie (entityCode = contentId)
 *
 *   Listing pages (city / upcoming / cinemas-in-<city>)
 *     EDSResponse.rails[].items[].ItemDetails.{MovieData,CinemaData}
 *
 * Three things learned the hard way, all load-bearing:
 *   - The URL slug is decorative. Only the trailing MV/CD id and the city
 *     segment change the response, so we never have to track slug drift.
 *   - No date parameter is honoured by SSR. arrangedSessions always describes
 *     the *earliest bookable date*, and only the next session per cinema.
 *   - movieSessions holds exactly ONE event code, and it covers only the
 *     default language/format group. Resident Evil lists 115 Tamil sessions
 *     there while its 86 English and 6 Hindi ones are absent entirely. So a
 *     theatre screening only a non-default print is missing from `theatres`.
 *     `languageGroups` reports what else exists; the cinema page is what
 *     actually settles whether a given theatre is screening the film.
 *
 * Presence is trustworthy; absence is not. Callers must treat a theatre
 * missing from `theatres` as "unknown", not "no".
 */

export const CITY_DEFAULT = 'chennai';

const ss = (nd) => nd?.props?.pageProps?.data?.serverState ?? {};
const first = (obj) => (obj && typeof obj === 'object' ? Object.values(obj)[0] : null);

/* ------------------------------------------------------------------ urls -- */

/**
 * District ignores the slug portion entirely -- `x-movie-tickets-in-chennai-MV1`
 * resolves the same as the canonical slug. We still pass a real slug when we
 * have one so links in emails look like the ones on the site.
 */
export function movieUrl(city, contentId, slug = 'movie') {
  return `/movies/${slug}-movie-tickets-in-${city}-MV${contentId}`;
}

export function cinemaUrl(city, cinemaId, slug = 'cinema') {
  return `/movies/${slug}-in-${city}-CD${cinemaId}`;
}

/**
 * Deep link straight to seat selection for one show.
 *
 * The encsessionid format was read off the ScreeningEvent JSON-LD the movie
 * page emits: `<cinemaId>-<sessionId>-<lowercased mid>-<cinemaId>`.
 */
export function seatLayoutUrl({ eventCode, contentId, session }) {
  if (!eventCode || !session?.sid || !session?.cid || !session?.mid) return null;
  const enc = `${session.cid}-${session.sid}-${String(session.mid).toLowerCase()}-${session.cid}`;
  const q = new URLSearchParams({
    encsessionid: enc,
    freeseating: 'false',
    fromsessions: 'true',
    type: 'MOVIES',
    contentid: String(contentId ?? ''),
  });
  return `https://www.district.in/movies/seat-layout/${eventCode}?${q}`;
}

/* --------------------------------------------------------------- helpers -- */

/** Rails carry unix seconds as a string; movie pages carry "YYYY-MM-DD". */
function releaseDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString().slice(0, 10);
}

/** One show. `areas` holds the seat classes, each separately priced. */
function normalizeSession(s) {
  const areas = Array.isArray(s?.areas) ? s.areas : [];
  const prices = areas.map((a) => Number(a?.price)).filter((n) => Number.isFinite(n));
  return {
    sid: s?.sid != null ? String(s.sid) : null,
    cid: s?.cid ?? null,
    mid: s?.mid ?? null,
    showTime: s?.showTime ?? null,
    closeTime: s?.closeTime ?? null,
    audi: s?.audi ?? null,
    seatsAvailable: Number.isFinite(Number(s?.avail)) ? Number(s.avail) : null,
    seatsTotal: Number.isFinite(Number(s?.total)) ? Number(s.total) : null,
    minPrice: prices.length ? Math.min(...prices) : null,
    maxPrice: prices.length ? Math.max(...prices) : null,
    classes: areas.map((a) => ({
      label: a?.label ?? a?.code ?? '',
      price: Number.isFinite(Number(a?.price)) ? Number(a.price) : null,
      status: a?.seatStatus ?? null,
    })),
  };
}

/* ----------------------------------------------------------- movie page -- */

/**
 * Parse a movie page into the shape the watcher needs.
 *
 * Three states, and telling them apart is the core of this feature:
 *
 *   404                    -- no such movie (fetch.js throws; never reaches here)
 *   movieData only         -- the movie exists, nothing is bookable yet.
 *                             This is the normal state of a watch that is
 *                             waiting, so it must NOT be treated as an error.
 *   movieSessions present  -- booking has opened somewhere in this city.
 *
 * `theatres` is the authoritative answer to "where can I book this right now",
 * but only for `selectedShowDate`. `showDates` is the full date list and is
 * city-wide -- it is NOT per-theatre. Callers must not conflate the two.
 */
export function parseMoviePage(nd) {
  const state = ss(nd);
  const sessionsByCode = state.movieSessions ?? {};
  const eventCode = Object.keys(sessionsByCode)[0] ?? null;
  const ms = eventCode ? sessionsByCode[eventCode] : null;
  // Before any shows exist District parks the same payload under movieData,
  // and swaps it for mdpV2MovieData once there are sessions to render.
  const mdp = first(state.mdpV2MovieData) ?? first(state.movieData);
  const movie = mdp?.movie ?? null;

  // Which shape came back tells us whether the film is bookable at all.
  // movieData alone = nothing on sale anywhere yet; mdpV2MovieData = on sale
  // somewhere, even if this page's single event code doesn't show it.
  const preBooking = !state.mdpV2MovieData && Boolean(state.movieData);

  // Every language/format this film is screening in, with its session count.
  // Only one of these is reflected in arrangedSessions.
  const groups = first(state.movieContents)?.languageFormatGroups ?? [];

  const theatres = (ms?.arrangedSessions ?? []).map((a) => ({
    cinemaId: a?.entityCode != null ? String(a.entityCode) : null,
    name: a?.entityName ?? null,
    address: a?.data?.address ?? null,
    sessions: (a?.sessions ?? []).map(normalizeSession),
  }));

  return {
    eventCode,
    // The movie is known to District; sessions may or may not exist yet.
    found: Boolean(movie),
    hasSessions: Boolean(ms),
    preBooking,
    languageGroups: groups.map((g) => ({
      language: g?.language ?? null,
      format: g?.format ?? null,
      sessions: Number(g?.number_of_sessions) || 0,
    })),
    movie: movie
      ? {
          contentId: movie.content_id != null ? String(movie.content_id) : null,
          name: movie.name ?? null,
          poster: movie.poster ?? movie.horizontal_poster ?? null,
          censor: movie.censor ?? null,
          languages: Array.isArray(movie.languages) ? movie.languages : [],
          durationText: movie.duration_as_string ?? null,
          releaseDate: releaseDate(movie.release_date),
        }
      : null,
    showDates: Array.isArray(ms?.meta?.showDates)
      ? ms.meta.showDates
      : Array.isArray(mdp?.showDates)
        ? mdp.showDates
        : [],
    selectedShowDate: ms?.meta?.selectedShowDate ?? null,
    isReleased: ms?.meta?.isReleased ?? null,
    isFutureShow: ms?.meta?.isFutureShow ?? null,
    futureShowMessage: ms?.meta?.futureShowMessage ?? null,
    theatres,
  };
}

/* ---------------------------------------------------------- cinema page -- */

/**
 * Parse a cinema page: what is bookable at this theatre *today*.
 *
 * Used as a cross-check against the movie page, which orders theatres by
 * distance from a default location and could in principle drop one.
 */
export function parseCinemaPage(nd) {
  const state = ss(nd);
  // The payload is keyed by the cinema id itself, so take the numeric key.
  const key = Object.keys(state).find((k) => /^\d+$/.test(k));
  const cs = key ? state[key] : null;
  if (!cs) return { found: false, cinemaId: null, name: null, movies: [] };

  const grouped = cs.meta?.groupedMovies ?? [];
  const byMovie = new Map(
    (cs.arrangedSessions ?? []).map((a) => [String(a?.entityCode), a?.sessions ?? []]),
  );

  return {
    found: true,
    cinemaId: String(key),
    name: cs.meta?.cinema?.name ?? null,
    address: cs.meta?.cinema?.address ?? null,
    movies: grouped.map((g) => ({
      contentId: g?.contentId != null ? String(g.contentId) : null,
      name: g?.label ?? null,
      sessionCount: Number(g?.totalSessionCount) || 0,
      releaseDate: releaseDate(g?.releaseDate),
      sessions: (byMovie.get(String(g?.contentId)) ?? []).map(normalizeSession),
    })),
  };
}

/* -------------------------------------------------------- listing pages -- */

/**
 * Walk EDSResponse rails and collect every movie / cinema entity.
 *
 * The same rail shape backs the city page, the upcoming page and the cinemas
 * page, so one parser serves all three. Entities repeat across rails; first
 * occurrence wins.
 */
export function parseRails(nd) {
  const rails = ss(nd).EDSResponse?.rails ?? [];
  const movies = new Map();
  const cinemas = new Map();

  const take = (details) => {
    const m = details?.MovieData;
    if (m?.movie_id && !movies.has(String(m.movie_id))) {
      movies.set(String(m.movie_id), {
        contentId: String(m.movie_id),
        name: m.name ?? null,
        poster: m.image ?? null,
        censor: m.censor ?? null,
        genres: Array.isArray(m.genres) ? m.genres : [],
        languages: [...new Set((m.movie_variants ?? []).map((v) => v?.language).filter(Boolean))],
        releaseDate: releaseDate(m.release_date),
      });
    }
    const c = details?.CinemaData;
    if (c?.cinema_id && !cinemas.has(String(c.cinema_id))) {
      cinemas.set(String(c.cinema_id), {
        cinemaId: String(c.cinema_id),
        name: c.cinema_name ?? null,
        address: c.address ?? null,
        logo: c.logo ?? null,
        amenities: Array.isArray(c.amenities) ? c.amenities : [],
      });
    }
  };

  for (const rail of rails) {
    for (const item of rail?.items ?? []) {
      take(item?.ItemDetails);
      // Cinema rails nest the movies playing there as children.
      for (const child of item?.children ?? []) take(child?.ItemDetails);
    }
  }

  return { movies: [...movies.values()], cinemas: [...cinemas.values()] };
}

/**
 * Listing pages link to canonical slugs; the rails payload doesn't carry them.
 * We scrape them off the HTML purely to make emailed links look normal.
 */
export function slugsFromHtml(html, city) {
  const out = { movies: new Map(), cinemas: new Map() };
  // city reaches here from config and from a query parameter, so it must never
  // be interpolated into a pattern raw.
  const c = String(city).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mv = new RegExp(`/movies/([a-z0-9-]+)-movie-tickets-in-${c}-MV(\\d+)`, 'g');
  const cd = new RegExp(`/movies/([a-z0-9-]+)-in-${c}-CD(\\d+)`, 'g');
  for (const m of html.matchAll(mv)) if (!out.movies.has(m[2])) out.movies.set(m[2], m[1]);
  for (const m of html.matchAll(cd)) if (!out.cinemas.has(m[2])) out.cinemas.set(m[2], m[1]);
  return out;
}
