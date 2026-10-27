// Shared helpers: units, API calls, DOM building, dialogs, calendars and variables
import * as logger from './logger.js';
import { t, has, lang } from './i18n.js';

export const PXMM = 96 / 25.4;      // CSS pixels per millimetre
export const PTMM = 25.4 / 72;      // millimetres per point
export const SVGNS = 'http://www.w3.org/2000/svg';

export const uid = () => Math.random().toString(16).slice(2, 10);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const r2 = (v) => Math.round(v * 100) / 100;
export const fmtNum = (v) => String(r2(v));
// A size like "100×50" isolated so it never reads backwards inside right-to-left text
export const dims = (w, hh) => `\u2066${w}×${hh}\u2069`;
// Any short left-to-right snippet (numbers, ranges) isolated inside right-to-left text
export const ltr = (s) => `\u2066${s}\u2069`;

// Deep copy; strings (such as image data URLs) are shared, not duplicated
export function clone(o) {
  if (Array.isArray(o)) return o.map(clone);
  if (o && typeof o === 'object') {
    const out = {};
    for (const k in o) out[k] = clone(o[k]);
    return out;
  }
  return o;
}

// Requests cut off because the page is reloading or closing are not errors
let unloading = false;
window.addEventListener('pagehide', () => { unloading = true; });
window.addEventListener('beforeunload', () => { unloading = true; });
window.addEventListener('pageshow', () => { unloading = false; });

export async function api(path, body) {
  const opt = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  let r;
  try {
    r = await fetch(path, opt);
  } catch (e) {
    if (unloading) return new Promise(() => {});
    logger.error(`Lost connection to the server: ${path}`);
    throw new Error(t('err.connection'));
  }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.blob();
  if (!r.ok) {
    // Server errors carry a code; show them in the user's language when we have a translation
    const msg = data && data.code && has('err.' + data.code)
      ? t('err.' + data.code, data.params || {})
      : (data && data.error) || t('err.http', { status: r.status });
    if (path !== '/api/log') logger.warn(`API ${path} -> ${r.status}: ${(data && data.error) || ''}`);
    const err = new Error(msg);
    err.code = data && data.code;
    throw err;
  }
  return data;
}

export function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function cssFont(name) {
  const n = String(name || 'Tahoma').replace(/['"]/g, '');
  return `'${n}', Tahoma, sans-serif`;
}

// ---------------------------------------------------------------- messages and dialogs
let toastBox;
export function toast(msg, type = 'info', ms = 3500) {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts' });
    document.body.append(toastBox);
  }
  if (type === 'error') logger.error(`Error shown to the user: ${msg}`);
  else if (type === 'warn') logger.warn(`Warning shown to the user: ${msg}`);
  const n = h('div', { class: `toast toast-${type}` }, msg);
  toastBox.append(n);
  setTimeout(() => n.classList.add('out'), ms);
  setTimeout(() => n.remove(), ms + 400);
  return n;
}

export function dialog({ title, body, buttons, wide = false, onOpen }) {
  buttons = buttons || [{ label: t('common.ok'), value: true, primary: true }];
  return new Promise((resolve) => {
    const close = (v) => {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve(v);
    };
    const footer = h('div', { class: 'dlg-foot' });
    for (const b of buttons) {
      footer.append(h('button', {
        class: 'btn' + (b.primary ? ' btn-primary' : '') + (b.danger ? ' btn-danger' : ''),
        onclick: () => {
          if (b.validate && !b.validate()) return;
          close(typeof b.value === 'function' ? b.value() : b.value);
        },
      }, b.label));
    }
    const box = h('div', { class: 'dlg' + (wide ? ' dlg-wide' : ''), role: 'dialog', 'aria-label': title },
      h('div', { class: 'dlg-head' }, h('span', {}, title),
        h('button', { class: 'icon-btn dlg-x', title: t('common.close'), 'aria-label': t('common.close'), onclick: () => close(null) }, '×')),
      h('div', { class: 'dlg-body' }, body), footer);
    const back = h('div', { class: 'dlg-back' }, box);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && !e.target.closest('.no-enter')) {
        const p = buttons.find((b) => b.primary);
        if (p) {
          e.preventDefault();
          if (p.validate && !p.validate()) return;
          close(typeof p.value === 'function' ? p.value() : p.value);
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(back);
    const first = box.querySelector('input,select,textarea');
    if (first) setTimeout(() => { first.focus(); if (first.select) first.select(); }, 30);
    if (onOpen) onOpen(box, close);
  });
}

export async function askText(title, value = '', label = '') {
  const inp = h('input', { class: 'inp', value, dir: 'auto' });
  const v = await dialog({
    title,
    body: h('label', { class: 'field' }, label ? h('span', {}, label) : null, inp),
    buttons: [{ label: t('common.ok'), value: () => inp.value.trim(), primary: true }, { label: t('common.cancel'), value: null }],
  });
  return v || null;
}

export function confirmBox(title, msg, okLabel, danger = false) {
  return dialog({
    title, body: h('p', {}, msg),
    buttons: [{ label: okLabel || t('common.ok'), value: true, primary: !danger, danger }, { label: t('common.cancel'), value: false }],
  });
}

export function pickFiles({ accept = '', multiple = false, directory = false } = {}) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    inp.multiple = multiple;
    if (directory) inp.webkitdirectory = true;
    inp.addEventListener('change', () => { resolve([...inp.files]); inp.remove(); });
    inp.addEventListener('cancel', () => { resolve([]); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}

export const fileToDataURL = (file) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result);
  fr.onerror = rej;
  fr.readAsDataURL(file);
});

