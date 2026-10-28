// Roll types: labels as they pass through the printer (liner width, columns, label size, gaps)
import { S, emit } from './state.js';
import { h, api, toast, dialog, confirmBox, uid, r2, clamp, clone, SVGNS, dims } from './util.js';
import { toMono, monoToBase64 } from './render.js';
import { loadPrinters, profileFor, pickDefaultPrinter } from './printers.js';
import { t, tRaw } from './i18n.js';

// cols × rows: the labels in each print (across the roll × down the roll; down is nearly always 1)
export const MEDIA_DEFAULT = {
  name: '', linerW: 100, cols: 1, rows: 1, labelW: 100, labelH: 50, colGap: 0, marginL: 0,
  rowGap: 2, gapType: 'gap', gapOffset: 0, radius: 2, colOffsets: [],
};

// Built in rolls, used until the user saves their own list (names follow the UI language)
export const defaultMedia = () => [
  { id: 'm100x50', name: tRaw('media.single', { size: dims(100, 50) }), linerW: 100, cols: 1, labelW: 100, labelH: 50, colGap: 0, marginL: 0, rowGap: 2, radius: 2 },
  { id: 'm100x150', name: tRaw('media.single', { size: dims(100, 150) }), linerW: 100, cols: 1, labelW: 100, labelH: 150, colGap: 0, marginL: 0, rowGap: 3, radius: 2 },
  { id: 'm55x50', name: tRaw('media.single', { size: dims(55, 50) }), linerW: 55, cols: 1, labelW: 55, labelH: 50, colGap: 0, marginL: 0, rowGap: 2, radius: 2 },
  { id: 'm2x48x25', name: tRaw('media.double', { size: dims(48, 25) }), linerW: 104, cols: 2, labelW: 48, labelH: 25, colGap: 3, marginL: 2.5, rowGap: 2, radius: 1.5 },
].map((m) => normMedia(m));

const gapTypes = () => ['gap', 'bline', 'continuous'].map((k) => [k, t('media.gap.' + k)]);

export function normMedia(m) {
  const out = { ...MEDIA_DEFAULT, ...m };
  for (const k of ['linerW', 'cols', 'rows', 'labelW', 'labelH', 'colGap', 'marginL', 'rowGap', 'gapOffset', 'radius']) {
    out[k] = Number(out[k]) || 0;
  }
  out.cols = Math.max(1, Math.min(12, Math.round(out.cols)));
  out.rows = Math.max(1, Math.min(4, Math.round(out.rows)));
  out.colOffsets = Array.from({ length: out.cols }, (_, i) => Number((m.colOffsets || [])[i]) || 0);
  out.id = out.id || uid();
  return out;
}

export function mediaList() {
  const m = S.settings.media;
  return Array.isArray(m) && m.length ? m.map(normMedia) : defaultMedia();
}

export async function saveMediaList(list) {
  S.settings.media = list.map(normMedia);
  await api('/api/settings/set', { media: S.settings.media });
}

export const mediaById = (id) => (id ? mediaList().find((m) => m.id === id) : null);

/** Column and row positions in one print, its height, and the right margin */
export function layout(m) {
  const rows = m.rows || 1;
  const used = m.marginL + m.cols * m.labelW + (m.cols - 1) * m.colGap;
  const xs = Array.from({ length: m.cols }, (_, i) => m.marginL + i * (m.labelW + m.colGap) + ((m.colOffsets || [])[i] || 0));
  const ys = Array.from({ length: rows }, (_, i) => i * (m.labelH + m.rowGap));
  return { used, marginR: r2(m.linerW - used), xs, ys, pageH: r2(rows * m.labelH + (rows - 1) * m.rowGap) };
}

/** Labels in each print */
export const perPrint = (m) => m.cols * (m.rows || 1);

/** Width the labels take without the margins */
export const labelsWidth = (m) => r2(m.cols * m.labelW + (m.cols - 1) * m.colGap);

