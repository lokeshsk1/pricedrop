const $ = (id) => document.getElementById(id);
const rupees = (n) =>
  n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function setStatus(el, msg, kind = '') {
  el.textContent = msg || '';
  el.className = `status ${kind}`;
  el.hidden = !msg;
}

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* ---------------- search + track ---------------- */

let lastQuery = '';

$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('search-input').value.trim();
  if (!q) return;

  lastQuery = q;
  $('search-btn').disabled = true;
  setStatus($('search-status'), 'Searching Instamart…');
  $('results').innerHTML = '';

  try {
    const { products } = await api(`/api/search?q=${encodeURIComponent(q)}`);
    setStatus(
      $('search-status'),
      products.length
        ? `${products.length} result(s). Set a target price and click Track.`
        : 'No products found.',
    );
    renderResults(products);
  } catch (err) {
    setStatus($('search-status'), err.message, 'err');
  } finally {
    $('search-btn').disabled = false;
  }
});

function renderResults(products) {
  $('results').innerHTML = products
    .map((p, i) => {
      // Default the target just under the current price -- the common intent.
      const suggested = Math.max(1, Math.floor(p.price * 0.9));
      const off = p.mrp > p.price ? `<s>${rupees(p.mrp)}</s>` : '';
      return `
      <div class="card" data-i="${i}">
        ${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="" loading="lazy">` : ''}
        <div class="nm">${esc(p.name)}</div>
        <div class="qt">${esc(p.quantity || '')}</div>
        <div class="pr">${rupees(p.price)}${off}</div>
        ${p.inStock ? '' : '<div class="oos">Out of stock</div>'}
        <div class="track-row">
          <input type="number" min="1" step="0.5" value="${suggested}" aria-label="Target price">
          <button type="button">Track</button>
        </div>
      </div>`;
    })
    .join('');

  $('results').querySelectorAll('.card').forEach((card) => {
    const product = products[Number(card.dataset.i)];
    const input = card.querySelector('input');
    const btn = card.querySelector('button');

    btn.addEventListener('click', async () => {
      const targetPrice = Number(input.value);
      if (!(targetPrice > 0)) return setStatus($('search-status'), 'Enter a target price above 0.', 'err');

      btn.disabled = true;
      btn.textContent = '…';
      try {
        await api('/api/trackers', { method: 'POST', body: { query: lastQuery, product, targetPrice } });
        btn.textContent = 'Tracking ✓';
        setStatus($('search-status'), `Now watching ${product.name} for ${rupees(targetPrice)} or less.`, 'ok');
        loadTrackers();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Track';
        setStatus($('search-status'), err.message, 'err');
      }
    });
  });
}

/* ---------------- tracked list ---------------- */

function badge(t) {
  if (t.status === 'paused') return '<span class="badge b-pause">paused</span>';
  if (t.last_error) return '<span class="badge b-err">error</span>';
  if (t.last_checked_at && !t.last_in_stock) return '<span class="badge b-oos">out of stock</span>';
  if (t.notified_price != null) return '<span class="badge b-drop">dropped ✓</span>';
  return '<span class="badge b-watch">watching</span>';
}

async function loadTrackers() {
  try {
    const { trackers } = await api('/api/trackers');
    $('tracker-count').textContent = trackers.length ? `(${trackers.length})` : '';

    if (!trackers.length) {
      $('trackers').innerHTML = '<div class="empty">Nothing tracked yet — search above to add something.</div>';
      return;
    }

    $('trackers').innerHTML = trackers
      .map(
        (t) => `
      <div class="row" data-id="${t.id}">
        ${t.image_url ? `<img src="${esc(t.image_url)}" alt="" loading="lazy">` : ''}
        <div class="info">
          <div class="nm">${esc(t.name)}${t.quantity ? ` <span class="qt">· ${esc(t.quantity)}</span>` : ''}</div>
          <div class="meta">
            Target ${rupees(t.target_price)} · checked ${ago(t.last_checked_at)} ${badge(t)}
          </div>
          ${t.last_error ? `<div class="meta" style="color:var(--bad)">${esc(t.last_error)}</div>` : ''}
        </div>
        <div class="right">
          <div class="now">${rupees(t.last_price)}</div>
          <div class="rowbtns">
            <button class="link" data-act="check">check</button>
            <button class="link" data-act="edit">target</button>
            <button class="link" data-act="toggle">${t.status === 'paused' ? 'resume' : 'pause'}</button>
            <button class="link danger" data-act="del">delete</button>
          </div>
        </div>
      </div>`,
      )
      .join('');

    $('trackers').querySelectorAll('.row').forEach((row) => {
      const id = Number(row.dataset.id);
      const t = trackers.find((x) => x.id === id);

      row.querySelectorAll('button[data-act]').forEach((b) => {
        b.addEventListener('click', async () => {
          const act = b.dataset.act;
          b.disabled = true;
          try {
            if (act === 'check') {
              setStatus($('tracker-status'), `Checking ${t.name}…`);
              const { result } = await api(`/api/trackers/${id}/check`, { method: 'POST' });
              setStatus(
                $('tracker-status'),
                result.ok
                  ? `${t.name}: ${rupees(result.price)}${result.fired ? ' — alert email sent!' : ''}`
                  : `${t.name}: ${result.error}`,
                result.ok ? 'ok' : 'err',
              );
            } else if (act === 'edit') {
              const v = prompt(`Target price for ${t.name}:`, t.target_price);
              if (v == null) return;
              // NaN would serialise to null and be silently ignored server-side.
              if (!(Number(v) > 0)) {
                return setStatus($('tracker-status'), 'Enter a target price above 0.', 'err');
              }
              await api(`/api/trackers/${id}`, { method: 'PATCH', body: { targetPrice: Number(v) } });
            } else if (act === 'toggle') {
              await api(`/api/trackers/${id}`, {
                method: 'PATCH',
                body: { status: t.status === 'paused' ? 'active' : 'paused' },
              });
            } else if (act === 'del') {
              if (!confirm(`Stop tracking ${t.name}?`)) return;
              await api(`/api/trackers/${id}`, { method: 'DELETE' });
            }
          } catch (err) {
            setStatus($('tracker-status'), err.message, 'err');
          } finally {
            loadTrackers();
          }
        });
      });
    });
  } catch (err) {
    setStatus($('tracker-status'), err.message, 'err');
  }
}

/* ---------------- toolbar ---------------- */

$('check-all').addEventListener('click', async (e) => {
  e.target.disabled = true;
  setStatus($('tracker-status'), 'Checking every active tracker…');
  try {
    const { result } = await api('/api/check-all', { method: 'POST' });
    // A cycle that threw still returns 200, with the reason in result.error.
    if (result.error) setStatus($('tracker-status'), result.error, 'err');
    else
      setStatus(
        $('tracker-status'),
        result.skipped
          ? `Skipped: ${result.skipped}`
          : `Checked ${result.checked ?? 0} tracker(s), ${result.fired ?? 0} alert(s) sent.`,
        'ok',
      );
  } catch (err) {
    setStatus($('tracker-status'), err.message, 'err');
  } finally {
    e.target.disabled = false;
    loadTrackers();
  }
});

$('test-email').addEventListener('click', async (e) => {
  e.target.disabled = true;
  setStatus($('tracker-status'), 'Sending test email…');
  try {
    const r = await api('/api/test-email', { method: 'POST' });
    setStatus($('tracker-status'), `Test email sent to ${r.sentTo}.`, 'ok');
  } catch (err) {
    setStatus($('tracker-status'), err.message, 'err');
  } finally {
    e.target.disabled = false;
  }
});

/* ---------------- session banner ---------------- */

async function loadSession() {
  try {
    const s = await api('/api/session');
    const notes = [];

    if (s.needsLocation) {
      notes.push({
        kind: 'warn',
        html: 'No Swiggy delivery location is set, so prices come from an arbitrary default store. Run <code>npm run login</code> and pick your address.',
      });
    }
    if (!s.emailConfigured) {
      notes.push({
        kind: 'warn',
        html: 'Email is not configured — alerts cannot be sent. Copy <code>.env.example</code> to <code>.env</code> and add your Gmail app password.',
      });
    }

    const b = $('banner');
    if (notes.length) {
      b.hidden = false;
      b.className = `banner ${notes[0].kind}`;
      b.innerHTML = notes.map((n) => `<div>${n.html}</div>`).join('');
    } else {
      b.hidden = true;
    }

    $('foot').textContent =
      `Checking every ${s.intervalMinutes} min · last run ${ago(s.lastRunAt)}` +
      (s.address ? ` · ${s.address}` : '') +
      (s.storeId ? ` · store ${s.storeId}` : '');
  } catch (err) {
    $('foot').textContent = `Status unavailable: ${err.message}`;
  }
}

loadTrackers();
loadSession();
setInterval(loadTrackers, 30_000);
setInterval(loadSession, 120_000);

/* ---------------- District booking alerts ---------------- */

// What the two pickers currently hold. A watch needs both.
const picked = { movie: null, theatre: null };

const shortDate = (d, withYear = false) => {
  const t = new Date(`${d}T00:00:00`);
  if (Number.isNaN(+t)) return d;
  return t.toLocaleDateString('en-IN', {
    weekday: withYear ? undefined : 'short',
    day: 'numeric',
    month: 'short',
    // Release dates run years out, and "Thu, 23 Jul" alone is ambiguous.
    // On-sale dates are always within the next week, so they don't need it.
    year: withYear ? 'numeric' : undefined,
  });
};

/** Debounced type-ahead over one of the two catalogue endpoints. */
function wirePicker({ input, list, endpoint, key, render }) {
  let timer = null;

  const close = () => {
    list.hidden = true;
    list.innerHTML = '';
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    // Selecting then editing the text means the old pick no longer matches
    // what's on screen, so drop it rather than leave a stale selection.
    picked[key] = null;
    renderChosen();
    if (q.length < 2) return close();

    timer = setTimeout(async () => {
      try {
        const data = await api(`${endpoint}?q=${encodeURIComponent(q)}`);
        const items = data[key === 'movie' ? 'movies' : 'theatres'];
        list.hidden = false;
        list.innerHTML = items.length
          ? items.map((it, i) => `<button type="button" data-i="${i}">${render(it)}</button>`).join('')
          : '<div class="none">No matches in this city.</div>';

        list.querySelectorAll('button[data-i]').forEach((b) => {
          b.addEventListener('click', () => {
            picked[key] = items[Number(b.dataset.i)];
            input.value = picked[key].name;
            close();
            renderChosen();
          });
        });
      } catch (err) {
        list.hidden = false;
        list.innerHTML = `<div class="none">${esc(err.message)}</div>`;
      }
    }, 250);
  });

  // Let a click land before the blur tears the list down.
  input.addEventListener('blur', () => setTimeout(close, 150));
}

function renderChosen() {
  const box = $('dx-chosen');
  if (!picked.movie || !picked.theatre) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = `
    <div class="who">
      Watch <strong>${esc(picked.movie.name)}</strong>
      at <strong>${esc(picked.theatre.name)}</strong>
      ${picked.movie.releaseDate ? `<br><span class="count">Releases ${esc(shortDate(picked.movie.releaseDate, true))}</span>` : ''}
    </div>
    <button type="button" id="dx-add">Notify me</button>`;

  $('dx-add').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('/api/district/watches', {
        method: 'POST',
        body: { movie: picked.movie, theatre: picked.theatre },
      });
      setStatus(
        $('dx-status'),
        `Watching ${picked.movie.name} at ${picked.theatre.name}. You'll get an email when booking opens.`,
        'ok',
      );
      picked.movie = null;
      picked.theatre = null;
      $('dx-movie').value = '';
      $('dx-theatre').value = '';
      renderChosen();
      loadWatches();
    } catch (err) {
      e.target.disabled = false;
      setStatus($('dx-status'), err.message, 'err');
    }
  });
}

