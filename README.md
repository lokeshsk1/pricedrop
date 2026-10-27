# PriceDrop

Two watchers, one inbox.

**Instamart** — watches the price of specific **Swiggy Instamart** products at
*your* delivery location and emails you when one falls below a target you set.

```
search a product  →  pick the exact pack size  →  set a target price
                                                        ↓
                        every 15 min: re-check  →  email when price ≤ target
```

**District** — watches a movie at a specific theatre on **District by Zomato**
and emails you the moment booking opens there.

```
pick a movie  →  pick a theatre
                        ↓
   every 10 min: re-check  →  email when shows appear at that theatre
```

## Why it works this way

Swiggy has no public Instamart API, and their internal one rejects plain HTTP
clients: `curl` gets `403`, and the Instamart page returns `202` with an empty
body behind an AWS WAF bot challenge. Prices are also **store-specific** —
Instamart resolves a store from your saved delivery address, so the same product
has different prices and availability at different locations.

So PriceDrop drives a real browser (Playwright). You log in once, pick your
address, and the session is saved to disk. Every later check runs the API call
*from inside that page*, which inherits the cookies, the bot token and your
store context automatically.

**District needs none of that.** Its pages are plain server-rendered Next.js and
answer `curl` with a `200`, embedding the whole payload in a `__NEXT_DATA__`
script tag — so the movie watcher is ordinary HTTPS GETs, no browser involved.
District *does* have a JSON gateway that takes a date and a theatre id directly,
but it answers `401 Access token not found` without a session, so we read the
pages instead. See [What the District watcher can and can't see](#what-the-district-watcher-can-and-cant-see).

## Setup

```bash
npm install
npx playwright install chromium
```

### 1. Configure email

```bash
cp .env.example .env
```

Fill in `GMAIL_USER` and `GMAIL_APP_PASSWORD`. The app password is **not** your
Google login password — enable 2-Step Verification, then generate one at
[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).

Using a different provider (Zoho, Outlook, Mailgun)? Set `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` instead and Gmail is bypassed.

### 2. Log in to Swiggy (once)

```bash
npm run login
```

A browser window opens. Click **Add your location**, choose your delivery
address, and wait for products to appear. The script detects it and saves the
session to `data/browser-profile/`.

> Skipping this step is the single most common mistake: without an address,
> Instamart serves prices from an arbitrary default store, so your alerts would
> be for the wrong shop. The UI shows a red banner until it's done.

### 3. Run

```bash
npm start          # → http://localhost:3000
```

Search for a product, pick the exact pack size, set a target price, click
**Track**. That's it.

## Using it

- **Test email** — verify your SMTP setup before waiting on a real drop.
- **Check now** — force a check of every tracker instead of waiting for the timer.
- **check / target / pause / delete** — per-tracker controls.

### When do you get an email? (Instamart)

When the product is **in stock** and **either** trigger fires:

- **Target** — the price reaches the figure you set.
- **Drop** — the price falls more than 40% below what the product *usually*
  costs, measured as the median of its own `price_history` over 30 days.

The second exists because an absolute target misses proportional drops: a ₹800
product halving to ₹400 never crosses a ₹60 target. Real example from this
database — `NOICE High Protein Paneer` normally sells at ₹115 and briefly hit
₹49 on 7 Sept, a 57% drop that lasted 24 minutes.

Both triggers share one latch, so a price satisfying both still sends one email.
Tune with `TRACKER_DROP_RATIO` and `TRACKER_MIN_OBSERVATIONS`.

You get **one email per drop event**, not one every cycle. The alert re-arms
only when the price goes back above your target — so a week-long sale sends one
email, not 672.

## Movie booking alerts

In the **Movie booking alerts** panel, type a movie name, pick it from the list,
do the same for a theatre, and click **Notify me**. Upcoming films are included —
which is the point, since the movie you want an alert for usually has no
showtimes yet.

### When do you get an email? (District)

1. **Booking is open** — the first time that theatre has any bookable show for
   that movie. Includes the showtimes, screen, seat-class prices and a link
   straight to seat selection.
2. **New dates on sale** — afterwards, whenever District puts show dates on sale
   that you haven't been told about.

A watch keeps running until you pause or delete it; it is never auto-retired.

### What the District watcher can and can't see

Two quirks of District's server-rendered pages shape the whole design.

**No date parameter is honoured.** The movie page always describes the
*earliest date that has shows*, and lists only the next session per theatre.

**The session list covers one language only.** `movieSessions` carries a single
event code for the default language/format group. Resident Evil lists its 115
Tamil sessions there while its 86 English and 6 Hindi ones are absent — so a
theatre screening only the English print is simply *missing* from that page.

That second one is why the watcher reads two pages, not one:

| | |
|---|---|
| Movie page says your theatre has a show | **trustworthy yes** |
| Movie page doesn't mention your theatre | **inconclusive** — could be another language |
| Cinema page (all languages, today) | **settles it** |
| The full list of dates the movie has shows | exact, but **city-wide** |
| Which dates *this* theatre has shows on | **not available** |

So absence is never treated as "no". Whenever the film is on sale somewhere but
the movie page doesn't list your theatre, the theatre's own page is checked
before concluding anything. The only trustworthy "no" is District's pre-booking
payload, which is a different shape entirely.

The first email is therefore exact: it fires when your theatre genuinely has a
show, in any language. The follow-up "new dates" emails key off the city-wide
date list, so they can mention a date your specific theatre isn't showing — the
email says so rather than implying otherwise.

The fix for the remaining gap is District's gateway API, which takes `date` and
`cinemaIds` directly. If you ever get an access token,
`src/district/fetch.js` is the only file that has to change.

> Language is not currently selectable: a watch fires when the movie is bookable
> at your theatre in *any* language. Adding a language filter means storing a
> `fmtGrpId` alongside the watch.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | — | Gmail account that sends alerts |
| `ALERT_EMAIL` | `GMAIL_USER` | Where alerts are delivered — comma-separate for several recipients |
| `CHECK_INTERVAL_MINUTES` | `15` | How often every active tracker is re-checked |
| `PORT` | `3000` | Web UI port |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | — | Use any SMTP server instead of Gmail |
| `DISTRICT_CITY` | `chennai` | District city slug to search movies and theatres in |
| `DISTRICT_CHECK_INTERVAL_MINUTES` | `10` | How often every active movie watch is re-checked |

## How it's put together

| File | Role |
|---|---|
| `src/swiggy/browser.js` | The persistent browser profile, and a mutex so only one thing drives it at a time |
| `src/swiggy/login.js` | The one-time headed address picker |
| `src/swiggy/api.js` | `search()` and `fetchPrice()` — in-page fetch, with a navigate-and-intercept fallback |
| `src/swiggy/normalize.js` | Swiggy's nested card JSON → a flat product shape |
| `src/scheduler.js` | The interval loop and the alert latch |
| `src/mailer.js` | Nodemailer transport and the alert email |
| `src/db.js` | SQLite schema and queries (`node:sqlite`, no native deps) |
| `src/server.js` | Express: static UI + JSON API |
| `src/deals/baseline.js` | The deal rule: median baseline, threshold, why not MRP |
| `src/deals/catalogue.js` | Sweeps the seed categories and records every price seen |
| `src/deals/scheduler.js` | Sweep loop, alert latch, per-sweep email cap |
| `scripts/discover.js` | Debugging aid: dumps every Instamart API call it sees |
| `scripts/seed-deals.js` | Seeds synthetic price history so deals can be tested at once |
| `src/district/fetch.js` | One GET + `__NEXT_DATA__` extraction — the only place District data enters |
| `src/district/normalize.js` | District's payloads → flat shapes |
| `src/district/catalog.js` | Movie and theatre lookup, cached 6 h |
| `src/district/sessions.js` | "Can I book this movie at this theatre right now?" |
| `src/district/scheduler.js` | The watch loop and the notified-dates latch |
| `scripts/district-discover.js` | Debugging aid: search and check from the CLI |

Re-checks reuse `search()` and re-match on `variationId`, the stable per-pack-size
id. That's deliberate — it means a tracker can never silently drift from
"Amul Taaza 500 ml" onto "Amul Taaza 1 L".


## Deals — products selling below their usual price

A fourth panel lists products that have dropped **below 60% of what they
normally sell for** — discovered across Instamart, not limited to your trackers.

### Why it compares against history, not MRP

Instamart MRPs are frequently inflated to manufacture a permanent discount.
Sampling 320 real products found `Sunfeast Dark Fantasy` at ₹39 against an MRP
of ₹90. Judged against MRP that is "57% off" every day forever, and would alert
endlessly. Judged against its own price history, its median settles at ₹39,
`39 < 0.6 × 39` is false, and it is correctly **not** a deal — until it actually
falls to around ₹22.

So the baseline is the **median price actually observed** for that exact pack
over the last 30 days, and the displayed percentage is how far below *that* the
current price sits.

### How the baseline gets built

A sweep runs every 6 hours over the category list in
[src/deals/seeds.js](src/deals/seeds.js) and records the price of **every**
product it sees — not just the discounted ones.

> That last part is load-bearing. Swiggy's API offers a `discountPercentHighToLow`
> sort, which looks like a cheap way to find deals. Using it would mean only ever
> observing products while they are on offer, which drags every median down to
> the sale price and stops real drops registering. `assertUnbiased()` in
> [src/deals/catalogue.js](src/deals/catalogue.js) exists to prevent that.

A product needs **5 readings** before it gets a baseline, so **the panel is empty
for roughly the first day** while the catalogue fills. It shows its progress
rather than a bare empty list. Press **Sweep now** to speed it up.

### Emails

One email per product when it crosses below the threshold, latched the same way
tracker alerts are: it fires once, and only re-arms once the price climbs back
above. A sweep sends at most `DEAL_MAX_EMAILS_PER_SWEEP` (default 10) individual
emails and rolls any overflow into a single digest, so a mature catalogue can't
produce a 40-email burst.

### Testing it without waiting a day

```bash
node scripts/seed-deals.js             # realistic cases, incl. the fake-deal trap
node scripts/seed-deals.js --many 25   # 25 at once, to exercise the email cap
node scripts/seed-deals.js --clear     # remove everything it created
```

### Tuning

See the `DEAL_*` block in `.env.example`. The notable one is
`DEAL_BASELINE=mrp`, which switches to MRP and works from the very first sweep
with no waiting — at the cost of the fake discounts described above.

## Troubleshooting

**Red banner: "No Swiggy delivery location is set"**
Run `npm run login` again and pick your address.

**"Instamart search failed … Session may need re-login"**
Cookies expired. Run `npm run login`.

**A tracker says "product not found in search results"**
Swiggy's search results shift over time, or the item was delisted at your store.
Delete it and re-add it from a fresh search.

**Prices don't match the Swiggy app**
You're resolving to a different store. Confirm the address in the footer matches
the one in your app, and re-run `npm run login` if not.

**Want to see the raw API traffic**

```bash
npm run discover -- "amul milk"          # headless
npm run discover -- "amul milk" --headed # visible window
```

Captures land in `data/discovery/`.

**A movie or theatre doesn't show up in the pickers**
It's probably not in `DISTRICT_CITY`. Check what the catalogue actually loaded:

```bash
npm run district                              # counts for the configured city
npm run district -- search "jana"             # movies matching a name
npm run district -- theatres "pvr velachery"  # theatres matching a name
npm run district -- check 188681 1022271      # is it bookable there right now?
npm run district -- search "vibe" --city=bengaluru
```

**A watch says "District has no movie &lt;id&gt; in &lt;city&gt;"**
District returned a 404 for that movie in that city — it was pulled, or the city
is wrong. Delete the watch and re-add it.

## Notes and limits

- This uses an undocumented internal API, which is against Swiggy's ToS and can
  break whenever they change it. Request volume is kept low (sequential checks,
  2–4 s jitter). If the response shape changes, `normalize.js` is the file to fix.
- The District watcher reads public pages rather than an API, but it still leans
  on an internal payload shape (`__NEXT_DATA__`) that can change without notice.
  `src/district/normalize.js` is the file to fix when it does. One or two plain
  GETs per watch per cycle, sequential, with the same 2–4 s jitter.
- District has its own in-app "notify me" reminder, which is push-only and
  requires an account. This module is the email equivalent, not a replacement.
- Checks only run while the process is running — a sleeping laptop checks nothing.
- `data/` holds your session cookies and database. It's gitignored; keep it that way.
