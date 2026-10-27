/**
 * The category queries a sweep walks.
 *
 * Coverage is exactly this list: a product that appears in none of these
 * searches is invisible to the deals view. Kept as a plain array so it is
 * trivial to add a category you care about.
 *
 * Roughly 30 seeds x ~35 results is ~1000 products per sweep.
 */
export const SEEDS = [
  // Snacks and packaged food
  'chocolate', 'biscuits', 'chips', 'namkeen', 'dry fruits', 'ice cream',
  'noodles', 'breakfast cereal', 'peanut butter', 'jam', 'sauces',
  // Staples
  'rice', 'atta', 'cooking oil', 'dal', 'sugar', 'salt', 'spices',
  // Beverages
  'coffee', 'tea', 'soft drinks', 'juice', 'energy drink',
  // Dairy
  'milk', 'butter', 'cheese', 'curd', 'paneer',
  // Personal care
  'shampoo', 'soap', 'toothpaste', 'face wash', 'deodorant', 'sanitary pads',
  // Home
  'detergent', 'dishwash', 'floor cleaner', 'tissue paper',
];

export function seeds(env = process.env) {
  const custom = (env.DEAL_SEEDS || '').trim();
  if (!custom) return SEEDS;
  return custom
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
