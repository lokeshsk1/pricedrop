import nodemailer from 'nodemailer';
import { discountPercent } from './swiggy/normalize.js';
import { seatLayoutUrl } from './district/normalize.js';

const rupees = (n) =>
  n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

let transport = null;

export function mailerConfigured() {
  if (process.env.SMTP_HOST) return true;
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function getTransport() {
  if (!mailerConfigured()) {
    throw new Error(
      'Email is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD in .env ' +
        '(see .env.example for how to generate an app password).',
    );
  }
  if (transport) return transport;

  if (process.env.SMTP_HOST) {
    // Escape hatch for any other provider (Zoho, Outlook, Mailgun) and for
    // pointing at a local SMTP sink during testing.
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: String(process.env.SMTP_SECURE || '') === 'true',
      ignoreTLS: !process.env.SMTP_USER,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  } else {
    transport = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, ''),
      },
    });
  }
  return transport;
}

function recipient() {
  return process.env.ALERT_EMAIL || process.env.GMAIL_USER || process.env.SMTP_USER;
}

/**
 * The address we send *from* has to belong to the transport we're sending
 * through. Preferring GMAIL_USER unconditionally meant that setting SMTP_HOST
 * to Zoho or Outlook still stamped a Gmail From, which those servers reject
 * outright (553, "sender address not owned").
 */
function sender() {
  if (process.env.SMTP_FROM) return process.env.SMTP_FROM;
  if (process.env.SMTP_HOST) return process.env.SMTP_USER || 'pricedrop@localhost';
  return process.env.GMAIL_USER || 'pricedrop@localhost';
}

async function send({ subject, html, text, fromName = 'PriceDrop' }) {
  const info = await getTransport().sendMail({
    from: `"${fromName}" <${sender()}>`,
    to: recipient(),
    subject,
    text,
    html,
  });
  return info.messageId;
}

const shell = (inner, footer = 'Sent by PriceDrop, your local Swiggy Instamart watcher.') => `
<div style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e4e6eb;">
    ${inner}
    <div style="padding:14px 22px;background:#fafbfc;border-top:1px solid #eceef1;color:#8a9099;font-size:12px;">
      ${footer}
    </div>
  </div>
</div>`;

export async function sendDropAlert(tracker, current, reason = null) {
  const was = tracker.last_price;
  const off = discountPercent(current.price, current.mrp);
  const dropped = was != null && was > current.price ? was - current.price : null;
  const title = `${tracker.name}${tracker.quantity ? ` (${tracker.quantity})` : ''}`;

  // Lead with the percentage when the drop rule fired -- "57% below usual" is
  // far more informative than a bare price, and is the reason we alerted.
  const pct = reason?.percentBelow;
  const subject =
    reason?.kind === 'drop' || reason?.kind === 'both'
      ? `${pct}% below usual: ${title} is now ${rupees(current.price)}`
      : `Price drop: ${title} is now ${rupees(current.price)}`;

  const html = shell(`
    <div style="padding:20px 22px;background:#1a7f4b;color:#fff;">
      <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">Price drop</div>
      <div style="font-size:21px;font-weight:600;margin-top:4px;">${
        pct != null && (reason.kind === 'drop' || reason.kind === 'both')
          ? `${pct}% below its usual price`
          : `Now ${rupees(current.price)}`
      }</div>
    </div>
    <div style="padding:22px;">
      <table role="presentation" style="width:100%;border-collapse:collapse;">
        <tr>
          ${
            tracker.image_url
              ? `<td style="width:88px;vertical-align:top;padding-right:14px;">
                   <img src="${tracker.image_url}" width="88" alt="" style="width:88px;border-radius:10px;display:block;border:1px solid #eceef1;">
                 </td>`
              : ''
          }
          <td style="vertical-align:top;">
            <div style="font-size:16px;font-weight:600;color:#1c1f23;line-height:1.35;">${title}</div>
            ${tracker.brand ? `<div style="color:#7a8089;font-size:13px;margin-top:3px;">${tracker.brand}</div>` : ''}
            <div style="margin-top:12px;font-size:15px;color:#1c1f23;">
              ${was != null ? `<span style="color:#9aa0a8;text-decoration:line-through;">${rupees(was)}</span> &nbsp;→&nbsp;` : ''}
              <strong style="color:#1a7f4b;font-size:19px;">${rupees(current.price)}</strong>
            </div>
            ${
              off > 0
                ? `<div style="margin-top:6px;font-size:13px;color:#7a8089;">MRP ${rupees(current.mrp)} · ${off}% off</div>`
                : ''
            }
          </td>
        </tr>
      </table>

      <div style="margin-top:18px;padding:12px 14px;background:#f6f8f7;border-radius:9px;font-size:13px;color:#5a6169;">
        ${
          reason?.kind === 'drop'
            ? `Usually <strong style="color:#1c1f23;">${rupees(reason.baseline)}</strong>
               (median of ${reason.observations} readings over 30 days) — this is
               <strong style="color:#1a7f4b;">${pct}% below</strong> that.
               Still above your ${rupees(tracker.target_price)} target.`
            : reason?.kind === 'both'
              ? `Below your <strong style="color:#1c1f23;">${rupees(tracker.target_price)}</strong> target,
                 and <strong style="color:#1a7f4b;">${pct}% below</strong> its usual
                 ${rupees(reason.baseline)}.`
              : `Your target was <strong style="color:#1c1f23;">${rupees(tracker.target_price)}</strong>${
                  dropped ? ` · dropped <strong style="color:#1a7f4b;">${rupees(dropped)}</strong> since the last check` : ''
                }.`
        }
      </div>

      <a href="${tracker.product_url || 'https://www.swiggy.com/instamart'}"
         style="display:inline-block;margin-top:18px;padding:11px 20px;background:#fc8019;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">
        Open in Instamart
      </a>
    </div>`);

  const text = [
    reason?.kind === 'drop' || reason?.kind === 'both'
      ? `${pct}% below usual: ${title}`
      : `Price drop: ${title}`,
    was != null ? `Was ${rupees(was)} -> now ${rupees(current.price)}` : `Now ${rupees(current.price)}`,
    reason?.baseline ? `Usually ${rupees(reason.baseline)} (${reason.observations} readings)` : '',
    `Your target: ${rupees(tracker.target_price)}`,
    off > 0 ? `MRP ${rupees(current.mrp)} (${off}% off)` : '',
    tracker.product_url || '',
  ]
    .filter(Boolean)
    .join('\n');

  return send({ subject, html, text });
}

