// Roll types: labels as they pass through the printer (liner width, columns, label size, gaps)
import { S } from './state.js';
import { h, api, toast, dialog, confirmBox, uid, r2, clone, SVGNS, dims } from './util.js';
import { toMono, monoToBase64 } from './render.js';
import { loadPrinters, profileFor, pickDefaultPrinter } from './printers.js';
import { t, tRaw } from './i18n.js';

export const MEDIA_DEFAULT = {
  name: '', linerW: 100, cols: 1, labelW: 100, labelH: 50, colGap: 0, marginL: 0,
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
  for (const k of ['linerW', 'cols', 'labelW', 'labelH', 'colGap', 'marginL', 'rowGap', 'gapOffset', 'radius']) {
    out[k] = Number(out[k]) || 0;
  }
  out.cols = Math.max(1, Math.min(12, Math.round(out.cols)));
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

/** Column positions and the right margin */
export function layout(m) {
  const used = m.marginL + m.cols * m.labelW + (m.cols - 1) * m.colGap;
  const xs = Array.from({ length: m.cols }, (_, i) => m.marginL + i * (m.labelW + m.colGap) + (m.colOffsets[i] || 0));
  return { used, marginR: r2(m.linerW - used), xs };
}

export function problems(m, maxWidth = 108) {
  const out = [];
  const L = layout(m);
  if (L.marginR < -0.05) out.push(t('media.tooWide', { used: r2(L.used), width: m.linerW }));
  if (m.linerW > maxWidth + 0.05) out.push(t('media.overPrinter', { width: m.linerW, max: maxWidth }));
  if (m.labelW <= 0 || m.labelH <= 0) out.push(t('media.badSize'));
  return out;
}

/** A roll whose label size matches the design (directly or turned) */
export function matchMedia(page) {
  const eq = (a, b) => Math.abs(a - b) <= 0.6;
  const list = mediaList();
  const fits = (m) => (eq(m.labelW, page.w) && eq(m.labelH, page.h)) || (eq(m.labelW, page.h) && eq(m.labelH, page.w));
  const own = list.find((m) => m.id === page.mediaId);
  return own || list.find(fits) || null;
}

/** TSPL settings of a roll: SIZE = liner width × one row height */
export const tsplOf = (m) => ({ stockW: m.linerW, stockH: m.labelH, gap: m.rowGap, gapOffset: m.gapOffset, media: m.gapType });

// ---------------------------------------------------------------- diagram
function sv(tag, attrs, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

function dim(g, x1, y1, x2, y2, label, vertical = false) {
  const col = '#1f5fbf';
  g.append(sv('line', { x1, y1, x2, y2, stroke: col, 'stroke-width': 0.25, 'marker-start': 'url(#arr)', 'marker-end': 'url(#arr)' }));
  const tx = (x1 + x2) / 2, ty = (y1 + y2) / 2;
  const txt = sv('text', {
    x: vertical ? tx + 1.2 : tx, y: vertical ? ty : ty - 1, fill: col, 'font-size': 3.2, 'text-anchor': vertical ? 'start' : 'middle',
    'dominant-baseline': vertical ? 'middle' : 'auto', 'font-family': 'Tahoma',
  }, label);
  g.append(txt);
}

export function mediaDiagram(m) {
  const L = layout(m);
  const rows = 2;
  const pad = 14;
  const W = m.linerW + pad * 2 + 16;
  const H = rows * m.labelH + (rows - 1) * m.rowGap + pad * 2 + 10;
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'media-svg', direction: 'ltr' });
  const defs = sv('defs', {});
  const mk = sv('marker', { id: 'arr', viewBox: '0 0 6 6', refX: 3, refY: 3, markerWidth: 4, markerHeight: 4, orient: 'auto-start-reverse' });
  mk.append(sv('path', { d: 'M0,0 L6,3 L0,6 z', fill: '#1f5fbf' }));
  defs.append(mk);
  svg.append(defs);
  const ox = pad, oy = pad + 4;
  const rollH = rows * m.labelH + (rows - 1) * m.rowGap + 6;
  svg.append(sv('rect', { x: ox, y: oy - 3, width: m.linerW, height: rollH, fill: '#d9dee5', stroke: '#a9b3bf', 'stroke-width': 0.3 }));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < m.cols; c++) {
      const x = ox + L.xs[c], y = oy + r * (m.labelH + m.rowGap);
      svg.append(sv('rect', { x, y, width: m.labelW, height: m.labelH, rx: m.radius, fill: '#fff', stroke: '#7d8a99', 'stroke-width': 0.3 }));
      if (r === 0) svg.append(sv('text', { x: x + m.labelW / 2, y: y + m.labelH / 2, 'font-size': Math.min(9, m.labelH * 0.4), 'text-anchor': 'middle', 'dominant-baseline': 'middle', fill: '#9aa5b1', 'font-family': 'Tahoma' }, String(c + 1)));
    }
  }
  const g = sv('g', {});
  dim(g, ox, oy - 8, ox + m.linerW, oy - 8, `${m.linerW}`);
  const yb = oy + m.labelH + m.rowGap / 2;
  if (m.marginL > 0.05) dim(g, ox, yb + m.labelH * 0.55, ox + L.xs[0], yb + m.labelH * 0.55, `${m.marginL}`);
  dim(g, ox + L.xs[0], yb + m.labelH * 0.3, ox + L.xs[0] + m.labelW, yb + m.labelH * 0.3, `${m.labelW}`);
  if (m.cols > 1 && m.colGap > 0.05) dim(g, ox + L.xs[0] + m.labelW, yb + m.labelH * 0.55, ox + L.xs[1], yb + m.labelH * 0.55, `${m.colGap}`);
  if (Math.abs(L.marginR) > 0.05) {
    const lastEnd = ox + L.xs[m.cols - 1] + m.labelW;
    dim(g, lastEnd, yb + m.labelH * 0.8, ox + m.linerW, yb + m.labelH * 0.8, `${L.marginR}`);
  }
  const xr = ox + m.linerW + 3;
  dim(g, xr, oy, xr, oy + m.labelH, `${m.labelH}`, true);
  if (m.rowGap > 0.05) dim(g, xr, oy + m.labelH, xr, oy + m.labelH + m.rowGap, `${m.rowGap}`, true);
  svg.append(g);
  // Paper feed direction
  svg.append(sv('line', { x1: 5, y1: oy, x2: 5, y2: oy + Math.min(rollH, 40), stroke: '#6b7684', 'stroke-width': 0.4, 'marker-end': 'url(#arr)' }));
  return svg;
}