wirePicker({
  input: $('dx-movie'),
  list: $('dx-movie-list'),
  endpoint: '/api/district/movies',
  key: 'movie',
  render: (m) =>
    `${esc(m.name)}<span class="sub2">${[m.releaseDate ? shortDate(m.releaseDate, true) : null, m.languages?.join(', ')]
      .filter(Boolean)
      .map(esc)
      .join(' · ')}</span>`,
});

wirePicker({
  input: $('dx-theatre'),
  list: $('dx-theatre-list'),
  endpoint: '/api/district/theatres',
  key: 'theatre',
  render: (t) => esc(t.name),
});

function watchBadge(w) {
  if (w.status === 'paused') return '<span class="badge b-pause">paused</span>';
  if (w.last_error) return '<span class="badge b-err">error</span>';
  if (w.last_open) return '<span class="badge b-open">booking open ✓</span>';
  return '<span class="badge b-soon">waiting</span>';
}

async function loadWatches() {
  try {
    const { watches } = await api('/api/district/watches');
    $('dx-count').textContent = watches.length ? `(${watches.length})` : '';

    if (!watches.length) {
      $('dx-watches').innerHTML =
        '<div class="empty">No movie watches yet — pick a movie and a theatre above.</div>';
      return;
    }

    $('dx-watches').innerHTML = watches
      .map((w) => {
        const dates = w.lastShowDates || [];
        const span = dates.length
          ? `${shortDate(dates[0])}${dates.length > 1 ? ` – ${shortDate(dates[dates.length - 1])}` : ''}`
          : null;
        return `
      <div class="row dx" data-id="${w.id}">
        ${w.poster_url ? `<img src="${esc(w.poster_url)}" alt="" loading="lazy">` : ''}
        <div class="info">
          <div class="nm">${esc(w.movie_name)}</div>
          <div class="meta">${esc(w.cinema_name)}</div>
          <div class="meta">
            checked ${ago(w.last_checked_at)} ${watchBadge(w)}
            ${span ? ` · on sale ${esc(span)}` : ''}
          </div>
          ${w.last_status_note && !w.last_error ? `<div class="meta">${esc(w.last_status_note)}</div>` : ''}
          ${w.last_error ? `<div class="meta" style="color:var(--bad)">${esc(w.last_error)}</div>` : ''}
        </div>
        <div class="right">
          <div class="rowbtns">
            <button class="link" data-act="check">check</button>
            <button class="link" data-act="toggle">${w.status === 'paused' ? 'resume' : 'pause'}</button>
            <button class="link danger" data-act="del">delete</button>
          </div>
        </div>
      </div>`;
      })
      .join('');

    $('dx-watches').querySelectorAll('.row').forEach((row) => {
      const id = Number(row.dataset.id);
      const w = watches.find((x) => x.id === id);

      row.querySelectorAll('button[data-act]').forEach((b) => {
        b.addEventListener('click', async () => {
          const act = b.dataset.act;
          b.disabled = true;
          try {
            if (act === 'check') {
              setStatus($('dx-status'), `Checking ${w.movie_name}…`);
              const { result } = await api(`/api/district/watches/${id}/check`, { method: 'POST' });
              setStatus(
                $('dx-status'),
                result.ok
                  ? `${w.movie_name}: ${result.note}${result.fired ? ' — alert email sent!' : ''}`
                  : `${w.movie_name}: ${result.error}`,
                result.ok ? 'ok' : 'err',
              );
            } else if (act === 'toggle') {
              await api(`/api/district/watches/${id}`, {
                method: 'PATCH',
                body: { status: w.status === 'paused' ? 'active' : 'paused' },
              });
            } else if (act === 'del') {
              if (!confirm(`Stop watching ${w.movie_name} at ${w.cinema_name}?`)) return;
              await api(`/api/district/watches/${id}`, { method: 'DELETE' });
            }
          } catch (err) {
            setStatus($('dx-status'), err.message, 'err');
          } finally {
            loadWatches();
          }
        });
      });
    });
  } catch (err) {
    setStatus($('dx-status'), err.message, 'err');
  }
}

