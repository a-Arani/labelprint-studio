// Print dialog: roll, automatic rotation, several labels per row, counter range, preview and sending
import { S, snapshot, changed, emit } from './state.js';
import {
  h, api, toast, dialog, confirmBox, buildRecords, usesVariables, formatDate, formatDateTime, counterValue, r2, clone, dims, ltr,
} from './util.js';
import * as logger from './logger.js';
import { rasterize, toMono, monoToCanvas, monoToBase64, bbox } from './render.js';
import { loadPrinters, profileFor, saveProfile, pickDefaultPrinter, baseName } from './printers.js';
import { mediaList, matchMedia, normMedia, layout, problems, tsplOf, openMediaManager } from './media.js';
import { rotOptions, rotValue } from './panels.js';
import { openPrinterControl } from './printercontrol.js';
import { t } from './i18n.js';

const eq = (a, b) => Math.abs(a - b) <= 0.6;

/** Rotation needed to place the design on the roll label. choice: auto | auto180 | 0 | 90 | 180 | 270 */
export function orient(page, m, choice) {
  let rot;
  if (choice === 'auto' || choice === 'auto180') {
    const direct = eq(page.w, m.labelW) && eq(page.h, m.labelH);
    const turned = eq(page.h, m.labelW) && eq(page.w, m.labelH);
    if (direct) rot = 0;
    else if (turned) rot = 90;
    else {
      const s0 = Math.min(m.labelW / page.w, m.labelH / page.h);
      const s90 = Math.min(m.labelW / page.h, m.labelH / page.w);
      rot = s90 > s0 * 1.001 ? 90 : 0;
    }
    if (choice === 'auto180') rot = (rot + 180) % 360;
  } else {
    rot = Number(choice) || 0;
  }
  const swap = rot % 180 !== 0;
  const dw = swap ? page.h : page.w, dh = swap ? page.w : page.h;
  return { rot, dw, dh, exact: eq(dw, m.labelW) && eq(dh, m.labelH) };
}

/** Temporary roll the size of the design itself (for old labels without a roll) */
function adhocMedia(page, choice, prof) {
  const rot = choice === 'auto' || choice === 'auto180' ? 0 : Number(choice) || 0;
  const swap = rot % 180 !== 0;
  return normMedia({
    id: 'adhoc', name: t('print.adhoc'), cols: 1, marginL: 0, colGap: 0,
    labelW: swap ? page.h : page.w, labelH: swap ? page.w : page.h, linerW: swap ? page.h : page.w,
    rowGap: prof.gap ?? 2, gapType: prof.media || 'gap', radius: 0,
  });
}

// ---------------------------------------------------------------- row layout
function placeCell(src, m, dpmm, o, fitMode) {
  const LW = Math.round(m.labelW * dpmm), LH = Math.round(m.labelH * dpmm);
  if (o.exact) return src;
  const c = document.createElement('canvas');
  c.width = LW;
  c.height = LH;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, LW, LH);
  const s = fitMode === 'fit' ? Math.min(LW / src.width, LH / src.height) : 1;
  const w = src.width * s, hh = src.height * s;
  g.imageSmoothingEnabled = true;
  g.drawImage(src, (LW - w) / 2, (LH - hh) / 2, w, hh);
  return c;
}

function composeRow(m, cells, dpmm, prof, shift = NO_SHIFT) {
  const L = layout(m);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(m.linerW * dpmm));
  c.height = Math.max(1, Math.round(m.labelH * dpmm));
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  const LW = Math.round(m.labelW * dpmm), LH = Math.round(m.labelH * dpmm);
  cells.forEach((cell, i) => {
    if (!cell) return;
    const x = Math.round((L.xs[i] + (prof.offX || 0) + shift.x) * dpmm), y = Math.round(((prof.offY || 0) + shift.y) * dpmm);
    // Each label stays inside its own cell
    g.save();
    g.beginPath();
    g.rect(x, y, LW, LH);
    g.clip();
    g.drawImage(cell, x, y);
    g.restore();
  });
  return c;
}

const NO_SHIFT = { x: 0, y: 0 };