/** What is wrong with a roll; skipFit: leave out "the labels are wider than the roll" (the Rolls window shows it itself) */
export function problems(m, maxWidth = 108, skipFit = false) {
  const out = [];
  const L = layout(m);
  if (!skipFit && L.marginR < -0.05) out.push(t('media.tooWide', { used: r2(L.used), width: m.linerW }));
  if (m.linerW > maxWidth + 0.05) out.push(t('media.overPrinter', { width: m.linerW, max: maxWidth }));
  if (m.labelW <= 0 || m.labelH <= 0) out.push(t('media.badSize'));
  return out;
}

/** A roll whose label size matches the design (directly or turned) */
export function matchMedia(page) {
  const list = mediaList();
  const own = list.find((m) => m.id === page.mediaId);
  return own || list.find((m) => fitsRoll(page, m)) || null;
}

/** The design is the size of one label of this roll (upright or turned) */
export function fitsRoll(page, m) {
  const eq = (a, b) => Math.abs(a - b) <= 0.6;
  return (eq(m.labelW, page.w) && eq(m.labelH, page.h)) || (eq(m.labelW, page.h) && eq(m.labelH, page.w));
}

/** The roll chosen last for a label (a new label starts with it) */
export function lastRoll() {
  try { return localStorage.getItem('ls.lastRoll') || ''; } catch (e) { return ''; }
}

export function rememberRoll(id) {
  try { localStorage.setItem('ls.lastRoll', id || ''); } catch (e) { /* storage unavailable */ }
}

/** TSPL settings of a roll: SIZE = liner width × the height of one print (one row of labels, or more) */
export const tsplOf = (m) => ({ stockW: m.linerW, stockH: layout(m).pageH, gap: m.rowGap, gapOffset: m.gapOffset, media: m.gapType });

