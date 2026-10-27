/**
 * Translates Swiggy's search/v2 response into a flat product shape.
 *
 * This file is the blast radius for Swiggy changing their API. Everything
 * downstream (db, scheduler, mailer, UI) depends only on the shape returned by
 * `normalizeSearchResponse`, never on Swiggy's raw JSON.
 *
 * Observed response shape (captured 2026-09-07):
 *   data.cards[]            .card.card['@type'] ~ /GridWidget/
 *     .gridElements.infoWithStyle.items[]       one product
 *       displayName, brand, inStock, productId
 *       variations[]                            one pack size / SKU
 *         skuId, spinId, quantityDescription, imageIds[], podId
 *         price.mrp.units / price.offerPrice.units   (strings, plus nanos)
 *         inventory.inStock, slotInfo.isAvail
 */

const IMAGE_BASE = 'https://media-assets.swiggy.com/swiggy/image/upload';

/** Swiggy money: { units: "17", nanos: 0 }. Returns a Number, or null. */
function money(m) {
  if (!m) return null;
  const units = Number(m.units ?? 0);
  const nanos = Number(m.nanos ?? 0);
  if (!Number.isFinite(units)) return null;
  return units + nanos / 1e9;
}

export function imageUrl(id, height = 300) {
  if (!id) return null;
  return `${IMAGE_BASE}/fl_lossy,f_auto,q_auto,h_${height}/${id}`;
}

export function productUrl(spinId, storeId) {
  if (!spinId) return 'https://www.swiggy.com/instamart';
  const q = storeId ? `?storeId=${encodeURIComponent(storeId)}` : '';
  return `https://www.swiggy.com/instamart/item/${encodeURIComponent(spinId)}${q}`;
}

/** Walks the card tree and yields every product item, whatever the nesting. */
function* eachItem(payload) {
  const cards = payload?.data?.cards;
  if (!Array.isArray(cards)) return;
  for (const c of cards) {
    const widget = c?.card?.card;
    const items = widget?.gridElements?.infoWithStyle?.items;
    if (Array.isArray(items)) yield* items;
  }
}

/**
 * One Swiggy item can hold several pack sizes (variations). Each variation is
 * a separately-priced thing, so each becomes its own trackable product --
 * otherwise "Amul Milk" would ambiguously mean 200ml or 1L.
 */
function flatten(item) {
  const out = [];
  const variations = Array.isArray(item?.variations) ? item.variations : [];

  for (const v of variations) {
    const price = money(v?.price?.offerPrice);
    const mrp = money(v?.price?.mrp);
    if (price == null && mrp == null) continue;

    const inStock = Boolean(
      (v?.inventory?.inStock ?? item?.inStock ?? false) &&
        (v?.slotInfo?.isAvail ?? true),
    );

    out.push({
      productId: String(item?.productId ?? ''),
      // spinId is the stable per-pack-size id; it is what we re-match on when
      // re-checking a price later, and what the item deep-link uses.
      variationId: String(v?.spinId ?? v?.skuId ?? ''),
      skuId: v?.skuId ? String(v.skuId) : null,
      name: v?.displayName || item?.displayName || 'Unknown product',
      brand: v?.brandName || item?.brand || '',
      quantity: v?.quantityDescription || '',
      imageUrl: imageUrl(v?.imageIds?.[0]),
      price: price ?? mrp,
      mrp: mrp ?? price,
      inStock,
      storeId: v?.podId ? String(v.podId) : null,
    });
  }

  return out;
}

export function normalizeSearchResponse(payload) {
  const products = [];
  const seen = new Set();

  for (const item of eachItem(payload)) {
    for (const p of flatten(item)) {
      if (!p.variationId || seen.has(p.variationId)) continue;
      seen.add(p.variationId);
      p.url = productUrl(p.variationId, p.storeId);
      products.push(p);
    }
  }

  return products;
}

/** Percentage off MRP, or 0. Used by the UI and the alert email. */
export function discountPercent(price, mrp) {
  if (!mrp || !price || mrp <= price) return 0;
  return Math.round(((mrp - price) / mrp) * 100);
}