$('dx-check-all').addEventListener('click', async (e) => {
  e.target.disabled = true;
  setStatus($('dx-status'), 'Checking every active watch…');
  try {
    const { result } = await api('/api/district/check-all', { method: 'POST' });
    if (result.error) setStatus($('dx-status'), result.error, 'err');
    else
      setStatus(
        $('dx-status'),
        result.skipped
          ? `Skipped: ${result.skipped}`
          : `Checked ${result.checked ?? 0} watch(es), ${result.fired ?? 0} alert(s) sent.`,
        'ok',
      );
  } catch (err) {
    setStatus($('dx-status'), err.message, 'err');
  } finally {
    e.target.disabled = false;
    loadWatches();
  }
});

/**
 * Surface the District city explicitly. The pickers only ever search
 * DISTRICT_CITY, so "my theatre isn't in the list" is almost always "it's in a
 * different city" -- and there is nothing else on the page that says which.
 */
async function loadDistrictStatus() {
  try {
    const s = await api('/api/district/status');
    const bits = [`District: ${s.city}`];
    if (s.catalog) bits.push(`${s.catalog.movies} movies · ${s.catalog.theatres} theatres`);
    bits.push(`checking every ${s.intervalMinutes} min`);
    bits.push(`last run ${ago(s.lastRunAt)}`);
    $('dx-foot').textContent = bits.join(' · ');

    const problem = s.catalogError || s.lastError;
    if (problem) setStatus($('dx-status'), problem, 'err');
  } catch (err) {
    $('dx-foot').textContent = `District status unavailable: ${err.message}`;
  }
}