export async function fileToBase64(file) {
  return (await fileToDataURL(file)).split(',')[1] || '';
}

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Shrink big images so label files stay small
export async function shrinkImage(dataUrl, maxSide = 2000) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  if (s >= 1 && dataUrl.length < 3e6) return { src: dataUrl, w: img.naturalWidth, h: img.naturalHeight };
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return { src: c.toDataURL('image/png'), w: c.width, h: c.height };
}

// ---------------------------------------------------------------- calendars
export function toJalali(gy, gm, gd) {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy <= 1600 ? 0 : 979;
  gy -= gy <= 1600 ? 621 : 1600;
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100)
    + Math.floor((gy2 + 399) / 400) - 80 + gd + gdm[gm - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}

function toHijri(date) {
  const f = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return [parseInt(p.year, 10), parseInt(p.month, 10), parseInt(p.day, 10)];
}

const DIGITS = { fa: '\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9', ar: '\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669' };
export const localDigits = (s, set) => (DIGITS[set] ? String(s).replace(/[0-9]/g, (d) => DIGITS[set][d]) : String(s));

export const defaultCalendar = () => (lang === 'fa' ? 'jalali' : 'gregorian');

export function formatDate(date, { calendar = 'gregorian', format = 'yyyy/mm/dd', digits = 'en' } = {}) {
  let y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
  if (calendar === 'jalali') [y, m, d] = toJalali(y, m, d);
  if (calendar === 'hijri') [y, m, d] = toHijri(date);
  const p2 = (n) => String(n).padStart(2, '0');
  const out = format.replace(/yyyy|yy|mm|m|dd|d/g, (tok) => ({
    yyyy: String(y), yy: String(y).slice(-2), mm: p2(m), m: String(m), dd: p2(d), d: String(d),
  }[tok]));
  return localDigits(out, digits);
}