/** Black dots in a 1-bit image; with m and dpmm, only those that land on a label (not on the liner around it) */
function countInk(mono, m, dpmm) {
  const cols = m ? layout(m).xs.map((x) => [Math.round(x * dpmm), Math.round((x + m.labelW) * dpmm)]) : null;
  let n = 0;
  for (let y = 0; y < mono.h; y++) {
    for (let x = 0; x < mono.w; x++) {
      if (!(mono.bits[y * mono.wb + (x >> 3)] & (0x80 >> (x & 7)))) continue;
      if (!cols || cols.some(([a, b]) => x >= a && x < b)) n++;
    }
  }
  return n;
}

/** Number of labels and rows, without rendering */
export function plan(recCount, copies, cols, fill) {
  if (fill === 'same') {
    const rows = recCount * copies;
    return { labels: rows * cols, rows, empty: 0 };
  }
  const labels = recCount * copies;
  const rows = Math.ceil(labels / cols);
  return { labels, rows, empty: rows * cols - labels };
}

/** Render rows one by one: {mono, copies, labels, idx, errors} */
async function* renderRows(label, recs, cfg, onProgress = () => {}) {
  const { m, o, dpi, fill, copies, fitMode, prof } = cfg;
  const dpmm = dpi / 25.4;
  const cols = m.cols;
  const identical = !usesVariables(label);
  const cache = new Map();
  const cellOf = async (i) => {
    const key = identical ? 0 : i;
    if (!cache.has(key)) {
      const c = await rasterize(label, { dpi, rotate: o.rot, values: recs[key] || {} });
      cache.set(key, { cell: placeCell(c, m, dpmm, o, fitMode), errors: c.errors });
      if (cache.size > 8) cache.delete(cache.keys().next().value);
    }
    return cache.get(key);
  };
  const row = (cells) => toMono(composeRow(m, cells, dpmm, prof, cfg.shift || NO_SHIFT), prof.threshold);
  if (identical) {
    const p = plan(recs.length, copies, cols, fill);
    const { cell, errors } = await cellOf(0);
    const full = Math.floor(p.labels / cols), rem = p.labels % cols;
    onProgress(1, 1);
    if (full) yield { mono: row(Array(cols).fill(cell)), cells: Array(cols).fill(cell), copies: full, labels: full * cols, idx: recs.length - 1, errors };
    if (rem) yield { mono: row(Array(rem).fill(cell)), cells: Array(rem).fill(cell), copies: 1, labels: rem, idx: recs.length - 1, errors };
    return;
  }
  if (fill === 'same') {
    for (let i = 0; i < recs.length; i++) {
      const { cell, errors } = await cellOf(i);
      onProgress(i + 1, recs.length);
      yield { mono: row(Array(cols).fill(cell)), cells: Array(cols).fill(cell), copies, labels: copies * cols, idx: i, errors };
    }
    return;
  }
  const items = [];
  for (let i = 0; i < recs.length; i++) for (let k = 0; k < copies; k++) items.push(i);
  for (let k = 0; k < items.length; k += cols) {
    const slice = items.slice(k, k + cols);
    const cells = [], errors = [];
    for (const idx of slice) {
      const c = await cellOf(idx);
      cells.push(c.cell);
      errors.push(...c.errors);
    }
    onProgress(Math.min(items.length, k + cols), items.length);
    yield { mono: row(cells), cells, copies: 1, labels: slice.length, idx: slice[slice.length - 1], errors };
  }
}

// Preview: grey liner, white labels and what will be printed
function previewCanvas(m, mono, dpmm, prof) {
  const ink = monoToCanvas(mono);
  const c = document.createElement('canvas');
  c.width = ink.width;
  c.height = ink.height;
  const g = c.getContext('2d');
  g.fillStyle = '#c9ced6';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff';
  const L = layout(m);
  for (let i = 0; i < m.cols; i++) {
    const x = L.xs[i] * dpmm, w = m.labelW * dpmm, hh = m.labelH * dpmm, r = Math.min(m.radius * dpmm, w / 2, hh / 2);
    g.beginPath();
    if (g.roundRect) g.roundRect(x, 0, w, hh, r); else g.rect(x, 0, w, hh);
    g.fill();
  }
  g.globalCompositeOperation = 'multiply';
  g.drawImage(ink, 0, 0);
  return c;
}

