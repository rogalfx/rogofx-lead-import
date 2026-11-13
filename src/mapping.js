// Small helpers that turn Apify places into sheet rows and GHL contacts.

const get = (obj, path) => path.split('.').reduce((v, key) => (v == null ? undefined : v[key]), obj);
export const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Resolves "{{a|b}}": the first of a, b that has a value. */
function resolve(expr, data) {
  for (const path of expr.split('|').map((s) => s.trim())) {
    const value = get(data, path);
    if (!isBlank(value)) return value;
  }
  return '';
}

/**
 * Fills {{placeholders}} in every string inside value (objects and arrays too).
 * A string that is only one placeholder keeps the original type (number, array).
 */
export function fillTemplate(value, data) {
  if (typeof value === 'string') {
    const whole = /^\{\{([^}]+)\}\}$/.exec(value.trim());
    if (whole) return resolve(whole[1], data);
    return value.replace(/\{\{([^}]+)\}\}/g, (_, expr) => String(resolve(expr, data)));
  }
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, data));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTemplate(v, data)]));
  }
  return value;
}

/** Builds the GHL contact body; drops empty fields so GHL doesn't store blanks. */
export function placeToContact(place, fieldTemplate, tags = []) {
  const filled = fillTemplate(fieldTemplate, place);
  const contact = Object.fromEntries(Object.entries(filled).filter(([, v]) => !isBlank(v)));
  if (tags.length) contact.tags = tags;
  return contact;
}

/**
 * Same rule as the Import tab's "Clean name" formula: cut anything after "|",
 * then drop a trailing LLC / PLLC / Inc / Incorporated / Corp / Corporation / Ltd.
 */
export function cleanName(title) {
  let s = String(title ?? '').trim();
  const bar = s.indexOf('|');
  if (bar >= 0) s = s.slice(0, bar).trim();
  s = s.replace(/(?:[\s,]+(?:l\.?l\.?c\.?|p\.?l\.?l\.?c\.?|inc(?:\.|orporated)?|corp(?:\.|oration)?|ltd\.?))+\s*$/i, '');
  return s.replace(/\s*,+\s*$/, '').trim();
}

/** 10-digit phone key, the duplicate key used in Master Leads and Do Not Contact. */
export function phoneKey(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits.length > 10 ? digits.slice(-10) : digits.length === 10 ? digits : '';
}

/** "2026-11-11" -> Google Sheets date serial number (days since 1899-12-30). */
export function dateSerial(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

/** Forces Sheets to store a value as plain text (no formulas, no number guessing). */
export const asText = (v) => (isBlank(v) ? '' : `'${v}`);

/**
 * Builds the "installers only" check from config.installersOnly. Returns a function that gives
 * the skip reason for a place (mowing and lawn-care crews), or null to keep it.
 */
export function installerFilter(cfg) {
  if (!cfg) return () => null;
  const keep = cfg.keepName ? new RegExp(cfg.keepName, 'i') : null;
  const skipName = cfg.skipName ? new RegExp(cfg.skipName, 'i') : null;
  const skipCats = new Set((cfg.skipCategories ?? []).map((c) => String(c).trim().toLowerCase()));
  return (place) => {
    const title = String(place.title ?? '');
    if (keep?.test(title)) return null;
    if (skipCats.has(String(place.categoryName ?? '').trim().toLowerCase())) return 'not an installer (category)';
    if (skipName?.test(title)) return 'not an installer (name)';
    return null;
  };
}