/** "2026-10-26 14:32" (Persian UI: "1405/08/04 14:32") from a server timestamp */
export function formatDateTime(s, withTime = true) {
  if (!s) return '';
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d))?/.exec(s);
  if (!m) return s;
  let d = `${m[1]}-${m[2]}-${m[3]}`;
  if (lang === 'fa') {
    const [jy, jm, jd] = toJalali(+m[1], +m[2], +m[3]);
    d = `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
  }
  return ltr(withTime && m[4] ? `${d} ${m[4]}:${m[5]}` : d);
}

// ---------------------------------------------------------------- variables
export const VAR_KINDS = ['field', 'counter', 'date', 'text', 'list'];
export const varTypeName = (type) => t('var.type.' + type);

export function newVariable(type, existing) {
  const base = t('var.default.' + type);
  let name = base, n = 2;
  while (existing.some((v) => v.name === name)) name = base + n++;
  const v = { id: uid(), name, type };
  if (type === 'counter') Object.assign(v, { start: 1, step: 1, pad: 0, prefix: '', suffix: '', digits: 'en' });
  if (type === 'date') Object.assign(v, { calendar: defaultCalendar(), format: 'yyyy/mm/dd', offset: 0, digits: 'en' });
  if (type === 'text') Object.assign(v, { value: '', ask: true });
  if (type === 'list') Object.assign(v, { values: [] });
  if (type === 'field') Object.assign(v, { value: '', multiline: false });
  return v;
}

export function counterText(v, n) {
  let s = String(Math.abs(n));
  if (v.pad) s = s.padStart(v.pad, '0');
  if (n < 0) s = '-' + s;
  s = (v.prefix || '') + s + (v.suffix || '');
  return localDigits(s, v.digits);
}

// Every name usable as {name} in this label
export function variableNames(label) {
  const names = (label.variables || []).map((v) => v.name);
  for (const c of label.data?.columns || []) if (!names.includes(c)) names.push(c);
  return names;
}

/**
 * The values of every label to print.
 * opt: {from, to, rowFrom, rowTo, texts:{name:value}, dates:{name:value}}
 */
export function buildRecords(label, opt = {}) {
  const vars = label.variables || [];
  const counters = vars.filter((v) => v.type === 'counter');
  const lists = vars.filter((v) => v.type === 'list');
  const table = label.data && label.data.rows && label.data.rows.length ? label.data : null;
  const fixed = {};
  for (const v of vars) {
    if (v.type === 'date') {
      const d = new Date();
      d.setDate(d.getDate() + Number(v.offset || 0));
      fixed[v.name] = opt.dates?.[v.name] ?? formatDate(d, v);
    } else if (v.type === 'text') {
      fixed[v.name] = opt.texts?.[v.name] ?? v.value ?? '';
    } else if (v.type === 'field') {
      fixed[v.name] = v.value ?? '';
    }
  }
  let count = 1;
  const main = counters[0];
  const from = main ? Number(opt.from ?? main.start ?? 1) : 0;
  const step = main ? Number(main.step || 1) : 1;
  if (main) {
    const to = Number(opt.to ?? from);
    count = Math.max(0, Math.floor((to - from) / step) + 1);
  }
  const rowsLen = table ? table.rows.length : Math.max(0, ...lists.map((l) => (l.values || []).length));
  const rowFrom = Math.max(1, Number(opt.rowFrom || 1));
  const rowTo = Math.min(rowsLen, Number(opt.rowTo || rowsLen));
  if (!main && rowsLen) count = Math.max(0, rowTo - rowFrom + 1);
  const recs = [];
  for (let i = 0; i < count; i++) {
    const r = { ...fixed };
    counters.forEach((c, ci) => {
      const start = ci === 0 ? from : Number(c.start || 0);
      r[c.name] = counterText(c, start + i * Number(c.step || 1));
    });
    const row = rowFrom - 1 + i;
    for (const l of lists) {
      const vals = l.values || [];
      r[l.name] = vals.length ? vals[row % vals.length] : '';
    }
    if (table) {
      const tr = table.rows[row % table.rows.length] || [];
      table.columns.forEach((c, ci) => { if (!(c in r)) r[c] = tr[ci] ?? ''; });
    }
    recs.push(r);
  }
  return recs;
}

export function previewValues(label) {
  return buildRecords(label, {})[0] || {};
}

export const VAR_RE = /\{([^{}\n]{1,40})\}/g;

export function substitute(str, values) {
  if (!values || !str) return str;
  return String(str).replace(VAR_RE, (m, n) => (n.trim() in values ? String(values[n.trim()]) : m));
}

// Replace variables in text only (never inside HTML tags)
export function substituteHtml(html, values) {
  if (!values || !html || html.indexOf('{') < 0) return html;
  return html.replace(/(<[^>]*>)|([^<]+)/g, (m, tag, text) => (tag ? tag
    : text.replace(VAR_RE, (mm, n) => (n.trim() in values ? esc(values[n.trim()]) : mm))));
}

// The numeric value of the main counter for the i-th label (recorded in print history)
export function counterValue(label, opt, i) {
  const main = (label.variables || []).find((v) => v.type === 'counter');
  if (!main) return null;
  const from = Number(opt.from ?? main.start ?? 1);
  return from + i * Number(main.step || 1);
}

export const fieldNames = (label) => (label.variables || []).filter((v) => v.type === 'field').map((v) => v.name);

// Are all {variables} of an element empty? (for "hide when empty")
export function emptyByVars(e, values) {
  const src = e.type === 'text' ? (e.html || '').replace(/<[^>]*>/g, '') : (e.value || '');
  const names = [...src.matchAll(VAR_RE)].map((m) => m[1].trim());
  if (!names.length) return false;
  return names.every((n) => n in values && !String(values[n] ?? '').trim());
}

export function usesVariables(label) {
  const names = variableNames(label);
  if (!names.length) return false;
  const re = new RegExp('\\{\\s*(' + names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\s*\\}');
  return label.elements.some((e) => re.test(e.html || '') || re.test(e.value || ''));
}