// ---------------------------------------------------------------- diagram
function sv(tag, attrs, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

const fmt = (v) => String(r2(v));

/** A dimension with arrows and its value, in screen pixels; key: the field it belongs to (highlighted with it) */
function dim(g, key, x1, y1, x2, y2, label) {
  const d = sv('g', { class: 'dim', 'data-dim': key });
  d.append(sv('line', { x1, y1, x2, y2, 'marker-start': 'url(#arr)', 'marker-end': 'url(#arr)' }));
  const vertical = x1 === x2;
  d.append(sv('text', {
    x: vertical ? x1 + 6 : (x1 + x2) / 2, y: vertical ? (y1 + y2) / 2 : y1 - 5,
    'text-anchor': vertical ? 'start' : 'middle', 'dominant-baseline': vertical ? 'middle' : 'auto',
  }, label));
  g.append(d);
}

/** The roll as it comes out of the printer: a few prints, labels numbered in print order, the sizes readable */
export function mediaDiagram(m) {
  const L = layout(m);
  const gapV = m.gapType === 'continuous' ? 0 : m.rowGap;
  const stub = Math.min(m.labelH * 0.3, 7);        // the top of the next label, so the gap down the roll shows
  const lead = 6, tail = gapV + stub + 3;          // backing paper above and below the print (mm)
  const lenMM = lead + L.pageH + tail;
  const minX = Math.min(0, L.xs[0]), maxX = Math.max(m.linerW, L.xs[m.cols - 1] + m.labelW);
  const spanW = Math.max(1, maxX - minX);
  const left = 22, right = 64, top = 40, bottom = 10;
  const s = Math.max(0.4, Math.min(430 / spanW, 300 / lenMM));
  const W = Math.round(left + spanW * s + right), H = Math.round(top + lenMM * s + bottom);
  const X = (mm) => left + (mm - minX) * s;
  const Y = (mm) => top + (lead + mm) * s;
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'media-svg', direction: 'ltr' });
  const defs = sv('defs', {});
  const mk = sv('marker', { id: 'arr', viewBox: '0 0 6 6', refX: 3, refY: 3, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' });
  mk.append(sv('path', { d: 'M0,0 L6,3 L0,6 z', class: 'arr' }));
  defs.append(mk);
  svg.append(defs);
  // The roll goes on above and below: torn edges
  const x0 = X(0), x1 = X(m.linerW), yt = Y(-lead), yb = Y(L.pageH + tail);
  const teeth = Math.max(4, Math.round((x1 - x0) / 14));
  const zig = (y, from, to, dir) => Array.from({ length: teeth + 1 }, (_, i) => {
    const x = from + ((to - from) * i) / teeth;
    return `L${x.toFixed(1)},${(y + (i % 2 ? dir * 4 : 0)).toFixed(1)}`;
  }).join(' ');
  svg.append(sv('path', { d: `M${x0},${yt} ${zig(yt, x0, x1, 1)} L${x1},${yb} ${zig(yb, x1, x0, -1)} Z`, class: 'liner', 'data-dim': 'linerW' }));
  // The labels of one print, numbered in the order they are printed
  let n = 0;
  for (const yr of L.ys) {
    L.xs.forEach((x) => {
      const out = x < -0.05 || x + m.labelW > m.linerW + 0.05;
      svg.append(sv('rect', {
        x: X(x), y: Y(yr), width: m.labelW * s, height: m.labelH * s, rx: Math.min(m.radius * s, 8),
        class: 'lbl' + (out ? ' out' : ''), 'data-dim': n === 0 ? 'perPrint labelW labelH radius' : 'perPrint',
      }));
      svg.append(sv('text', {
        x: X(x + m.labelW / 2), y: Y(yr + m.labelH / 2), class: 'num', 'font-size': Math.max(9, Math.min(22, m.labelH * s * 0.45)),
      }, String(++n)));
    });
  }
  // Only the top of the next labels: the roll goes on, the next print starts after the gap
  const yn = Y(L.pageH + gapV), yn2 = Y(L.pageH + gapV + stub);
  L.xs.forEach((x) => {
    const a = X(x), b = X(x + m.labelW);
    svg.append(sv('path', { d: `M${a},${yn2} L${a},${yn} L${b},${yn} L${b},${yn2}`, class: 'lbl-next' }));
  });
  // Sizes
  const g = sv('g', {});
  dim(g, 'linerW', X(0), 22, X(m.linerW), 22, `${fmt(m.linerW)} mm`);
  const lx = X(L.xs[0]), ly = Y(0);
  dim(g, 'labelW', lx, ly + 18, lx + m.labelW * s, ly + 18, fmt(m.labelW));
  const xr = X(maxX) + 10;
  dim(g, 'labelH', xr, Y(0), xr, Y(m.labelH), fmt(m.labelH));
  if (gapV > 0.05) dim(g, 'rowGap', xr, Y(L.pageH), xr, Y(L.pageH + gapV), fmt(m.rowGap));
  const yc = Y(m.labelH * 0.72);
  if (m.cols > 1 && m.colGap > 0.05) dim(g, 'colGap', X(L.xs[0] + m.labelW), yc, X(L.xs[1]), yc, fmt(m.colGap));
  if (m.marginL > 0.05) dim(g, 'margin', X(0), yc, X(L.xs[0]), yc, fmt(m.marginL));
  if (L.marginR > 0.05) dim(g, 'margin', X(L.xs[m.cols - 1] + m.labelW), yc, X(m.linerW), yc, fmt(L.marginR));
  svg.append(g);
  return svg;
}

/** Mark the parts of the diagram that belong to a field (key) */
export function highlightDiagram(root, key) {
  root.querySelectorAll('[data-dim]').forEach((el) => {
    el.classList.toggle('hl', !!key && (el.getAttribute('data-dim') || '').split(' ').includes(key));
  });
}

// ---------------------------------------------------------------- layout test print
export function layoutTestCanvas(m, dpi, prof = {}) {
  const dpmm = dpi / 25.4;
  const L = layout(m);
  const c = document.createElement('canvas');
  c.width = Math.round(m.linerW * dpmm);
  c.height = Math.round(L.pageH * dpmm);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000';
  g.strokeStyle = '#000';
  g.lineWidth = Math.max(2, 0.35 * dpmm);
  for (let k = 0; k < perPrint(m); k++) {
    const i = k % m.cols;
    const x = (L.xs[i] + (prof.offX || 0)) * dpmm, y = (L.ys[Math.floor(k / m.cols)] + (prof.offY || 0)) * dpmm;
    const w = m.labelW * dpmm, hh = m.labelH * dpmm;
    g.lineWidth = Math.max(1, 0.2 * dpmm);
    g.strokeRect(x, y, w, hh);
    // Millimetre rulers from every edge: how many millimetres are missing shows how far to shift the print
    const tick = Math.max(1, Math.round(0.15 * dpmm));
    const len = (mm) => (mm % 5 === 0 ? 2.4 : 1.2) * dpmm;
    for (let mm = 1; mm < m.labelW; mm++) {
      g.fillRect(x + mm * dpmm, y, tick, len(mm));
      g.fillRect(x + mm * dpmm, y + hh - len(mm), tick, len(mm));
    }
    for (let mm = 1; mm < m.labelH; mm++) {
      g.fillRect(x, y + mm * dpmm, len(mm), tick);
      g.fillRect(x + w - len(mm), y + mm * dpmm, len(mm), tick);
    }
    const ruler = Math.max(9, 1.8 * dpmm);
    g.font = `${ruler}px Tahoma`;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let mm = 5; mm < m.labelW - 2; mm += 5) g.fillText(String(mm), x + mm * dpmm, y + 2.7 * dpmm);
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    for (let mm = 5; mm < m.labelH - 2; mm += 5) g.fillText(String(mm), x + 2.8 * dpmm, y + mm * dpmm);
    const big = Math.min(hh * 0.4, w * 0.3);
    g.font = `bold ${big}px Tahoma`;
    g.textAlign = 'center';
    g.fillText(String(k + 1), x + w / 2, y + hh / 2 + big * 0.05);
    const small = Math.max(10, Math.min(hh * 0.12, 3 * dpmm));
    g.font = `${small}px Tahoma`;
    g.fillText('▲ ' + t('media.testTop'), x + w / 2, y + 6 * dpmm + small / 2);
    g.fillText(`${m.labelW}×${m.labelH}`, x + w / 2, y + hh - 4.5 * dpmm - small / 2);
  }
  return c;
}