loadWatches();
loadDistrictStatus();
setInterval(loadWatches, 30_000);
setInterval(loadDistrictStatus, 120_000);

/* ---------------- Deals ---------------- */

function dealRow(d, trackedIds) {
  const tracked = trackedIds.has(d.variationId);
  return `
    <div class="row">
      ${d.imageUrl ? `<img src="${esc(d.imageUrl)}" alt="" loading="lazy">` : ''}
      <div class="info">
        <div class="nm">${esc(d.name)}${d.quantity ? ` <span class="qt">· ${esc(d.quantity)}</span>` : ''}</div>
        <div class="meta">
          usually <span class="deal-usual">${rupees(d.baseline)}</span>
          → <span class="deal-now">${rupees(d.price)}</span>
          <span class="badge b-deal">${d.percentBelow}% below usual</span>
          ${tracked ? '<span class="badge b-tracked">tracked</span>' : ''}
        </div>
        <div class="meta">
          from ${d.observations} readings${d.category ? ` · ${esc(d.category)}` : ''}
        </div>
      </div>
      <div class="right">
        <div class="now">${rupees(d.price)}</div>
        <div class="rowbtns">
          <a class="link" href="${esc(d.url || 'https://www.swiggy.com/instamart')}" target="_blank" rel="noopener">open</a>
        </div>
      </div>
    </div>`;
}

