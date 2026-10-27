/**
 * The question this whole module exists to answer:
 * "can I book <movie> at <theatre> right now?"
 *
 * Two pages, because neither alone is sufficient:
 *
 *   The movie page covers dates beyond today. When a film has no shows today,
 *   District's SSR falls forward to the earliest date that *does* have shows
 *   and returns those sessions -- so advance booking that just opened for next
 *   Friday shows up immediately, which is the moment we want to catch. But its
 *   session list covers only one language/format group, so a theatre screening
 *   a different print of the same film is simply absent.
 *
 *   The cinema page lists every film bookable at one theatre today, across all
 *   languages. It settles the theatre question the movie page can only hint at.
 *
 * So: the movie page is authoritative when it says YES, and merely inconclusive
 * when it says nothing. Only the pre-booking payload shape is a trustworthy NO.
 */
import { fetchNextData, BASE } from './fetch.js';
import { parseMoviePage, parseCinemaPage, movieUrl, cinemaUrl } from './normalize.js';

/**
 * @returns {{
 *   open: boolean, theatre: object|null, showDates: string[],
 *   selectedShowDate: string|null, futureShowMessage: string|null,
 *   movie: object|null, eventCode: string|null, via: string
 * }}
 */
export async function checkBooking({ city, contentId, movieSlug, cinemaId, cinemaSlug }) {
  const page = parseMoviePage(
    await fetchNextData(movieUrl(city, contentId, movieSlug ?? undefined)),
  );

  // A movie District doesn't know about is a broken watch; a movie with no
  // sessions yet is the entire point of the watch. Only the first is an error.
  if (!page.found) {
    throw new Error(`District has no movie ${contentId} in ${city}`);
  }

  const base = {
    movie: page.movie,
    movieLink: `${BASE}${movieUrl(city, contentId, movieSlug ?? undefined)}`,
    eventCode: page.eventCode,
    showDates: page.showDates,
    selectedShowDate: page.selectedShowDate,
    isReleased: page.isReleased,
    isFutureShow: page.isFutureShow,
    futureShowMessage: page.futureShowMessage,
    languageGroups: page.languageGroups,
    theatresPlaying: page.theatres.length,
  };

  // The pre-booking payload shape is the one unambiguous "no": District is
  // serving the placeholder record, so nothing is on sale in any language.
  if (page.preBooking || !page.hasSessions) {
    return { ...base, open: false, theatre: null, via: 'movie-page' };
  }

  const hit = page.theatres.find((t) => t.cinemaId === String(cinemaId));
  if (hit && hit.sessions.length) {
    return { ...base, open: true, theatre: hit, via: 'movie-page' };
  }

  // The film is on sale somewhere, but this page only ever describes one
  // language group and orders theatres by distance from a default location.
  // Its silence about our theatre proves nothing, so ask the theatre directly
  // -- including when it listed no theatres at all, which happens when the
  // watched print isn't the default one.
  let cinema;
  try {
    cinema = parseCinemaPage(await fetchNextData(cinemaUrl(city, cinemaId, cinemaSlug ?? undefined)));
  } catch {
    // Cross-check is best-effort; a failure here just means we fall back to
    // what the movie page told us rather than failing the whole check.
    return { ...base, open: false, theatre: null, via: 'movie-page' };
  }

  // parseCinemaPage keys off the first all-digit key in the payload, so make
  // sure District actually served us the theatre we asked about.
  if (cinema.cinemaId !== String(cinemaId)) {
    return { ...base, open: false, theatre: null, via: 'cinema-page-mismatch' };
  }

  const playing = cinema.movies.find((m) => m.contentId === String(contentId));
  if (playing && playing.sessionCount > 0) {
    return {
      ...base,
      open: true,
      theatre: {
        cinemaId: cinema.cinemaId,
        name: cinema.name,
        address: cinema.address,
        sessions: playing.sessions,
      },
      via: 'cinema-page',
    };
  }

  return { ...base, open: false, theatre: null, via: 'cinema-page' };
}