// ---------------------------------------------------------------- "Rolls" dialog
// Common rolls to start from: labels across, one label's width and height, roll width, gap between labels across
const COMMON = [
  [1, 100, 50, 100, 0], [1, 100, 100, 100, 0], [1, 100, 150, 100, 0], [1, 80, 50, 80, 0], [1, 58, 40, 58, 0],
  [1, 40, 30, 40, 0], [2, 50, 25, 104, 2], [2, 40, 30, 84, 2], [3, 32, 25, 104, 2],
];

const PAPER_ICONS = {
  gap: '<svg viewBox="0 0 44 30"><rect x="9" y="0.5" width="26" height="29" fill="#d9dee5"/><rect x="11" y="2" width="22" height="12" rx="1.5" fill="#fff" stroke="#7d8a99"/><rect x="11" y="16" width="22" height="12" rx="1.5" fill="#fff" stroke="#7d8a99"/></svg>',
  bline: '<svg viewBox="0 0 44 30"><rect x="11" y="0.5" width="22" height="29" fill="#fff" stroke="#7d8a99"/><rect x="11" y="13" width="7" height="3.5" fill="#222"/><line x1="11" y1="14.7" x2="33" y2="14.7" stroke="#7d8a99" stroke-dasharray="2 2"/></svg>',
  continuous: '<svg viewBox="0 0 44 30"><rect x="11" y="0.5" width="22" height="29" fill="#fff" stroke="#7d8a99"/></svg>',
};