// Print through the browser print dialog (fallback when other methods fail)
async function browserPrint(label, recs, cfg) {
  const { m } = cfg;
  const urls = [];
  for await (const pg of renderRows(label, recs, cfg)) {
    const url = monoToCanvas(pg.mono).toDataURL('image/png');
    for (let i = 0; i < pg.copies; i++) urls.push(url);
  }
  const frame = h('iframe', { style: { position: 'fixed', width: '0', height: '0', border: '0', left: '-9999px' } });
  document.body.append(frame);
  const d = frame.contentDocument;
  d.open();
  d.write(`<!doctype html><html><head><style>@page{size:${m.linerW}mm ${m.labelH}mm;margin:0}html,body{margin:0}`
    + `img{display:block;width:${m.linerW}mm;height:${m.labelH}mm;page-break-after:always;image-rendering:pixelated}</style></head><body>`
    + urls.map((u) => `<img src="${u}">`).join('') + '</body></html>');
  d.close();
  await new Promise((r) => setTimeout(r, 300));
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.remove(), 60000);
}

// ---------------------------------------------------------------- dialog
// Printed ranges such as "1–120, 200–250"
const rangesText = (rs) => (rs || []).map(([a, b]) => ltr(a === b ? a : `${a}–${b}`)).join(t('common.listSep'));

