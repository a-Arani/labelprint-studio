// About dialog, language menu and app identity (name, version, author come from /api/health)
import { h, api, dialog } from './util.js';
import { t, LANGS, lang } from './i18n.js';

let meta = null;

export async function appMeta() {
  if (!meta) {
    try { meta = await api('/api/health'); } catch (e) { meta = {}; }
  }
  return meta;
}

function langSelect(onPick) {
  const s = h('select', { class: 'inp', 'aria-label': t('lang.title') },
    ...LANGS.map((l) => h('option', { value: l.code, selected: l.code === lang, lang: l.code, dir: l.dir }, l.name)));
  s.addEventListener('change', () => onPick(s.value));
  return s;
}

/** Popup list of languages under the anchor; onPick(code) */
export function langMenu(anchor, onPick) {
  const m = h('div', { class: 'menu lang-menu', role: 'menu' });
  for (const l of LANGS) {
    m.append(h('button', {
      class: 'menu-item' + (l.code === lang ? ' on' : ''), role: 'menuitemradio',
      'aria-checked': String(l.code === lang), onclick: () => { close(); if (l.code !== lang) onPick(l.code); },
    }, h('span', { class: 'lang-check' }, l.code === lang ? '✓' : ''), h('span', { lang: l.code, dir: l.dir }, l.name)));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const left = Math.min(Math.max(4, r.left), innerWidth - m.offsetWidth - 4);
  Object.assign(m.style, { top: r.bottom + 4 + 'px', left: left + 'px' });
  const close = () => { m.remove(); document.removeEventListener('mousedown', out, true); };
  const out = (e) => { if (!m.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('mousedown', out, true));
}

export async function openAbout(onLang) {
  const m = await appMeta();
  const name = m.name || 'LabelPrint Studio';
  const author = m.author || 'Amirhossein Arani';
  const repo = m.repo || '';
  const credits = [
    ['JsBarcode', 'MIT', 'https://github.com/lindell/JsBarcode'],
    ['qrcode-generator', 'MIT', 'https://github.com/kazuhikoarase/qrcode-generator'],
    ['Python', 'PSF', 'https://www.python.org/'],
  ];
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener', dir: 'ltr' }, text);
  await dialog({
    title: t('about.title', { name }),
    body: h('div', { class: 'about' },
      h('img', { class: 'about-logo', src: 'logo.svg', alt: '' }),
      h('div', { class: 'about-name', dir: 'ltr' }, name),
      h('div', { class: 'about-ver' }, t('status.version', { v: m.version || '' })),
      h('p', { class: 'about-desc' }, t('about.description')),
      h('div', { class: 'about-by' }, t('about.by', { name: author })),
      repo ? h('div', { class: 'about-link' }, link(repo, repo.replace(/^https?:\/\//, ''))) : null,
      h('div', { class: 'about-lic muted' }, t('about.license', { license: m.license || 'MIT', year: 2026, name: author })),
      h('label', { class: 'field about-lang' }, h('span', {}, t('lang.title')), langSelect(onLang)),
      h('details', { class: 'about-credits' }, h('summary', {}, t('about.credits')),
        ...credits.map(([n, lic, url]) => h('div', { class: 'muted' }, link(url, n), ` — ${lic}`)))),
    buttons: [{ label: t('common.close'), value: null, primary: true }],
  });
}