/** Name made from the layout, e.g. "Two across 50×25" */
export function autoName(m) {
  const size = dims(m.labelW, m.labelH);
  if (m.rows > 1) return `${tRaw('media.grid', { cols: m.cols, rows: m.rows })} ${size}`;
  if (m.cols === 1) return tRaw('media.single', { size });
  if (m.cols === 2) return tRaw('media.double', { size });
  return tRaw('media.multi', { n: m.cols, size });
}

/** "2 across", "2 across × 2 down", or nothing for one label in each print */
export const rollGrid = (m) => (m.rows > 1 ? t('media.grid', { cols: m.cols, rows: m.rows }) : m.cols > 1 ? t('page.cols', { n: m.cols }) : '');

/** "2 across · 50×25" */
export const rollSummary = (m) => [rollGrid(m), dims(m.labelW, m.labelH)].filter(Boolean).join(' · ');

/** The labels in each print as a small picture */
const miniGrid = (m) => h('span', { class: 'mini-grid', style: { gridTemplateColumns: `repeat(${m.cols}, 1fr)` }, 'aria-hidden': 'true' },
  ...Array.from({ length: perPrint(m) }, () => h('i')));

/** Labels in the middle of the roll: equal space left and right */
const centeredOnRoll = (m) => Math.abs(m.marginL - (m.linerW - labelsWidth(m)) / 2) < 0.06;

