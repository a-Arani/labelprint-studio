// Per-printer settings (method, dpi, density, ...) kept in settings.json
import { S } from './state.js';
import { api } from './util.js';

export const PRINTER_DEFAULTS = {
  method: 'tspl', dpi: 203, speed: 4, density: 8, direction: 1, offX: 0, offY: 0, threshold: 140,
  invert: false, feedOffset: 0, host: '', port: 9100, maxWidth: 108, finish: 'tear',
  backExtra: 0, backThen: 'none',   // "Reverse feed one label": extra mm, then stay or come forward to the gap
};

let printers = null;

export const baseName = (n) => String(n || '').replace(/\s*\(redirected \d+\)\s*$/i, '').trim();

export async function loadPrinters(force = false) {
  if (printers && !force) return printers;
  try {
    printers = await api('/api/printers', {});
  } catch (e) {
    printers = { printers: [], default: null };
  }
  return printers;
}

export function profileFor(name) {
  const all = S.settings.printers || {};
  return { ...PRINTER_DEFAULTS, ...(all[baseName(name)] || {}), printer: name };
}

export async function saveProfile(p) {
  const all = { ...(S.settings.printers || {}) };
  const { printer, ...rest } = p;
  all[baseName(printer)] = rest;
  S.settings.printers = all;
  S.settings.lastPrinter = baseName(printer);
  try {
    await api('/api/settings/set', { printers: all, lastPrinter: S.settings.lastPrinter });
  } catch (e) { /* saving the preference is not critical */ }
}

export function pickDefaultPrinter(list) {
  const names = list.printers.map((p) => p.name);
  const last = S.settings.lastPrinter;
  return names.find((n) => baseName(n) === last)
    || names.find((n) => /tsc|ttp|te2|te3|tdp|label|zebra|xprinter/i.test(n))
    || list.default || names[0] || '';
}