export async function sendSessionStaleAlert() {
  const html = shell(`
    <div style="padding:20px 22px;background:#b3341f;color:#fff;">
      <div style="font-size:19px;font-weight:600;">PriceDrop needs a re-login</div>
    </div>
    <div style="padding:22px;font-size:14px;color:#3d434a;line-height:1.6;">
      Your saved Swiggy Instamart session no longer has a delivery location set,
      so price checks are paused — without a location, Instamart returns prices
      for an arbitrary store rather than yours.
      <div style="margin-top:14px;padding:12px 14px;background:#f5f6f7;border-radius:9px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;">
        cd pricedrop &amp;&amp; npm run login
      </div>
      <div style="margin-top:14px;color:#7a8089;font-size:13px;">
        Pick your delivery address in the window that opens. Tracking resumes automatically.
        You'll get this reminder at most once a day.
      </div>
    </div>`);

  return send({
    subject: 'PriceDrop: Swiggy session needs a re-login',
    text: 'Your Swiggy Instamart session lost its delivery location. Run `npm run login` in the pricedrop folder to restore price checks.',
    html,
  });
}

export async function sendTestEmail() {
  const html = shell(`
    <div style="padding:20px 22px;background:#1a7f4b;color:#fff;">
      <div style="font-size:19px;font-weight:600;">Email is working</div>
    </div>
    <div style="padding:22px;font-size:14px;color:#3d434a;line-height:1.6;">
      PriceDrop can reach your inbox. Real alerts will look like this, with the
      product image, the old and new price, and a link into Instamart.
    </div>`);

  return send({
    subject: 'PriceDrop: test email',
    text: 'PriceDrop can reach your inbox. Email is configured correctly.',
    html,
  });
}

/* --------------------------------------------- District booking alerts -- */

const DISTRICT_RED = '#e23744';
const FOOT = 'Sent by PriceDrop, watching District for your movie booking.';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * District timestamps are local wall-clock with no zone ("2026-09-18T13:30").
 * Parsing them as UTC and formatting manually keeps the printed time identical
 * to what the site shows, whatever timezone this process happens to run in.
 */
function parseLocal(ts) {
  const m = String(ts ?? '').match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0'] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
}

