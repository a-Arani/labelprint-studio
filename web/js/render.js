// Build the label DOM (for the editor and for printing) and render it to an image at the printer's dpi
import { PXMM, PTMM, SVGNS, cssFont, substitute, substituteHtml, bytesToBase64, emptyByVars, previewValues } from './util.js';
import { t } from './i18n.js';
import { isEdited, isMono, cached, request, processFor } from './imagefx.js';

const px = (mm) => `${(mm * PXMM).toFixed(3)}px`;

export function lineBox(e) {
  const pad = Math.max(e.strokeW || 0.3, 0.3) / 2 + 0.5;
  const x = Math.min(e.x1, e.x2) - pad, y = Math.min(e.y1, e.y2) - pad;
  return { x, y, w: Math.abs(e.x2 - e.x1) + pad * 2, h: Math.abs(e.y2 - e.y1) + pad * 2, pad };
}

// Axis-aligned bounding box (rotation included)
export function bbox(e) {
  if (e.type === 'line') {
    return { x: Math.min(e.x1, e.x2), y: Math.min(e.y1, e.y2), w: Math.abs(e.x2 - e.x1), h: Math.abs(e.y2 - e.y1) };
  }
  const rot = ((e.rot || 0) % 360 + 360) % 360;
  if (!rot) return { x: e.x, y: e.y, w: e.w, h: e.h };
  const a = (rot * Math.PI) / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const w = e.w * c + e.h * s, h = e.w * s + e.h * c;
  return { x: e.x + e.w / 2 - w / 2, y: e.y + e.h / 2 - h / 2, w, h };
}

function dashArray(dash, sw) {
  if (!dash) return null;
  const d = String(dash);
  if (d.includes('dot') && !d.includes('Dash') && !d.includes('dash')) return `${sw} ${sw * 1.5}`;
  if (d.toLowerCase().includes('dashdot')) return `${sw * 4} ${sw * 2} ${sw} ${sw * 2}`;
  return `${sw * 4} ${sw * 2.5}`;
}

function svgEl(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, v);
  return n;
}

function shapePath(kind, w, h, i) {
  // i = half the stroke width, so the outline stays inside the box
  const l = i, t = i, r = w - i, b = h - i, cx = w / 2, cy = h / 2;
  switch (kind) {
    case 'triangle': return `M${cx},${t} L${r},${b} L${l},${b} Z`;
    case 'rtTriangle': return `M${l},${t} L${r},${b} L${l},${b} Z`;
    case 'diamond': return `M${cx},${t} L${r},${cy} L${cx},${b} L${l},${cy} Z`;
    case 'hexagon': {
      const q = (r - l) * 0.25;
      return `M${l + q},${t} L${r - q},${t} L${r},${cy} L${r - q},${b} L${l + q},${b} L${l},${cy} Z`;
    }
    case 'octagon': {
      const q = Math.min(r - l, b - t) * 0.29;
      return `M${l + q},${t} L${r - q},${t} L${r},${t + q} L${r},${b - q} L${r - q},${b} L${l + q},${b} L${l},${b - q} L${l},${t + q} Z`;
    }
    default: return null;
  }
}

// ---------------------------------------------------------------- barcode and QR
const barcodeCache = new Map();

