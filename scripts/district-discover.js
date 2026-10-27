/**
 * Debugging aid for the District module, mirroring scripts/discover.js.
 *
 *   npm run district -- search "sardar"          movies matching a name
 *   npm run district -- theatres "pvr velachery" theatres matching a name
 *   npm run district -- check 194529 1022271     is it bookable there?
 *
 * Add --city=<slug> to look somewhere other than DISTRICT_CITY.
 */
import 'dotenv/config';
import { searchMovies, searchTheatres, catalogStatus } from '../src/district/catalog.js';
import { checkBooking } from '../src/district/sessions.js';
import { CITY_DEFAULT } from '../src/district/normalize.js';

const argv = process.argv.slice(2);
const cityArg = argv.find((a) => a.startsWith('--city='));
const city = cityArg ? cityArg.slice(7) : process.env.DISTRICT_CITY || CITY_DEFAULT;
const args = argv.filter((a) => !a.startsWith('--'));
const [cmd, ...rest] = args;

const pad = (s, n) => String(s ?? '').padEnd(n);

if (cmd === 'search') {
  const hits = await searchMovies(city, rest.join(' '));
  console.log(`\n  ${hits.length} movie(s) in ${city}\n`);
  for (const m of hits) {
    console.log(`  ${pad(m.contentId, 8)} ${pad(m.name, 38)} ${pad(m.releaseDate ?? '—', 12)} ${m.languages.join('/')}`);
  }
} else if (cmd === 'theatres') {
  const hits = await searchTheatres(city, rest.join(' '));
  console.log(`\n  ${hits.length} theatre(s) in ${city}\n`);
  for (const c of hits) console.log(`  ${pad(c.cinemaId, 10)} ${c.name}`);
} else if (cmd === 'check') {
  const [contentId, cinemaId] = rest;
  if (!contentId || !cinemaId) {
    console.error('  usage: check <contentId> <cinemaId>');
    process.exit(1);
  }
  const r = await checkBooking({ city, contentId, cinemaId });
  console.log(`\n  ${r.movie?.name ?? contentId} @ cinema ${cinemaId} (${city})`);
  console.log(`  open:            ${r.open ? 'YES' : 'no'}   (via ${r.via})`);
  console.log(`  theatres playing: ${r.theatresPlaying}`);
  console.log(`  showDates:        ${r.showDates.join(', ') || '—'}`);
  console.log(`  selectedShowDate: ${r.selectedShowDate ?? '—'}`);
  console.log(`  futureShowMessage: ${r.futureShowMessage ?? '—'}`);
  for (const s of r.theatre?.sessions ?? []) {
    console.log(`    · ${s.showTime}  ${pad(s.audi, 12)} ₹${s.minPrice}–${s.maxPrice}  ${s.seatsAvailable}/${s.seatsTotal} free`);
  }
} else {
  console.log(await catalogStatus(city));
  console.log('\n  commands: search <name> | theatres <name> | check <contentId> <cinemaId>');
}