const shortDate = (ts) => {
  const d = parseLocal(ts);
  return d ? `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : String(ts ?? '');
};

const clockTime = (ts) => {
  const d = parseLocal(ts);
  if (!d) return '';
  const h = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
};

/**
 * District's `areas[].price` is the base ticket price before booking fees and
 * GST, so it lands on values like 54.35. Printing the paise would imply a
 * precision this number doesn't have -- round, and say what it is below.
 */
const ticket = (n) => `₹${Math.round(Number(n))}`;

/** One showtime row: time, screen, price band, seats left. */
function showRow(s, watch, snapshot) {
  const link = seatLayoutUrl({
    eventCode: snapshot.eventCode,
    contentId: watch.content_id,
    session: s,
  });
  const price =
    s.minPrice == null
      ? ''
      : s.minPrice === s.maxPrice
        ? ticket(s.minPrice)
        : `${ticket(s.minPrice)}–${ticket(s.maxPrice)}`;
  const label = `${clockTime(s.showTime)}${s.audi ? ` · ${s.audi}` : ''}`;

  return `
    <tr>
      <td style="padding:9px 0;border-bottom:1px solid #f0f1f3;font-size:14px;color:#1c1f23;">
        ${link ? `<a href="${link}" style="color:#1c1f23;text-decoration:none;font-weight:600;">${label}</a>` : `<strong>${label}</strong>`}
      </td>
      <td style="padding:9px 0;border-bottom:1px solid #f0f1f3;font-size:13px;color:#7a8089;text-align:right;white-space:nowrap;">
        ${price}${s.seatsAvailable != null ? ` · ${s.seatsAvailable} seats left` : ''}
      </td>
    </tr>`;
}

function movieMeta(watch, snapshot) {
  const bits = [
    snapshot.movie?.censor,
    (snapshot.movie?.languages ?? []).map((l) => String(l).split(' - ')[0]).join(', '),
    snapshot.movie?.durationText,
  ].filter(Boolean);
  return bits.join(' · ');
}

/**
 * Booking just opened at the watched theatre. This is the alert the whole
 * module exists for, so it carries everything needed to decide and click.
 */
export async function sendBookingOpenAlert(watch, snapshot) {
  const sessions = snapshot.theatre?.sessions ?? [];
  const subject = `Booking open: ${watch.movie_name} at ${watch.cinema_name}`;
  const meta = movieMeta(watch, snapshot);
  const poster = watch.poster_url || snapshot.movie?.poster;

  const html = shell(
    `
    <div style="padding:20px 22px;background:${DISTRICT_RED};color:#fff;">
      <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">Booking is open</div>
      <div style="font-size:21px;font-weight:600;margin-top:4px;">${watch.movie_name}</div>
    </div>
    <div style="padding:22px;">
      <table role="presentation" style="width:100%;border-collapse:collapse;">
        <tr>
          ${
            poster
              ? `<td style="width:88px;vertical-align:top;padding-right:14px;">
                   <img src="${poster}" width="88" alt="" style="width:88px;border-radius:10px;display:block;border:1px solid #eceef1;">
                 </td>`
              : ''
          }
          <td style="vertical-align:top;">
            <div style="font-size:16px;font-weight:600;color:#1c1f23;line-height:1.35;">${watch.cinema_name}</div>
            ${snapshot.theatre?.address ? `<div style="color:#7a8089;font-size:13px;margin-top:3px;line-height:1.45;">${snapshot.theatre.address}</div>` : ''}
            ${meta ? `<div style="color:#7a8089;font-size:13px;margin-top:8px;">${meta}</div>` : ''}
          </td>
        </tr>
      </table>

      ${
        sessions.length
          ? `<div style="margin-top:20px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#9aa0a8;">
               Showing ${shortDate(snapshot.selectedShowDate)}
             </div>
             <table role="presentation" style="width:100%;border-collapse:collapse;margin-top:4px;">
               ${sessions.map((s) => showRow(s, watch, snapshot)).join('')}
             </table>`
          : ''
      }

      <div style="margin-top:18px;padding:12px 14px;background:#fdf3f4;border-radius:9px;font-size:13px;color:#5a6169;line-height:1.55;">
        ${
          snapshot.showDates?.length
            ? `Dates on sale: <strong style="color:#1c1f23;">${shortDate(snapshot.showDates[0])} – ${shortDate(snapshot.showDates[snapshot.showDates.length - 1])}</strong>.`
            : 'Shows are now listed for this theatre.'
        }
        ${snapshot.futureShowMessage ? `<br>${snapshot.futureShowMessage}.` : ''}
        ${sessions.some((s) => s.minPrice != null) ? '<br><span style="color:#9aa0a8;">Prices shown are base ticket prices, before booking fees.</span>' : ''}
      </div>

      <a href="${snapshot.movieLink}"
         style="display:inline-block;margin-top:18px;padding:11px 20px;background:${DISTRICT_RED};color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">
        Book on District
      </a>
    </div>`,
    FOOT,
  );

  const text = [
    `Booking is open: ${watch.movie_name}`,
    `at ${watch.cinema_name}`,
    '',
    ...sessions.map(
      (s) =>
        `  ${clockTime(s.showTime)}${s.audi ? ` (${s.audi})` : ''}` +
        `${s.minPrice != null ? ` — ${ticket(s.minPrice)}–${ticket(s.maxPrice)}` : ''}` +
        `${s.seatsAvailable != null ? `, ${s.seatsAvailable} seats left` : ''}`,
    ),
    '',
    snapshot.showDates?.length ? `Dates on sale: ${snapshot.showDates.join(', ')}` : '',
    snapshot.movieLink,
  ]
    .filter(Boolean)
    .join('\n');

  return send({ subject, html, text, fromName: 'District Notifier' });
}

/**
 * Follow-up alert: District has put dates on sale that we haven't mentioned.
 *
 * Deliberately worded as city-wide, because that is what showDates actually
 * is. We know the theatre is still showing the film, but not that it has a
 * show on each of these specific dates -- claiming otherwise would be a lie
 * the payload can't back up.
 */
export async function sendNewDatesAlert(watch, snapshot, newDates) {
  const subject = `New dates on sale: ${watch.movie_name} at ${watch.cinema_name}`;
  const list = newDates.map(shortDate).join(', ');

  const html = shell(
    `
    <div style="padding:20px 22px;background:#1c1f23;color:#fff;">
      <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.75;">New dates on sale</div>
      <div style="font-size:20px;font-weight:600;margin-top:4px;">${watch.movie_name}</div>
    </div>
    <div style="padding:22px;font-size:14px;color:#3d434a;line-height:1.6;">
      District has opened booking for <strong style="color:#1c1f23;">${list}</strong>.
      <div style="margin-top:14px;padding:12px 14px;background:#f5f6f7;border-radius:9px;font-size:13px;color:#5a6169;line-height:1.55;">
        ${watch.cinema_name} is still showing this film, but District only publishes
        its date list city-wide — check the page to confirm this theatre has a show
        on the date you want.
      </div>
      <a href="${snapshot.movieLink}"
         style="display:inline-block;margin-top:18px;padding:11px 20px;background:${DISTRICT_RED};color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">
        Open on District
      </a>
    </div>`,
    FOOT,
  );

  const text = [
    `New dates on sale for ${watch.movie_name}`,
    `Theatre watched: ${watch.cinema_name}`,
    `Dates: ${newDates.join(', ')}`,
    '',
    'District publishes its date list city-wide, so confirm this theatre has a show on your date.',
    snapshot.movieLink,
  ].join('\n');

  return send({ subject, html, text, fromName: 'District Notifier' });
}

/* -------------------------------------------------------- Deals discovery -- */

/**
 * The headline is "usually X, now Y" -- deliberately not the MRP.
 *
 * The whole premise of the deals view is that the baseline is what the product
 * actually sells for, so that is what the email has to lead with. Showing MRP
 * here would reintroduce exactly the fake-discount noise the feature avoids.
 */
export async function sendDealAlert(deal) {
  const title = `${deal.name}${deal.quantity ? ` (${deal.quantity})` : ''}`;
  const subject = `${deal.percentBelow}% below usual: ${title} at ${rupees(deal.price)}`;

  const html = shell(`
    <div style="padding:20px 22px;background:#1a7f4b;color:#fff;">
      <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">Deal found</div>
      <div style="font-size:21px;font-weight:600;margin-top:4px;">${deal.percentBelow}% below its usual price</div>
    </div>
    <div style="padding:22px;">
      <table role="presentation" style="width:100%;border-collapse:collapse;">
        <tr>
          ${
            deal.imageUrl
              ? `<td style="width:88px;vertical-align:top;padding-right:14px;">
                   <img src="${deal.imageUrl}" width="88" alt="" style="width:88px;border-radius:10px;display:block;border:1px solid #eceef1;">
                 </td>`
              : ''
          }
          <td style="vertical-align:top;">
            <div style="font-size:16px;font-weight:600;color:#1c1f23;line-height:1.35;">${title}</div>
            ${deal.brand ? `<div style="color:#7a8089;font-size:13px;margin-top:3px;">${deal.brand}</div>` : ''}
            <div style="margin-top:12px;font-size:15px;color:#1c1f23;">
              usually <span style="color:#9aa0a8;text-decoration:line-through;">${rupees(deal.baseline)}</span>
              &nbsp;→&nbsp;
              <strong style="color:#1a7f4b;font-size:19px;">${rupees(deal.price)}</strong>
            </div>
          </td>
        </tr>
      </table>

      <div style="margin-top:18px;padding:12px 14px;background:#f6f8f7;border-radius:9px;font-size:13px;color:#5a6169;">
        "Usually" is the median of <strong style="color:#1c1f23;">${deal.observations}</strong>
        prices observed for this exact pack over the last 30 days${
          deal.category ? ` · found under <strong style="color:#1c1f23;">${deal.category}</strong>` : ''
        }.
      </div>

      <a href="${deal.url || 'https://www.swiggy.com/instamart'}"
         style="display:inline-block;margin-top:18px;padding:11px 20px;background:#fc8019;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">
        Open in Instamart
      </a>
    </div>`);

  const text = [
    `${deal.percentBelow}% below usual: ${title}`,
    `usually ${rupees(deal.baseline)} -> now ${rupees(deal.price)}`,
    `based on ${deal.observations} observed prices over the last 30 days`,
    deal.url || '',
  ]
    .filter(Boolean)
    .join('\n');

  return send({ subject, html, text });
}

/**
 * Overflow summary.
 *
 * A sweep across a mature catalogue can cross the threshold on dozens of
 * products at once. Rather than send dozens of mails, the first N go out
 * individually and everything past the cap arrives as one of these.
 */
export async function sendDealDigest(deals, { title = null } = {}) {
  const n = deals.length;
  const deepest = Math.max(...deals.map((d) => d.percentBelow || 0));
  const heading = title || (n === 1 ? '1 deal below its usual price' : `${n} deals below their usual price`);
  const subject =
    n === 1
      ? `${deals[0].percentBelow}% below usual: ${deals[0].name}`
      : `${n} Instamart deals — up to ${deepest}% below usual`;

  const rows = deals
    .map(
      (d) => `
      <tr>
        ${
          d.imageUrl
            ? `<td style="width:56px;padding:10px 12px 10px 0;border-bottom:1px solid #eef0f2;vertical-align:top;">
                 <img src="${d.imageUrl}" width="56" alt="" style="width:56px;border-radius:8px;display:block;border:1px solid #eceef1;">
               </td>`
            : '<td style="width:0;border-bottom:1px solid #eef0f2;"></td>'
        }
        <td style="padding:10px 0;border-bottom:1px solid #eef0f2;vertical-align:top;">
          <div style="font-size:14px;font-weight:600;color:#1c1f23;line-height:1.35;">${d.name}${
            d.quantity ? ` <span style="color:#8a9099;font-weight:400;">· ${d.quantity}</span>` : ''
          }</div>
          <div style="font-size:13px;color:#5a6169;margin-top:4px;">
            usually <span style="color:#9aa0a8;text-decoration:line-through;">${rupees(d.baseline)}</span>
            &nbsp;→&nbsp; <strong style="color:#1a7f4b;font-size:15px;">${rupees(d.price)}</strong>
            &nbsp;<span style="background:#e2f5ea;color:#1a7f4b;border-radius:20px;padding:1px 8px;font-size:11.5px;font-weight:600;">${d.percentBelow}% below</span>
          </div>
          <div style="font-size:11.5px;color:#9aa0a8;margin-top:3px;">
            from ${d.observations} readings${d.category ? ` · ${d.category}` : ''}
          </div>
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #eef0f2;text-align:right;vertical-align:top;white-space:nowrap;">
          <a href="${d.url || 'https://www.swiggy.com/instamart'}"
             style="display:inline-block;padding:7px 14px;background:#fc8019;color:#fff;text-decoration:none;border-radius:7px;font-weight:600;font-size:12.5px;">open</a>
        </td>
      </tr>`,
    )
    .join('');

  const html = shell(`
    <div style="padding:20px 22px;background:#1a7f4b;color:#fff;">
      <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">Instamart</div>
      <div style="font-size:21px;font-weight:600;margin-top:4px;">${heading}</div>
    </div>
    <div style="padding:22px;">
      <table role="presentation" style="width:100%;border-collapse:collapse;">${rows}</table>
      <div style="margin-top:18px;padding:12px 14px;background:#f6f8f7;border-radius:9px;font-size:12.5px;color:#5a6169;">
        "Usually" is the median price actually observed for each pack over the last
        14 days — not MRP. Instamart discounts are often short-lived, so these may
        not last long.
      </div>
    </div>`);

  const text = deals
    .map(
      (d) =>
        `${d.percentBelow}% below usual — ${d.name}${d.quantity ? ' ' + d.quantity : ''}: ` +
        `usually ${rupees(d.baseline)} -> ${rupees(d.price)}\n  ${d.url || ''}`,
    )
    .join('\n');

  return send({ subject, html, text });
}