// ---------------------------------------------------------------- layout test print
export function layoutTestCanvas(m, dpi, prof = {}) {
  const dpmm = dpi / 25.4;
  const L = layout(m);
  const c = document.createElement('canvas');
  c.width = Math.round(m.linerW * dpmm);
  c.height = Math.round(m.labelH * dpmm);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000';
  g.strokeStyle = '#000';
  g.lineWidth = Math.max(2, 0.35 * dpmm);
  for (let i = 0; i < m.cols; i++) {
    const x = (L.xs[i] + (prof.offX || 0)) * dpmm, y = (prof.offY || 0) * dpmm;
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
    g.fillText(String(i + 1), x + w / 2, y + hh / 2 + big * 0.05);
    const small = Math.max(10, Math.min(hh * 0.12, 3 * dpmm));
    g.font = `${small}px Tahoma`;
    g.fillText('▲ ' + t('media.testTop'), x + w / 2, y + 6 * dpmm + small / 2);
    g.fillText(`${m.labelW}×${m.labelH}`, x + w / 2, y + hh - 4.5 * dpmm - small / 2);
  }
  return c;
}

// ---------------------------------------------------------------- "Rolls" dialog
/** onDone(selectedId) after saving */
export async function openMediaManager(selectId, onDone) {
  let list = mediaList();
  let cur = list.find((m) => m.id === selectId) || list[0];
  const printersInfo = await loadPrinters();
  const listBox = h('div', { class: 'media-list' });
  const form = h('div', { class: 'media-form' });
  const diagram = h('div', { class: 'media-diagram' });
  const warn = h('div', { class: 'media-warn' });
  let prof = profileFor(pickDefaultPrinter(printersInfo));

  const drawList = () => {
    listBox.replaceChildren(...list.map((m) => h('button', {
      class: 'media-item' + (m === cur ? ' on' : ''), onclick: () => { cur = m; drawAll(); },
    }, h('b', {}, m.name), h('span', { class: 'muted' }, `${m.cols > 1 ? t('page.cols', { n: m.cols }) + ' · ' : ''}${dims(m.labelW, m.labelH)}`))));
  };
  const drawDiagram = () => {
    diagram.replaceChildren(mediaDiagram(cur));
    const L = layout(cur);
    const pr = problems(cur, prof.maxWidth || 108);
    warn.replaceChildren(
      h('div', { class: 'muted' }, t('media.marginRight', { n: L.marginR })),
      ...pr.map((p) => h('div', { class: 'err-text' }, p)));
  };
  const num = (key, label, opts = {}) => {
    const inp = h('input', { class: 'inp num', type: 'number', step: opts.step || 0.5, value: cur[key], min: opts.min ?? 0 });
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      if (Number.isNaN(v)) return;
      cur[key] = v;
      if (key === 'cols') { Object.assign(cur, normMedia(cur)); drawForm(); }
      drawDiagram();
      drawList();
    });
    return h('label', { class: 'field' }, h('span', {}, label), h('span', { class: 'num-wrap' }, inp, h('em', {}, opts.unit ?? 'mm')));
  };
  const drawForm = () => {
    const name = h('input', { class: 'inp', value: cur.name });
    name.addEventListener('input', () => { cur.name = name.value; drawList(); });
    const type = h('select', { class: 'inp' }, ...gapTypes().map(([v, l]) => h('option', { value: v, selected: cur.gapType === v }, l)));
    type.addEventListener('change', () => { cur.gapType = type.value; });
    const offs = cur.cols > 1 ? h('div', { class: 'media-offs' }, h('span', { class: 'muted' }, t('media.colOffsets')),
      ...cur.colOffsets.map((v, i) => {
        const inp = h('input', { class: 'inp num', type: 'number', step: 0.1, value: v, title: t('media.col', { n: i + 1 }) });
        inp.addEventListener('input', () => { cur.colOffsets[i] = parseFloat(inp.value) || 0; drawDiagram(); });
        return h('label', { class: 'field' }, h('span', {}, t('media.col', { n: i + 1 })), inp);
      })) : null;
    form.replaceChildren(
      h('label', { class: 'field' }, h('span', {}, t('media.name')), name),
      h('div', { class: 'prow' }, num('linerW', t('media.linerW')), num('cols', t('media.cols'), { step: 1, min: 1, unit: '×' })),
      h('div', { class: 'prow' }, num('labelW', t('media.labelW')), num('labelH', t('media.labelH'))),
      h('div', { class: 'prow' }, num('marginL', t('media.marginL')), num('colGap', t('media.colGap'))),
      h('div', { class: 'prow' }, num('rowGap', t('media.rowGap')), h('label', { class: 'field' }, h('span', {}, t('media.gapType')), type)),
      h('div', { class: 'prow' }, num('radius', t('media.radius')), h('button', {
        class: 'btn btn-ghost', onclick: () => {
          const used = cur.cols * cur.labelW + (cur.cols - 1) * cur.colGap;
          cur.marginL = r2((cur.linerW - used) / 2);
          drawForm();
          drawDiagram();
        },
      }, t('media.center'))),
      offs);
  };
  const drawAll = () => { drawList(); drawForm(); drawDiagram(); };

  // Printer tools
  const printerSel = h('select', { class: 'inp' }, ...printersInfo.printers.map((p) => h('option', { value: p.name, selected: p.name === prof.printer }, p.name)));
  const method = h('select', { class: 'inp' }, h('option', { value: 'tspl' }, t('print.methodTspl')), h('option', { value: 'network' }, t('print.methodNetwork')), h('option', { value: 'driver' }, t('print.methodDriver')));
  method.value = prof.method;
  printerSel.addEventListener('change', () => { prof = profileFor(printerSel.value); method.value = prof.method; drawDiagram(); });
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

  const add = (base) => {
    const m = normMedia({ ...(base ? clone(base) : MEDIA_DEFAULT), id: uid(), name: base ? `${base.name}${t('media.copySuffix')}` : t('media.newRoll') });
    list.push(m);
    cur = m;
    drawAll();
  };
  drawAll();
  const res = await dialog({
    title: t('media.title'), wide: true,
    body: h('div', { class: 'media-dlg' },
      h('div', { class: 'media-side' }, listBox,
        h('div', { class: 'btn-row wrap' },
          h('button', { class: 'chip', onclick: () => add(null) }, '+ ' + t('media.newRoll')),
          h('button', { class: 'chip', onclick: () => add(cur) }, t('common.copy')),
          h('button', {
            class: 'chip danger', onclick: async () => {
              if (list.length < 2) return;
              if (!(await confirmBox(t('media.deleteTitle'), t('media.deleteText', { name: cur.name }), t('common.delete'), true))) return;
              list = list.filter((m) => m !== cur);
              cur = list[0];
              drawAll();
            },
          }, t('common.delete')))),
      h('div', { class: 'media-main' }, form, diagram, warn, tools)),
    buttons: [{ label: t('common.save'), value: true, primary: true }, { label: t('common.cancel'), value: false }],
  });
  if (!res) return null;
  await saveMediaList(list);
  toast(t('media.saved'), 'ok', 1500);
  if (onDone) onDone(cur.id);
  return cur.id;
}
