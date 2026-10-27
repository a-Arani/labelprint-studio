// Translations: t(key, params), the language list and page direction.
// Catalogs live in web/i18n/<code>.json; missing keys fall back to English.

export const LANGS = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'fa', name: '\u0641\u0627\u0631\u0633\u06cc', dir: 'rtl' },
  { code: 'ar', name: '\u0627\u0644\u0639\u0631\u0628\u064a\u0629', dir: 'rtl' },
  { code: 'es', name: 'Español', dir: 'ltr' },
  { code: 'zh', name: '\u7b80\u4f53\u4e2d\u6587', dir: 'ltr' },
  { code: 'fr', name: 'Français', dir: 'ltr' },
  { code: 'de', name: 'Deutsch', dir: 'ltr' },
  { code: 'ru', name: 'Русский', dir: 'ltr' },
  { code: 'tr', name: 'Türkçe', dir: 'ltr' },
  { code: 'pt', name: 'Português', dir: 'ltr' },
];

let dict = {};
let fallback = {};
export let lang = 'en';

async function fetchCatalog(code) {
  try {
    const r = await fetch(`i18n/${code}.json`, { cache: 'no-store' });
    return r.ok ? await r.json() : {};
  } catch (e) {
    return {};
  }
}

/** The best supported language for this browser/OS */
export function detectLang() {
  for (const l of navigator.languages || [navigator.language || 'en']) {
    const code = String(l).toLowerCase().split('-')[0];
    if (LANGS.some((x) => x.code === code)) return code;
  }
  return 'en';
}

export async function loadLang(code) {
  lang = LANGS.some((x) => x.code === code) ? code : 'en';
  fallback = await fetchCatalog('en');
  dict = lang === 'en' ? fallback : await fetchCatalog(lang);
  const info = LANGS.find((x) => x.code === lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = info.dir;
  try { localStorage.setItem('ls.lang', lang); } catch (e) { /* storage unavailable */ }
  return lang;
}

export const isRTL = () => (LANGS.find((x) => x.code === lang) || {}).dir === 'rtl';

export function has(key) {
  return key in dict || key in fallback;
}

function fill(key, params, isolate) {
  let s = dict[key] ?? fallback[key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? (isolate ? `\u2068${params[k]}\u2069` : String(params[k])) : m));
  return s;
}

// Values are isolated (FSI…PDI) so a name or number in another script never reorders the sentence around it
export const t = (key, params) => fill(key, params, true);

// Without isolation marks, for text that is stored (such as default names)
export const tRaw = (key, params) => fill(key, params, false);

/** Fill static markup: data-i18n (text), data-i18n-title, data-i18n-placeholder */
export function applyDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  root.querySelectorAll('[data-i18n-title]').forEach((n) => { n.title = t(n.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((n) => { n.placeholder = t(n.dataset.i18nPlaceholder); });
}