export function barcodeModules(format, value) {
  const key = format + '|' + value;
  if (barcodeCache.has(key)) return barcodeCache.get(key);
  let res;
  try {
    const svg = document.createElementNS(SVGNS, 'svg');
    window.JsBarcode(svg, value, { format, width: 1, height: 10, margin: 0, displayValue: false, flat: true });
    // JsBarcode emits one <g> per section, each with its own offset
    const bars = [];
    svg.querySelectorAll('g').forEach((g) => {
      const m = /translate\(([-\d.]+)/.exec(g.getAttribute('transform') || '');
      const dx = m ? parseFloat(m[1]) : 0;
      g.querySelectorAll('rect').forEach((r) => bars.push([dx + parseFloat(r.getAttribute('x')), parseFloat(r.getAttribute('width'))]));
    });
    res = { total: parseFloat(svg.getAttribute('width')), bars };
  } catch (e) {
    res = { error: typeof e === 'string' ? e : (e && e.message) || 'invalid' };
  }
  if (barcodeCache.size > 500) barcodeCache.clear();
  barcodeCache.set(key, res);
  return res;
}

function utf8Binary(s) {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

export function qrMatrix(value, ecc = 'M') {
  const qr = window.qrcode(0, ecc);
  qr.addData(utf8Binary(value || ' '), 'Byte');
  qr.make();
  return qr;
}

function errorBox(msg, mode) {
  const d = document.createElement('div');
  d.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;'
    + 'font:9pt Tahoma;color:#c00;border:1px dashed #c00;text-align:center;overflow:hidden';
  if (mode === 'edit') d.textContent = msg;
  return d;
}

function renderBarcode(e, wrap, value, ctx) {
  const mod = barcodeModules(e.format || 'CODE128', value || ' ');
  if (mod.error) {
    ctx.errors.push(t('render.barcodeInvalid', { value, format: e.format }));
    wrap.append(errorBox(t('render.barcodeInvalidShort'), ctx.mode));
    return;
  }
  const textH = e.showText ? (e.textSize || 8) * PTMM * 1.3 : 0;
  const barsH = Math.max(1, e.h - textH);
  const dpmm = ctx.dpmm;
  let m = e.w / mod.total;
  if (dpmm) m = Math.max(1, Math.floor((e.w * dpmm) / mod.total)) / dpmm;
  let off = (e.w - mod.total * m) / 2;
  if (dpmm) off = Math.round(off * dpmm) / dpmm;
  const svg = svgEl('svg', {
    width: px(e.w), height: px(barsH), viewBox: `0 0 ${e.w} ${barsH}`, preserveAspectRatio: 'none',
    'shape-rendering': 'crispEdges', style: 'position:absolute;left:0;top:0;overflow:visible',
  });
  let d = '';
  for (const [bx, bw] of mod.bars) d += `M${(off + bx * m).toFixed(4)},0h${(bw * m).toFixed(4)}v${barsH}h${(-bw * m).toFixed(4)}z`;
  svg.append(svgEl('path', { d, fill: e.color || '#000' }));
  wrap.append(svg);
  if (e.showText) {
    const t = document.createElement('div');
    t.textContent = value;
    t.style.cssText = `position:absolute;left:0;right:0;top:${px(barsH)};height:${px(textH)};text-align:center;`
      + `font-family:${cssFont(e.font || 'Arial')};font-size:${e.textSize || 8}pt;line-height:${px(textH)};`
      + `color:${e.color || '#000'};white-space:nowrap;overflow:visible;direction:ltr`;
    wrap.append(t);
  }
}

function renderQR(e, wrap, value, ctx) {
  let qr;
  try {
    qr = qrMatrix(value, e.ecc || 'M');
  } catch (err) {
    ctx.errors.push(t('render.qrTooLong'));
    wrap.append(errorBox(t('render.qrTooLongShort'), ctx.mode));
    return;
  }
  const n = qr.getModuleCount();
  const side = Math.min(e.w, e.h);
  const dpmm = ctx.dpmm;
  let m = side / n;
  if (dpmm) m = Math.max(1, Math.floor((side * dpmm) / n)) / dpmm;
  let ox = (e.w - n * m) / 2, oy = (e.h - n * m) / 2;
  if (dpmm) { ox = Math.round(ox * dpmm) / dpmm; oy = Math.round(oy * dpmm) / dpmm; }
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${(ox + c * m).toFixed(4)},${(oy + r * m).toFixed(4)}h${m.toFixed(4)}v${m.toFixed(4)}h${(-m).toFixed(4)}z`;
    }
  }
  const svg = svgEl('svg', {
    width: px(e.w), height: px(e.h), viewBox: `0 0 ${e.w} ${e.h}`, 'shape-rendering': 'crispEdges',
    style: 'position:absolute;left:0;top:0',
  });
  svg.append(svgEl('path', { d, fill: e.color || '#000' }));
  wrap.append(svg);
}

// ---------------------------------------------------------------- elements
function renderText(e, wrap, ctx) {
  const pad = e.pad || [1, 1, 1, 1];
  const box = document.createElement('div');
  box.className = 'tx-box';
  const sw = e.stroke && e.strokeW ? e.strokeW : 0;
  box.style.cssText = `position:absolute;left:0;top:0;width:${px(e.w)};height:${px(e.h)};box-sizing:border-box;`
    + `display:flex;flex-direction:column;justify-content:${{ top: 'flex-start', middle: 'center', bottom: 'flex-end' }[e.valign || 'top']};`
    + `padding:${px(pad[0])} ${px(pad[1])} ${px(pad[2])} ${px(pad[3])};`
    + (e.fill ? `background:${e.fill};` : '')
    + (sw ? `border:${px(sw)} ${e.dash ? 'dashed' : 'solid'} ${e.stroke};` : '')
    + (e.radius ? `border-radius:${px(e.radius)};` : '');
  const tx = document.createElement('div');
  tx.className = 'tx';
  tx.dir = e.dir || 'auto';
  tx.style.cssText = `font-family:${cssFont(e.font)};font-size:${e.size || 12}pt;color:${e.color || '#000'};`
    + `font-weight:${e.bold ? 700 : 400};font-style:${e.italic ? 'italic' : 'normal'};`
    + `text-decoration:${e.underline ? 'underline' : 'none'};text-align:${e.align || 'right'};`
    + `line-height:${e.lineHeight ? e.lineHeight : 'normal'};letter-spacing:${e.letterSpacing || 0}pt;`
    + `white-space:${e.wrap === false ? 'pre' : 'pre-wrap'};overflow-wrap:break-word;tab-size:4;outline:none;`
    + 'min-width:1px;min-height:1em';
  tx.innerHTML = ctx.values && !ctx.raw ? substituteHtml(e.html || '', ctx.values) : (e.html || '');
  box.append(tx);
  wrap.append(box);
  if (e.fit) ctx.fits.push([e, box, tx]);
}

function renderShape(e, wrap) {
  const sw = e.stroke ? (e.strokeW || 0.3) : 0;
  const svg = svgEl('svg', {
    width: px(e.w), height: px(e.h), viewBox: `0 0 ${e.w} ${e.h}`, preserveAspectRatio: 'none',
    style: 'position:absolute;left:0;top:0;overflow:visible'
      + (e.flipH || e.flipV ? `;transform:scale(${e.flipH ? -1 : 1},${e.flipV ? -1 : 1})` : ''),
  });
  const common = {
    fill: e.fill || 'none', stroke: e.stroke || 'none', 'stroke-width': sw || null,
    'stroke-dasharray': dashArray(e.dash, sw), 'stroke-linejoin': 'miter',
  };
  const i = sw / 2;
  let node;
  if (e.shape === 'ellipse') {
    node = svgEl('ellipse', { cx: e.w / 2, cy: e.h / 2, rx: Math.max(0, e.w / 2 - i), ry: Math.max(0, e.h / 2 - i), ...common });
  } else {
    const d = shapePath(e.shape, e.w, e.h, i);
    if (d) node = svgEl('path', { d, ...common });
    else {
      const rr = Math.max(0, Math.min(e.radius || 0, e.w / 2, e.h / 2));
      node = svgEl('rect', { x: i, y: i, width: Math.max(0, e.w - sw), height: Math.max(0, e.h - sw), rx: rr || null, ry: rr || null, ...common });
    }
  }
  svg.append(node);
  wrap.append(svg);
}

function renderImage(e, wrap, ctx) {
  const crop = e.crop || [0, 0, 0, 0];
  const fw = Math.max(0.01, 1 - crop[0] - crop[2]);
  const fh = Math.max(0.01, 1 - crop[1] - crop[3]);
  const edited = isEdited(e);
  // The processed copy already has the turns, mirroring and colour changes; until it is ready, CSS approximates them
  let src = ctx.imageSrc && ctx.imageSrc(e);
  if (!src && edited && ctx.mode === 'edit') {
    src = cached(e, ctx.dpmm);
    if (!src) request(e, ctx.dpmm);
  }
  const baked = !!src && edited;
  const img = document.createElement('img');
  img.src = src || e.src;
  img.draggable = false;
  let css = 'position:absolute;display:block;max-width:none;';
  if (e.fit === 'contain' || e.fit === 'cover') {
    css += `left:0;top:0;width:${px(e.w)};height:${px(e.h)};object-fit:${e.fit};`;
  } else {
    css += `left:${px((-crop[0] * e.w) / fw)};top:${px((-crop[1] * e.h) / fh)};width:${px(e.w / fw)};height:${px(e.h / fh)};`;
  }
  // Black-and-white dots must stay exact dots: no smoothing when the picture is scaled onto the label
  if (baked && isMono(e)) css += 'image-rendering:pixelated;';
  if (!baked) {
    const filters = [];
    if (e.invert) filters.push('invert(1)');
    if (e.gray) filters.push('grayscale(1)');
    if (filters.length) css += `filter:${filters.join(' ')};`;
    const tf = [];
    if (e.flipH) tf.push('scaleX(-1)');
    if (e.flipV) tf.push('scaleY(-1)');
    if (tf.length) css += `transform:${tf.join(' ')};`;
  }
  img.style.cssText = css;
  wrap.style.overflow = 'hidden';
  const corner = e.mask === 'circle' ? '50%' : (e.radius ? px(e.radius) : '');
  if (corner) wrap.style.borderRadius = corner;
  wrap.append(img);
  if (e.stroke && e.strokeW) {
    const b = document.createElement('div');
    b.style.cssText = `position:absolute;inset:0;border:${px(e.strokeW)} solid ${e.stroke};box-sizing:border-box;border-radius:${corner || 0}`;
    wrap.append(b);
  }
}

function renderLine(e, wrap) {
  const b = lineBox(e);
  const sw = Math.max(e.strokeW || 0.3, 0.05);
  const svg = svgEl('svg', {
    width: px(b.w), height: px(b.h), viewBox: `0 0 ${b.w} ${b.h}`,
    style: 'position:absolute;left:0;top:0;overflow:visible',
  });
  const pts = { x1: e.x1 - b.x, y1: e.y1 - b.y, x2: e.x2 - b.x, y2: e.y2 - b.y };
  svg.append(svgEl('line', {
    ...pts, stroke: e.stroke || '#000', 'stroke-width': sw, 'stroke-dasharray': dashArray(e.dash, sw),
    'stroke-linecap': e.cap || 'butt',
  }));
  if (wrap.dataset.mode === 'edit') {
    svg.append(svgEl('line', { ...pts, stroke: 'transparent', 'stroke-width': Math.max(sw, 3), class: 'hit' }));
  }
  wrap.append(svg);
}

function renderPath(e, wrap) {
  const vw = e.vw || e.w, vh = e.vh || e.h;
  const scale = e.w / vw || 1;
  const svg = svgEl('svg', {
    width: px(e.w), height: px(e.h), viewBox: `0 0 ${vw} ${vh}`, preserveAspectRatio: 'none',
    style: 'position:absolute;left:0;top:0;overflow:visible',
  });
  svg.append(svgEl('path', {
    d: e.d, fill: e.fill || 'none', stroke: e.stroke || '#000', 'stroke-width': (e.strokeW || 0.5) / scale,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': null,
  }));
  wrap.append(svg);
}

/**
 * Build one element. ctx: {mode, values, dpmm, errors, fits, imageSrc, raw}
 */
export function renderElement(e, ctx) {
  const wrap = document.createElement('div');
  wrap.dataset.id = e.id;
  wrap.dataset.type = e.type;
  wrap.dataset.mode = ctx.mode;
  let x = e.x, y = e.y, w = e.w, hh = e.h;
  if (e.type === 'line') ({ x, y, w, h: hh } = lineBox(e));
  wrap.style.cssText = `position:absolute;left:${px(x)};top:${px(y)};width:${px(w)};height:${px(hh)};`
    + (e.rot && e.type !== 'line' ? `transform:rotate(${e.rot}deg);` : '')
    + (e.opacity !== undefined && e.opacity < 1 ? `opacity:${e.opacity};` : '');
  const val = ctx.values ? substitute(e.value || '', ctx.values) : (e.value || '');
  switch (e.type) {
    case 'text': renderText(e, wrap, ctx); break;
    case 'shape': renderShape(e, wrap); break;
    case 'image': renderImage(e, wrap, ctx); break;
    case 'line': renderLine(e, wrap); break;
    case 'path': renderPath(e, wrap); break;
    case 'barcode': renderBarcode(e, wrap, val, ctx); break;
    case 'qr': renderQR(e, wrap, val, ctx); break;
    default: break;
  }
  return wrap;
}

export function makeRoot(label) {
  const root = document.createElement('div');
  root.className = 'label-root';
  root.style.cssText = `position:relative;width:${px(label.page.w)};height:${px(label.page.h)};`
    + `background:${label.page.bg || '#FFFFFF'};overflow:hidden;font-family:Tahoma, sans-serif;color:#000;`
    + 'direction:ltr;text-align:left;line-height:normal;-webkit-font-smoothing:antialiased';
  return root;
}

export function renderLabel(label, ctx) {
  ctx.errors = ctx.errors || [];
  ctx.fits = ctx.fits || [];
  const root = makeRoot(label);
  for (const e of label.elements) {
    if (e.hidden && ctx.mode !== 'edit') continue;
    // An element whose fields are all empty: skipped when printing, faded in the editor
    const empty = e.hideEmpty && ctx.values && emptyByVars(e, ctx.values);
    if (empty && ctx.mode !== 'edit') continue;
    const node = renderElement(e, ctx);
    if (empty) {
      node.style.opacity = '0.25';
      node.dataset.empty = '1';
    }
    root.append(node);
  }
  return root;
}

// Shrink text until it fits its box (after it is attached to the page)
export function applyFits(fits) {
  for (const [e, box, tx] of fits) {
    tx.style.zoom = '1';
    const pad = e.pad || [1, 1, 1, 1];
    const br = box.getBoundingClientRect();
    if (!br.height) continue;
    const k = br.height / (e.h * PXMM);
    const maxH = (e.h - pad[0] - pad[2]) * PXMM * k;
    const maxW = (e.w - pad[1] - pad[3]) * PXMM * k;
    const fits = () => {
      const r = tx.getBoundingClientRect();
      return r.height <= maxH + 0.5 && (e.wrap !== false || tx.scrollWidth * k * parseFloat(tx.style.zoom) <= maxW + 0.5);
    };
    if (fits()) continue;
    let lo = 0.1, hi = 1;
    for (let i = 0; i < 9; i++) {
      const mid = (lo + hi) / 2;
      tx.style.zoom = String(mid);
      if (fits()) lo = mid; else hi = mid;
    }
    tx.style.zoom = String(lo.toFixed(3));
  }
}

// ---------------------------------------------------------------- rendering to an image
let host;
function offscreen() {
  if (!host) {
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-30000px;top:0;pointer-events:none;contain:layout';
    document.body.append(host);
  }
  return host;
}

/**
 * Render a label to a canvas at the given dpi.
 * opt: {dpi, rotate (0/90/180/270), offX, offY (mm), values}
 */
export async function rasterize(label, opt = {}) {
  const dpi = opt.dpi || 203;
  const dpmm = dpi / 25.4;
  const errors = [];
  // Edited pictures are processed at exactly the printer's dots, so the print matches the editor
  const processed = new Map();
  for (const e of label.elements) {
    if (e.type === 'image' && !e.hidden && e.src && isEdited(e)) {
      try { processed.set(e.id, await processFor(e, dpmm)); } catch (err) { /* shown as the original picture */ }
    }
  }
  const ctx = {
    mode: 'print', values: opt.values || null, dpmm, errors, fits: [],
    imageSrc: (e) => processed.get(e.id),
  };
  const root = renderLabel(label, ctx);
  const hostEl = offscreen();
  hostEl.append(root);
  applyFits(ctx.fits);
  const xml = new XMLSerializer().serializeToString(root);
  root.remove();
  const W = Math.max(1, Math.round(label.page.w * dpmm));
  const H = Math.max(1, Math.round(label.page.h * dpmm));
  const k = dpmm / PXMM;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
    + `<foreignObject x="0" y="0" width="${W}" height="${H}">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="transform:scale(${k});transform-origin:0 0;width:${label.page.w * PXMM}px;height:${label.page.h * PXMM}px">`
    + `${xml}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const rot = ((opt.rotate || 0) % 360 + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const c = document.createElement('canvas');
  c.width = swap ? H : W;
  c.height = swap ? W : H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.save();
  g.translate(Math.round((opt.offX || 0) * dpmm), Math.round((opt.offY || 0) * dpmm));
  if (rot === 90) { g.translate(c.width, 0); g.rotate(Math.PI / 2); }
  if (rot === 180) { g.translate(c.width, c.height); g.rotate(Math.PI); }
  if (rot === 270) { g.translate(0, c.height); g.rotate(-Math.PI / 2); }
  g.drawImage(img, 0, 0, W, H);
  g.restore();
  c.errors = errors;
  return c;
}

// canvas -> 1-bit data (1 = black)
export function toMono(canvas, threshold = 140) {
  const w = canvas.width, hh = canvas.height;
  const d = canvas.getContext('2d').getImageData(0, 0, w, hh).data;
  const wb = (w + 7) >> 3;
  const bits = new Uint8Array(wb * hh);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (l < threshold) bits[y * wb + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { w, h: hh, wb, bits };
}

export function monoToCanvas(m) {
  const c = document.createElement('canvas');
  c.width = m.w;
  c.height = m.h;
  const g = c.getContext('2d');
  const img = g.createImageData(m.w, m.h);
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const on = m.bits[y * m.wb + (x >> 3)] & (0x80 >> (x & 7));
      const i = (y * m.w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = on ? 0 : 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

export const monoToBase64 = (m) => bytesToBase64(m.bits);

export async function thumbnail(label, maxSide = 260) {
  const dpi = (maxSide / Math.max(label.page.w, label.page.h)) * 25.4;
  try {
    const c = await rasterize(label, { dpi, mono: false, values: previewValues(label) });
    return c.toDataURL('image/png');
  } catch (e) {
    return null;
  }
}