/** onDone(selectedId) after saving; forLabel: opened for the open label (saving also puts the roll on it) */
export async function openMediaManager(selectId, onDone, { forLabel = false } = {}) {
  let list = mediaList();
  const labelRoll = S.doc ? S.doc.page.mediaId : null;
  const sizes = new Map(list.map((m) => [m.id, `${m.labelW}x${m.labelH}`]));
  let cur = list.find((m) => m.id === selectId) || list[0];
  const printersInfo = await loadPrinters();
  let prof = profileFor(pickDefaultPrinter(printersInfo));
  const listBox = h('div', { class: 'media-list' });
  const form = h('div', { class: 'media-form' });
  const diagram = h('div', { class: 'media-diagram' });
  // While the window is open: which rolls keep their labels in the middle, and which names follow the layout
  const centered = new Map(), named = new Map();
  const isCentered = (m) => { if (!centered.has(m)) centered.set(m, centeredOnRoll(m)); return centered.get(m); };
  const isNamed = (m) => { if (!named.has(m)) named.set(m, !m.name || m.name === autoName(m)); return named.get(m); };
  let nameInp = null, fitLine = null, lit = null;

  const highlight = (key) => { lit = key; highlightDiagram(diagram, key); };
  const hookDim = (el, key) => {
    el.addEventListener('focusin', () => highlight(key));
    el.addEventListener('focusout', () => highlight(null));
    el.addEventListener('mouseenter', () => highlight(key));
    el.addEventListener('mouseleave', () => { if (!el.contains(document.activeElement)) highlight(null); });
    return el;
  };

  const drawList = () => listBox.replaceChildren(...list.map((m) => h('button', {
    class: 'media-item' + (m === cur ? ' on' : ''), type: 'button', onclick: () => { cur = m; drawAll(); },
  }, miniGrid(m), h('span', { class: 'mi-text' }, h('span', { class: 'mi-name' }, h('b', {}, m.name || autoName(m)),
    m.id === labelRoll ? h('span', { class: 'pill' }, t('media.thisLabel')) : null),
    h('span', { class: 'muted' }, `${rollSummary(m)} · ${t('media.rollW', { n: fmt(m.linerW) })}`)))));

  const drawDiagram = () => {
    diagram.replaceChildren(h('div', { class: 'media-dtitle' }, t('media.onePrintOf', { grid: t('media.grid', { cols: cur.cols, rows: cur.rows }) })),
      mediaDiagram(cur), h('div', { class: 'muted media-feed' }, '\u2193 ' + t('media.feedDir')));
    highlight(lit);
  };

  // Under the roll width: how the labels fit, or what to change when they do not
  const drawFit = () => {
    const L = layout(cur), need = labelsWidth(cur);
    const sides = isCentered(cur) ? 0 : 2 * Math.max(0, cur.marginL);
    const lines = [];
    if (cur.marginL < -0.05 || L.marginR < -0.05) {
      const roll = r2(need + sides);
      const label = Math.floor(((cur.linerW - sides - (cur.cols - 1) * cur.colGap) / cur.cols) * 10) / 10;
      lines.push(h('div', { class: 'err-text' }, t('media.noFit', { need: fmt(need), width: fmt(cur.linerW) })),
        h('div', { class: 'btn-row wrap' },
          h('button', { class: 'chip', type: 'button', onclick: () => { cur.linerW = roll; changed(true); } }, t('media.fixRoll', { n: fmt(roll) })),
          label > 0 ? h('button', { class: 'chip', type: 'button', onclick: () => { cur.labelW = label; changed(true); } }, t('media.fixLabel', { n: fmt(label) })) : null));
    } else if (isCentered(cur)) {
      lines.push(h('div', { class: 'muted' }, t('media.fits', { used: fmt(need), side: fmt(cur.marginL) })));
    } else {
      lines.push(h('div', { class: 'muted' }, t('media.fitsLR', { used: fmt(need), left: fmt(cur.marginL), right: fmt(L.marginR) })));
    }
    for (const p of problems(cur, prof.maxWidth || 108, true)) lines.push(h('div', { class: 'err-text' }, p));
    fitLine.replaceChildren(...lines);
  };

  // Something changed: keep the labels in the middle, let the name follow, redraw (rebuild: fields that come and go)
  const changed = (rebuild = false) => {
    Object.assign(cur, normMedia(cur));
    if (isCentered(cur)) cur.marginL = r2((cur.linerW - labelsWidth(cur)) / 2);
    if (isNamed(cur)) {
      cur.name = autoName(cur);
      if (nameInp) nameInp.value = cur.name;
    }
    if (rebuild) drawForm(); else drawFit();
    drawDiagram();
    drawList();
  };

  const num = (key, label, dimKey, opts = {}) => {
    const inp = h('input', { class: 'inp num', type: 'number', step: opts.step ?? 0.5, min: opts.min ?? 0, value: cur[key] });
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      if (Number.isNaN(v)) return;
      cur[key] = v;
      changed();
    });
    return hookDim(h('label', { class: 'field' }, h('span', {}, label), h('span', { class: 'num-wrap' }, inp, h('em', {}, 'mm'))), dimKey);
  };

  const stepper = (key, label, min, max) => {
    const set = (v) => { cur[key] = clamp(Math.round(v) || min, min, max); changed(true); };
    const val = h('input', { class: 'inp num', type: 'number', min, max, step: 1, value: cur[key], 'aria-label': label });
    val.addEventListener('change', () => set(parseFloat(val.value)));
    return h('div', { class: 'field' }, h('span', {}, label), h('div', { class: 'stepper' },
      h('button', { class: 'btn', type: 'button', 'aria-label': `${label} \u2212`, disabled: cur[key] <= min, onclick: () => set(cur[key] - 1) }, '\u2212'),
      val,
      h('button', { class: 'btn', type: 'button', 'aria-label': `${label} +`, disabled: cur[key] >= max, onclick: () => set(cur[key] + 1) }, '+')));
  };

  const drawForm = () => {
    isNamed(cur);   // decided before anything changes: a name made from the layout keeps following it
    nameInp = h('input', { class: 'inp', value: cur.name });
    nameInp.addEventListener('input', () => { cur.name = nameInp.value; named.set(cur, false); drawList(); });
    const sec = (title, ...kids) => h('section', { class: 'ms-sec' }, h('h4', {}, title), ...kids);
    const cont = cur.gapType === 'continuous';
    fitLine = h('div', { class: 'ms-fit' });
    const center = h('input', { type: 'checkbox', checked: isCentered(cur) });
    center.addEventListener('change', () => { centered.set(cur, center.checked); changed(true); });
    const gaps = [cur.cols > 1 ? num('colGap', t('media.colGap'), 'colGap') : null,
      cont ? null : num('rowGap', t(cur.gapType === 'bline' ? 'media.blineH' : 'media.rowGap'), 'rowGap')].filter(Boolean);
    const offsets = cur.cols > 1 ? h('div', { class: 'media-offs' }, h('span', { class: 'muted' }, t('media.colOffsets')),
      ...cur.colOffsets.map((v, i) => {
        const inp = h('input', { class: 'inp num', type: 'number', step: 0.1, value: v, title: t('media.col', { n: i + 1 }) });
        inp.addEventListener('input', () => { cur.colOffsets[i] = parseFloat(inp.value) || 0; changed(); });
        return h('label', { class: 'field' }, h('span', {}, t('media.col', { n: i + 1 })), inp);
      })) : null;
    form.replaceChildren(...[
      h('label', { class: 'field' }, h('span', {}, t('media.name')), nameInp),
      sec(t('media.perPrint'), hookDim(h('div', { class: 'ms-grid' },
        stepper('cols', t('media.across'), 1, 12), h('span', { class: 'ms-x' }, '\u00d7'), stepper('rows', t('media.down'), 1, 4), miniGrid(cur)), 'perPrint')),
      sec(t('media.oneLabel'), h('div', { class: 'ms-pair' },
        num('labelW', t('props.width'), 'labelW'), h('span', { class: 'ms-x' }, '\u00d7'), num('labelH', t('props.height'), 'labelH'))),
      gaps.length ? sec(t('media.gaps'), h('div', { class: 'prow' }, ...gaps)) : null,
      sec(t('media.roll'), h('div', { class: 'prow' }, num('linerW', t('media.linerW'), 'linerW'),
        isCentered(cur) ? h('span') : num('marginL', t('media.marginL'), 'margin', { min: -50 })),
      h('label', { class: 'check' }, center, h('span', {}, t('media.centered'))), fitLine),
      sec(t('media.paper'), h('div', { class: 'paper-cards' }, ...['gap', 'bline', 'continuous'].map((k) => h('button', {
        class: 'paper-card' + (cur.gapType === k ? ' on' : ''), type: 'button', 'aria-pressed': String(cur.gapType === k),
        onclick: () => { cur.gapType = k; changed(true); },
      }, h('span', { class: 'pc-ico', html: PAPER_ICONS[k] }), h('span', {}, t('media.gap.' + k)))))),
      h('details', { class: 'print-adv' }, h('summary', {}, t('media.more')),
        h('div', { class: 'prow' }, num('radius', t('media.radius'), 'radius'),
          cont ? h('span') : num('gapOffset', t('media.gapOffset'), 'rowGap', { min: -50, step: 0.1 })),
        offsets),
    ].filter(Boolean));
    drawFit();
  };
  const drawAll = () => { drawList(); drawForm(); drawDiagram(); };

  // Printer tools
  const printerSel = h('select', { class: 'inp' }, ...printersInfo.printers.map((p) => h('option', { value: p.name, selected: p.name === prof.printer }, p.name)));
  const method = h('select', { class: 'inp' }, h('option', { value: 'tspl' }, t('print.methodTspl')), h('option', { value: 'network' }, t('print.methodNetwork')), h('option', { value: 'driver' }, t('print.methodDriver')));
  method.value = prof.method;
  printerSel.addEventListener('change', () => { prof = profileFor(printerSel.value); method.value = prof.method; drawFit(); });
  const settingsNow = () => ({ ...prof, method: method.value, printer: printerSel.value, ...tsplOf(normMedia(cur)) });
  const command = async (cmd, okMsg) => {
    try {
      await api('/api/printer/command', { cmd, settings: settingsNow() });
      toast(okMsg, 'ok');
    } catch (e) { toast(e.message, 'error', 7000); }
  };
  const testPrint = async () => {
    const st = settingsNow();
    const c = layoutTestCanvas(normMedia(cur), st.dpi || 203, st);
    const mono = toMono(c, 140);
    try {
      await api('/api/print', { jobName: 'layout test', settings: st, pages: [{ w: mono.w, h: mono.h, bits: monoToBase64(mono), copies: 1 }] });
      toast(t('media.testSent'), 'ok');
    } catch (e) { toast(e.message, 'error', 7000); }
  };
  const tools = h('details', { class: 'print-adv' },
    h('summary', {}, t('media.tools')),
    h('div', { class: 'prow' }, h('label', { class: 'field' }, h('span', {}, t('print.printer')), printerSel), h('label', { class: 'field' }, h('span', {}, t('print.method')), method)),
    h('div', { class: 'btn-row wrap' },
      h('button', { class: 'btn', onclick: () => command('calibrate', t('media.calibrateSent')) }, t('media.calibrate')),
      h('button', { class: 'btn', onclick: () => command('feed', t('media.fed')) }, t('media.feed')),
      h('button', { class: 'btn btn-primary', onclick: testPrint }, t('media.testPrint')),
      // Loaded on demand: the printer control window itself uses this module
      h('button', { class: 'btn btn-ghost', onclick: async () => (await import('./printercontrol.js')).openPrinterControl(printerSel.value, cur.id) }, t('pc.open'))));

  const add = (base, name) => {
    const m = normMedia({ ...(base ? clone(base) : MEDIA_DEFAULT), id: uid(), name: name ?? `${base.name}${t('media.copySuffix')}` });
    list.push(m);
    cur = m;
    drawAll();
  };
  const common = h('details', { class: 'media-common' }, h('summary', {}, t('media.common')),
    h('div', { class: 'media-list' }, ...COMMON.map(([cols, w, hh, roll, gap]) => {
      const m = normMedia({ cols, labelW: w, labelH: hh, linerW: roll, colGap: gap, marginL: r2((roll - cols * w - (cols - 1) * gap) / 2), rowGap: 2, radius: 2 });
      return h('button', { class: 'media-item', type: 'button', onclick: () => add(m, autoName(m)) },
        miniGrid(m), h('span', { class: 'mi-text' }, h('b', {}, autoName(m)), h('span', { class: 'muted' }, t('media.rollW', { n: roll }))));
    })));
  drawAll();
  const res = await dialog({
    title: t('media.title'), wide: true, onOpen: (box) => box.classList.add('dlg-rolls'),
    body: h('div', { class: 'media-dlg' },
      h('div', { class: 'media-side' }, h('h4', {}, t('media.mine')), listBox,
        h('div', { class: 'btn-row wrap' },
          h('button', { class: 'chip', type: 'button', onclick: () => add(normMedia(MEDIA_DEFAULT), autoName(normMedia(MEDIA_DEFAULT))) }, '+ ' + t('media.newRoll')),
          h('button', { class: 'chip', type: 'button', onclick: () => add(cur) }, t('common.copy')),
          h('button', {
            class: 'chip danger', type: 'button', onclick: async () => {
              if (list.length < 2) return;
              if (!(await confirmBox(t('media.deleteTitle'), t('media.deleteText', { name: cur.name }), t('common.delete'), true))) return;
              list = list.filter((m) => m !== cur);
              cur = list[0];
              drawAll();
            },
          }, t('common.delete'))),
        common),
      form,
      h('div', { class: 'media-view' }, diagram, tools)),
    buttons: [{ label: t(forLabel ? 'media.saveUse' : 'common.save'), value: true, primary: true }, { label: t('common.cancel'), value: false }],
  });
  if (!res) return null;
  await saveMediaList(list);
  // Labels follow their roll: the open label is resized when the size of its roll's labels changed
  emit('rolls-saved', list.filter((m) => sizes.has(m.id) && sizes.get(m.id) !== `${m.labelW}x${m.labelH}`).map((m) => m.id));
  toast(t('media.saved'), 'ok', 1500);
  if (onDone) onDone(cur.id);
  return cur.id;
}