/** preset: {from, to} to reprint a range from the history */
export async function openPrint(preset = {}) {
  if (!S.doc) return;
  const label = S.doc;
  const page = label.page;
  const list = await loadPrinters();
  let hist = null;
  if (label.uid) {
    try { hist = (await api('/api/history/label?uid=' + encodeURIComponent(label.uid))).summary; } catch (e) { hist = null; }
  }
  let prof = profileFor(pickDefaultPrinter(list));
  const vars = label.variables || [];
  const counter = vars.find((v) => v.type === 'counter');
  const hasRows = (label.data && label.data.rows && label.data.rows.length) || vars.some((v) => v.type === 'list' && (v.values || []).length);
  const rowsLen = label.data?.rows?.length || Math.max(0, ...vars.filter((v) => v.type === 'list').map((v) => (v.values || []).length));

  // ---------- form
  const inp = (attrs) => h('input', { class: 'inp', ...attrs });
  const cstep = counter ? Number(counter.step || 1) : 1;
  const lastInfo = counter && hist && hist.counters[counter.name];
  const firstNum = preset.from ?? (lastInfo && lastInfo.last !== null ? lastInfo.last + cstep : (counter ? counter.start ?? 1 : 1));
  const from = counter ? inp({ type: 'number', value: firstNum, step: cstep }) : null;
  const to = counter ? inp({ type: 'number', value: preset.to ?? firstNum, step: cstep }) : null;
  const printedRanges = counter && hist ? hist.ranges[counter.name] || [] : [];
  const rowFrom = !counter && hasRows ? inp({ type: 'number', value: 1, min: 1, max: rowsLen }) : null;
  const rowTo = !counter && hasRows ? inp({ type: 'number', value: rowsLen, min: 1, max: rowsLen }) : null;
  const copies = inp({ type: 'number', value: 1, min: 1, max: 9999 });
  const texts = {}, dates = {};
  const askFields = [];
  for (const v of vars) {
    if (v.type === 'text' && v.ask) {
      texts[v.name] = inp({ value: v.value || '', dir: 'auto' });
      askFields.push(h('label', { class: 'field' }, h('span', {}, v.name), texts[v.name]));
    }
    if (v.type === 'date') {
      const d = new Date();
      d.setDate(d.getDate() + Number(v.offset || 0));
      dates[v.name] = inp({ value: formatDate(d, v), dir: 'ltr' });
      askFields.push(h('label', { class: 'field' }, h('span', {}, v.name), dates[v.name]));
    }
  }
  const printerSel = h('select', { class: 'inp' }, ...list.printers.map((p) => h('option', { value: p.name, selected: p.name === prof.printer }, p.name)));
  if (!list.printers.length) printerSel.append(h('option', { value: '' }, t('print.noPrinters')));
  const method = h('select', { class: 'inp' },
    h('option', { value: 'tspl' }, t('print.methodTspl')), h('option', { value: 'driver' }, t('print.methodDriver')), h('option', { value: 'network' }, t('print.methodNetwork')));

  // Roll and rotation
  const mediaSel = h('select', { class: 'inp' });
  const fillMedia = (selId) => {
    const ms = mediaList();
    mediaSel.replaceChildren(h('option', { value: 'adhoc' }, t('print.adhoc')),
      ...ms.map((m) => h('option', { value: m.id }, `${m.name} — ${m.cols > 1 ? t('page.cols', { n: m.cols }) + ' · ' : ''}${dims(m.labelW, m.labelH)}`)));
    mediaSel.value = ms.some((m) => m.id === selId) ? selId : 'adhoc';
  };
  fillMedia(page.mediaId || (matchMedia(page) || {}).id);
  const rotate = h('select', { class: 'inp' }, ...rotOptions().map(([v, l]) => h('option', { value: v }, l)));
  rotate.value = rotValue(page.printRotate);
  if (!rotate.value) rotate.value = 'auto';
  const fitSel = h('select', { class: 'inp' }, h('option', { value: 'fit' }, t('print.fitScale')), h('option', { value: 'center' }, t('print.fitCenter')));
  fitSel.value = page.fitMode || 'fit';
  const fillSel = h('select', { class: 'inp' }, h('option', { value: 'seq' }, t('print.fillSeq')), h('option', { value: 'same' }, t('print.fillSame')));
  fillSel.value = page.fill || 'seq';

  const st = {
    dpi: h('select', { class: 'inp' }, h('option', { value: 203 }, t('print.dpi203')), h('option', { value: 300 }, t('print.dpi300')), h('option', { value: 600 }, '600')),
    speed: h('select', { class: 'inp' }, ...[2, 3, 4, 5, 6].map((s) => h('option', { value: s }, s))),
    density: h('select', { class: 'inp' }, ...Array.from({ length: 16 }, (_, i) => h('option', { value: i }, i))),
    direction: h('select', { class: 'inp' }, h('option', { value: 1 }, '1'), h('option', { value: 0 }, '0')),
    offX: inp({ type: 'number', step: 0.5 }),
    offY: inp({ type: 'number', step: 0.5 }),
    maxWidth: inp({ type: 'number', step: 1, min: 20 }),
    threshold: inp({ type: 'range', min: 40, max: 230, step: 5 }),
    invert: h('input', { type: 'checkbox' }),
    host: inp({ dir: 'ltr', placeholder: '192.168.1.50' }),
    port: inp({ type: 'number', dir: 'ltr' }),
  };
  const F = (label_, input) => h('label', { class: 'field' }, h('span', {}, label_), input);
  const netRow = h('div', { class: 'prow' }, F(t('print.ip'), st.host), F(t('print.port'), st.port));
  const printerRow = h('div', {}, F(t('print.printer'), printerSel));
  const tsplOnly = [
    h('div', { class: 'prow' }, F(t('print.speed'), st.speed), F(t('print.density'), st.density)),
    h('div', { class: 'prow' }, F(t('print.direction'), st.direction), h('label', { class: 'check' }, st.invert, h('span', {}, t('print.invert')))),
  ];
  const fill = () => {
    method.value = prof.method;
    for (const [k, el] of Object.entries(st)) {
      if (el.type === 'checkbox') el.checked = !!prof[k];
      else el.value = prof[k];
    }
    netRow.hidden = prof.method !== 'network';
    printerRow.hidden = prof.method === 'network';
    tsplOnly.forEach((n) => { n.hidden = prof.method === 'driver'; });
  };
  const read = () => {
    prof.method = method.value;
    for (const [k, el] of Object.entries(st)) {
      if (el.type === 'checkbox') prof[k] = el.checked;
      else if (k === 'host') prof[k] = el.value.trim();
      else prof[k] = parseFloat(el.value) || 0;
    }
    prof.printer = printerSel.value;
    return prof;
  };

  // Position shift for this print only (not saved): print one test label, look, adjust, then print
  const shift = { x: 0, y: 0 };
  const stepSel = h('select', { class: 'inp pa-step', title: t('print.step') },
    ...[0.1, 0.5, 1, 2].map((v) => h('option', { value: v, selected: v === 0.5 }, `${v} mm`)));
  const shiftIn = (k) => {
    const box = h('input', { class: 'inp num', type: 'number', step: 0.1, value: 0 });
    box.addEventListener('change', () => { shift[k] = r2(parseFloat(box.value) || 0); });
    return box;
  };
  const shiftX = shiftIn('x'), shiftY = shiftIn('y');
  const nudge = (dx, dy) => {
    const st = parseFloat(stepSel.value);
    shift.x = r2(shift.x + dx * st);
    shift.y = r2(shift.y + dy * st);
    shiftX.value = shift.x;
    shiftY.value = shift.y;
    later();
  };
  const arrow = (label, title, dx, dy) => h('button', {
    class: 'btn pa-arrow', type: 'button', title, 'aria-label': title, onclick: () => nudge(dx, dy),
  }, label);
  const adjustWarn = h('div', { class: 'err-text', hidden: true }, t('print.shiftOutside'));
  const testBtn = h('button', { class: 'btn', type: 'button', onclick: () => testPrint() }, t('print.testOne'));
  const adjustBox = h('div', { class: 'print-adjust' },
    h('div', { class: 'pa-head' }, h('b', {}, t('print.adjustTitle')), testBtn),
    h('div', { class: 'pa-body' },
      h('div', { class: 'pa-pad', dir: 'ltr' },
        h('span'), arrow('\u2191', t('print.moveUp'), 0, -1), h('span'),
        arrow('\u2190', t('print.moveLeft'), -1, 0),
        h('button', { class: 'btn pa-zero', type: 'button', title: t('print.shiftReset'), onclick: () => { shift.x = 0; shift.y = 0; shiftX.value = 0; shiftY.value = 0; later(); } }, '0'),
        arrow('\u2192', t('print.moveRight'), 1, 0),
        h('span'), arrow('\u2193', t('print.moveDown'), 0, 1), h('span')),
      h('div', { class: 'pa-fields' },
        F(t('print.shiftX'), h('span', { class: 'num-wrap' }, shiftX, h('em', {}, 'mm'))),
        F(t('print.shiftY'), h('span', { class: 'num-wrap' }, shiftY, h('em', {}, 'mm'))),
        F(t('print.step'), stepSel))),
    adjustWarn);

  const countInfo = h('div', { class: 'print-count' });
  const setupInfo = h('div', { class: 'print-setup' });
  const previewBox = h('div', { class: 'print-preview' });
  const progress = h('div', { class: 'print-progress', hidden: true }, h('div', { class: 'bar' }), h('span'));
  const errorsBox = h('div', { class: 'print-errors' });
  const fitRow = h('div', { class: 'prow' }, F(t('print.fitLabel'), fitSel), h('span'));
  const fillRow = h('div', { class: 'prow' }, F(t('print.fillLabel'), fillSel), h('span'));

  const records = () => buildRecords(label, {
    from: from ? parseFloat(from.value) : undefined,
    to: to ? parseFloat(to.value) : undefined,
    rowFrom: rowFrom ? parseInt(rowFrom.value, 10) : undefined,
    rowTo: rowTo ? parseInt(rowTo.value, 10) : undefined,
    texts: Object.fromEntries(Object.entries(texts).map(([k, v]) => [k, v.value])),
    dates: Object.fromEntries(Object.entries(dates).map(([k, v]) => [k, v.value])),
  });

  /** Current state: roll, rotation and layout settings */
  const setup = () => {
    read();
    const choice = rotate.value;
    const m = mediaSel.value === 'adhoc' ? adhocMedia(page, choice, prof) : normMedia(mediaList().find((x) => x.id === mediaSel.value));
    const o = orient(page, m, choice);
    const n = Math.max(1, parseInt(copies.value, 10) || 1);
    return { m, o, dpi: prof.dpi, fill: m.cols > 1 ? fillSel.value : 'seq', copies: n, fitMode: fitSel.value, prof, shift: { ...shift } };
  };

  const describe = (cfg, recCount) => {
    const { m, o } = cfg;
    fitRow.hidden = o.exact;
    fillRow.hidden = m.cols < 2;
    const lines = [h('div', {}, t(m.cols > 1 ? 'print.setupCols' : 'print.setup', {
      design: dims(page.w, page.h), roll: m.name, cols: m.cols, label: dims(m.labelW, m.labelH), rot: ltr(o.rot + '°'),
    }))];
    const warns = [...problems(m, prof.maxWidth || 108)];
    if (!o.exact) warns.push(t('print.sizeMismatch', { design: dims(r2(o.dw), r2(o.dh)), label: dims(m.labelW, m.labelH) }));
    const out = label.elements.some((e) => {
      if (e.hidden) return false;
      const b = bbox(e);
      return b.x < -0.5 || b.y < -0.5 || b.x + b.w > page.w + 0.5 || b.y + b.h > page.h + 0.5;
    });
    if (out) warns.push(t('print.outside'));
    for (const w of warns) lines.push(h('div', { class: 'err-text' }, w));
    setupInfo.replaceChildren(...lines);
    const p = plan(recCount, cfg.copies, m.cols, cfg.fill);
    countInfo.textContent = !recCount ? t('print.badRange')
      : m.cols < 2 ? t('print.total', { n: p.labels })
        : p.empty ? t('print.totalRowsEmpty', { n: p.labels, rows: p.rows, empty: p.empty })
          : t('print.totalRows', { n: p.labels, rows: p.rows });
    return p;
  };

  let previewToken = 0;
  const updatePreview = async () => {
    const token = ++previewToken;
    const cfg = setup();
    const recs = records();
    const p = describe(cfg, recs.length);
    previewBox.replaceChildren();
    errorsBox.replaceChildren();
    let shown = 0;
    const dpmm = cfg.dpi / 25.4;
    adjustWarn.hidden = true;
    for await (const row of renderRows(label, recs, cfg)) {
      if (token !== previewToken) return;
      if (!shown) {
        // Ink that the printer offsets or the shift push off the label (onto the liner, or off the edge)
        const design = countInk(toMono(composeRow(cfg.m, row.cells, dpmm, { offX: 0, offY: 0 }), prof.threshold));
        const onLabel = countInk(row.mono, cfg.m, dpmm);
        adjustWarn.hidden = design - onLabel <= Math.max(8, design * 0.002);
      }
      const pv = previewCanvas(cfg.m, row.mono, dpmm, prof);
      pv.className = 'pv';
      previewBox.append(h('div', { class: 'pv-wrap' }, pv, h('span', {}, dims(pv.width, pv.height) + (row.copies > 1 ? ` × ${row.copies}` : ''))));
      for (const err of row.errors) errorsBox.append(h('div', {}, err));
      if (++shown >= 3) break;
    }
    if (p.rows > shown && token === previewToken) previewBox.append(h('div', { class: 'pv-more' }, t('print.moreRows', { n: p.rows - shown })));
  };

  const ready = () => {
    if (prof.method !== 'network' && !prof.printer) { toast(t('print.noPrinter'), 'error'); return false; }
    if (prof.method === 'network' && !prof.host) { toast(t('print.noIp'), 'error'); return false; }
    return true;
  };

  // One row with the first label(s); not recorded in the history and no numbers are used up
  const testPrint = async () => {
    const cfg = setup();
    if (!ready()) return;
    const recs = records();
    if (!recs.length) { toast(t('print.badRange'), 'error'); return; }
    testBtn.disabled = true;
    try {
      const first = recs.slice(0, cfg.m.cols);
      const it = renderRows(label, first, { ...cfg, copies: 1, fill: 'seq' });
      const { value: row } = await it.next();
      if (row.errors.length) throw new Error(row.errors[0]);
      await api('/api/print', {
        jobName: `${label.name || 'Label'} test`, settings: { ...prof, ...tsplOf(cfg.m) },
        pages: [{ w: row.mono.w, h: row.mono.h, bits: monoToBase64(row.mono), copies: 1 }],
      });
      logger.info(`Test print: "${label.name}"`, { shift: cfg.shift, printer: prof.printer, method: prof.method });
      toast(t('print.testSent'), 'ok', 4000);
    } catch (e) {
      toast(e.message, 'error', 7000);
    } finally {
      testBtn.disabled = false;
    }
  };

  let printing = false;
  const doPrint = async (close) => {
    if (printing) return;
    const cfg = setup();
    if (!ready()) return;
    const recs = records();
    if (!recs.length) { toast(t('print.badRange'), 'error'); return; }
    const opt = { from: from ? parseFloat(from.value) : undefined, to: to ? parseFloat(to.value) : undefined };
    if (counter) {
      const a = Math.min(opt.from, opt.to), b = Math.max(opt.from, opt.to);
      const hit = printedRanges.filter(([x, y]) => x <= b && y >= a);
      if (hit.length && !(await confirmBox(t('print.dupTitle'),
        t('print.dupText', { ranges: rangesText(hit) }), t('print.reprint')))) return;
    }
    const pr = problems(cfg.m, prof.maxWidth || 108);
    if (pr.length && !(await confirmBox(t('print.rollSize'), t('print.rollProblems', { list: pr.join(' — ') }), t('print.print')))) return;
    printing = true;
    await saveProfile({ ...prof });
    progress.hidden = false;
    const bar = progress.querySelector('.bar'), txt = progress.querySelector('span');
    const p = plan(recs.length, cfg.copies, cfg.m.cols, cfg.fill);
    const textVals = Object.fromEntries(Object.entries(texts).map(([k, v]) => [k, v.value]));
    const dateVals = Object.fromEntries(Object.entries(dates).map(([k, v]) => [k, v.value]));
    let job = null;
    try {
      job = (await api('/api/print/begin', {
        label_uid: label.uid || null, label_path: S.path, label_name: label.name, kind: label.kind || 'label',
        template_uid: (label.fromTemplate || {}).uid || null,
        printer: prof.method === 'network' ? `${prof.host}:${prof.port}` : prof.printer,
        method: prof.method, counter: counter ? counter.name : null, c_from: opt.from ?? null, c_to: opt.to ?? null,
        c_step: counter ? cstep : null, rows_from: rowFrom ? parseInt(rowFrom.value, 10) : null,
        rows_to: rowTo ? parseInt(rowTo.value, 10) : null, copies: cfg.copies, planned: p.labels,
        values_json: JSON.stringify({ texts: textVals, dates: dateVals, media: cfg.m, rotate: cfg.o.rot, fill: cfg.fill, shift: cfg.shift }),
      })).job;
    } catch (e) {
      toast(t('print.jobFailed', { error: e.message }), 'error');
      printing = false;
      progress.hidden = true;
      return;
    }
    logger.info(`Print #${job} started: "${label.name}" ${p.labels} labels in ${p.rows} rows`, {
      from: opt.from, to: opt.to, printer: prof.printer, method: prof.method, media: cfg.m.name, cols: cfg.m.cols, rot: cfg.o.rot,
      shift: cfg.shift,
    });
    const settings = { ...prof, ...tsplOf(cfg.m) };
    let batch = [], part = 1, sentLabels = 0;
    const flush = async () => {
      if (!batch.length) return;
      const lastIdx = batch[batch.length - 1].idx;
      const count = batch.reduce((acc, r) => acc + r.labels, 0);
      await api('/api/print', {
        job, jobName: `${label.name || 'Label'} ${part++}`, settings,
        sent: count, last: counter ? counterValue(label, opt, lastIdx) : null,
        pages: batch.map((r) => ({ w: r.mono.w, h: r.mono.h, bits: monoToBase64(r.mono), copies: r.copies })),
      });
      sentLabels += count;
      batch = [];
    };
    let failed = null;
    try {
      for await (const row of renderRows(label, recs, cfg, (i, tot) => {
        bar.style.width = `${Math.round((i / tot) * 100)}%`;
        txt.textContent = t('print.progress', { i, n: tot });
      })) {
        if (row.errors.length) throw new Error(row.errors[0]);
        batch.push(row);
        if (batch.length >= 25) await flush();
      }
      await flush();
    } catch (e) {
      failed = e;
    }
    let end = {};
    try { end = await api('/api/print/end', { job, error: failed ? failed.message : undefined }); } catch (e) { /* the server records it too */ }
    printing = false;
    emit('printed', label.uid);
    if (failed) {
      const upto = end.sent_to !== null && end.sent_to !== undefined ? ' ' + t('print.upTo', { n: end.sent_to }) : '';
      toast(t('print.incomplete', { error: failed.message }) + (sentLabels ? ` (${t('print.sentCount', { n: sentLabels })}${upto})` : ''), 'error', 10000);
      progress.hidden = true;
      return;
    }
    toast(t('print.sent', { n: sentLabels }) + (counter ? ` (${t('print.upTo', { n: counterValue(label, opt, recs.length - 1) })})` : ''), 'ok', 5000);
    close(true);
  };

  const rangeRows = [];
  if (counter) {
    rangeRows.push(h('div', { class: 'prow' }, F(t('print.from', { name: counter.name }), from), F(t('print.to'), to)));
    if (lastInfo && lastInfo.last !== null) {
      rangeRows.push(h('div', { class: 'print-last' },
        t('print.lastPrint', { n: ltr(lastInfo.last), when: formatDateTime(lastInfo.updated) }),
        printedRanges.length ? h('div', { class: 'muted' }, t('print.printedRanges', { ranges: rangesText(printedRanges) })) : null));
    }
  }
  if (rowFrom) rangeRows.push(h('div', { class: 'prow' }, F(t('print.rowFrom'), rowFrom), F(t('print.rowTo'), rowTo)));

  const mediaBtn = h('button', {
    class: 'btn btn-ghost', type: 'button',
    onclick: () => openMediaManager(mediaSel.value, (id) => { fillMedia(id); updatePreview(); }),
  }, t('page.rollTypes'));
  const body = h('div', { class: 'print-dlg' },
    h('div', { class: 'print-side' }, previewBox, errorsBox),
    h('div', { class: 'print-form' },
      printerRow,
      h('div', { class: 'prow' }, F(t('print.method'), method), F(t('print.rotation'), rotate)),
      netRow,
      h('div', { class: 'media-row' }, F(t('print.roll'), mediaSel), mediaBtn),
      setupInfo, fitRow, fillRow,
      ...rangeRows,
      ...askFields,
      h('div', { class: 'prow' }, F(t('print.copies'), copies), countInfo),
      adjustBox,
      h('details', { class: 'print-adv' },
        h('summary', {}, t('print.printerSettings')),
        h('div', { class: 'prow' }, F(t('print.dpi'), st.dpi), F(t('print.maxWidth'), st.maxWidth)),
        ...tsplOnly,
        h('div', { class: 'prow' }, F(t('print.offX'), st.offX), F(t('print.offY'), st.offY)),
        F(t('print.threshold'), st.threshold)),
      progress,
      h('div', { class: 'btn-row wrap' },
        h('button', { class: 'linkish', onclick: () => browserPrint(label, records(), setup()) }, t('print.browserPrint')),
        h('button', { class: 'linkish', onclick: () => openPrinterControl(prof.printer) }, t('pc.open')))));

  fill();
  const before = { mediaId: page.mediaId, printRotate: page.printRotate, fitMode: page.fitMode, fill: page.fill };
  let timer;
  const later = () => { clearTimeout(timer); timer = setTimeout(updatePreview, 250); };
  body.addEventListener('input', later);
  body.addEventListener('change', later);
  method.addEventListener('change', () => { read(); fill(); });
  printerSel.addEventListener('change', async () => {
    const asked = printerSel.value;
    prof = profileFor(asked);
    fill();
    updatePreview();
    // Read the driver dpi so the image is rendered at the same resolution
    if (!(S.settings.printers || {})[baseName(asked)]) {
      try {
        const caps = await api('/api/printer/caps', { printer: asked });
        if (caps.dpiX && caps.dpiX <= 600 && printerSel.value === asked) {
          read();
          prof.dpi = caps.dpiX;
          fill();
          updatePreview();
        }
      } catch (e) { /* not important */ }
    }
  });
  if (!(S.settings.printers || {})[baseName(prof.printer)] && prof.printer) {
    const asked = prof.printer;
    api('/api/printer/caps', { printer: asked }).then((caps) => {
      if (!caps.dpiX || caps.dpiX > 600 || printerSel.value !== asked) return;
      read();
      if (prof.dpi !== caps.dpiX) { prof.dpi = caps.dpiX; fill(); updatePreview(); }
    }).catch(() => {});
  }
  const res = await dialog({
    title: t('print.title', { name: label.name || t('print.untitled') }), body, wide: true,
    buttons: [{ label: t('print.print'), value: null, primary: true, validate: () => { doPrint(closeFn); return false; } }, { label: t('common.close'), value: null }],
    onOpen: (box, close) => { closeFn = close; updatePreview(); },
  });
  // The chosen roll and rotation are kept in the label for next time
  const after = { mediaId: mediaSel.value === 'adhoc' ? undefined : mediaSel.value, printRotate: rotate.value, fitMode: fitSel.value, fill: fillSel.value };
  const same = after.mediaId === before.mediaId && after.printRotate === rotValue(before.printRotate)
    && after.fitMode === (before.fitMode || 'fit') && after.fill === (before.fill || 'seq');
  if (!same) {
    const now = clone(page);
    Object.assign(page, before);
    snapshot();
    Object.assign(page, now, after);
    changed('page');
  }
  return res;
}

let closeFn = () => {};