/**
 * Until products have enough readings there is genuinely nothing to show, so
 * say why rather than rendering a bare empty list.
 */
function coldStart(s) {
  const pct = s.products ? Math.round((s.withBaseline / s.products) * 100) : 0;
  return `
    <div class="empty">
      <strong>Building the baseline.</strong>
      ${s.products.toLocaleString()} products catalogued,
      ${s.withBaseline.toLocaleString()} with enough history.
      <div class="progress"><span style="width:${pct}%"></span></div>
      <div style="margin-top:8px;">
        A product needs ${s.minObservations} price readings before we can tell
        what it <em>usually</em> costs. Sweeps run every
        ${Math.round(s.intervalMinutes / 60) || 1}h, so this fills in about a day
        — or press <strong>Sweep now</strong> to speed it up.
      </div>
    </div>`;
}

async function loadDeals() {
  try {
    const [{ deals, status: s }, { trackers }] = await Promise.all([
      api('/api/deals'),
      api('/api/trackers'),
    ]);

    const trackedIds = new Set(trackers.map((t) => t.variation_id).filter(Boolean));
    $('dl-count').textContent = deals.length ? `(${deals.length})` : '';
    $('dl-ratio').textContent = `${Math.round(s.ratio * 100)}%`;

    $('dl-deals').innerHTML = deals.length
      ? deals.map((d) => dealRow(d, trackedIds)).join('')
      : s.lastError
        ? `<div class="empty">Sweep didn't run — ${esc(s.lastError)}</div>`
        : s.withBaseline > 0
        ? '<div class="empty">No deals right now — nothing is selling far enough below its usual price.</div>'
        : coldStart(s);

    $('dl-foot').textContent =
      `Deals: ${s.products.toLocaleString()} products catalogued, ` +
      `${s.observations.toLocaleString()} price readings · ` +
      `swept ${ago(s.lastRunAt)}` +
      (s.mode === 'mrp' ? ' · baseline: MRP' : '');
  } catch (err) {
    setStatus($('dl-status'), err.message, 'err');
  }
}

$('dl-sweep').addEventListener('click', async (e) => {
  e.target.disabled = true;
  setStatus($('dl-status'), 'Sweeping categories — this takes a couple of minutes…');
  try {
    const { result } = await api('/api/deals/sweep', { method: 'POST' });
    setStatus(
      $('dl-status'),
      result.skipped
        ? `Skipped: ${result.skipped}`
        : result.error
          ? result.error
          : `Swept ${result.categories} categories, ${result.productsSeen} products, ` +
            `${result.deals} deal(s), ${result.emailed} email(s) sent.`,
      result.error || result.skipped ? 'err' : 'ok',
    );
  } catch (err) {
    setStatus($('dl-status'), err.message, 'err');
  } finally {
    e.target.disabled = false;
    loadDeals();
  }
});

loadDeals();
setInterval(loadDeals, 60_000);

$('dl-email').addEventListener('click', async (e) => {
  e.target.disabled = true;
  setStatus($('dl-status'), 'Sending…');
  try {
    const { result } = await api('/api/deals/email', { method: 'POST' });
    setStatus(
      $('dl-status'),
      result.deals
        ? `Emailed ${result.deals} deal(s) in one message.`
        : 'No live deals to send right now.',
      result.deals ? 'ok' : '',
    );
  } catch (err) {
    setStatus($('dl-status'), err.message, 'err');
  } finally {
    e.target.disabled = false;
  }
});
