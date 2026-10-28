// Editing canvas: label display, selection, move/resize/rotate, creating elements and in-place text editing
import { S, emit, on, snapshot, changed, select, byId, selected, dropLastSnapshot } from './state.js';
import { PXMM, uid, clamp, r2, h, clone, previewValues } from './util.js';
import { renderElement, renderLabel, applyFits, bbox } from './render.js';
import { mediaById, perPrint, layout as rollLayout, gridOf, cellOrigin, isEach, showRow } from './media.js';
import { t } from './i18n.js';
import { onReady } from './imagefx.js';

const HANDLES = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };

export function defaultsFor(kind) {
  const d = {
    text: {
      type: 'text', html: '', font: S.lastFont || 'Tahoma', size: 14, color: '#000000', bold: false, italic: false,
      underline: false, align: 'center', dir: 'auto', valign: 'middle', lineHeight: 0, letterSpacing: 0,
      pad: [0.5, 0.5, 0.5, 0.5], wrap: true, fit: false, fill: null, stroke: null, strokeW: 0.3, radius: 0,
    },
    rect: { type: 'shape', shape: 'rect', fill: null, stroke: '#000000', strokeW: 0.4, radius: 0, dash: null },
    ellipse: { type: 'shape', shape: 'ellipse', fill: null, stroke: '#000000', strokeW: 0.4, radius: 0, dash: null },
    line: { type: 'line', stroke: '#000000', strokeW: 0.5, dash: null },
    barcode: { type: 'barcode', format: 'CODE128', value: '123456789', showText: true, textSize: 8, font: 'Arial', color: '#000000' },
    qr: { type: 'qr', value: '12345678', ecc: 'M', color: '#000000' },
  };
  return clone(d[kind]);
}

const DEFAULT_SIZE = { text: [40, 10], rect: [20, 12], ellipse: [15, 15], barcode: [45, 16], qr: [18, 18] };

export function textOf(html) {
  const t = document.createElement('template');
  t.innerHTML = html || '';
  return t.content.textContent || '';
}

export class Editor {
  constructor(ws) {
    this.ws = ws;
    this.stage = h('div', { class: 'stage' });
    // Behind the label: the roll with the other labels of a print; above it: where each label of a whole-print design is
    this.rowView = h('div', { class: 'row-view', hidden: true });
    this.holder = h('div', { class: 'paper-holder' });
    this.guides = h('div', { class: 'cell-guides', hidden: true });
    this.overlay = h('div', { class: 'overlay' });
    this.temp = null;
    this.stage.append(this.rowView, this.holder, this.guides, this.overlay);
    ws.append(this.stage);
    this.drag = null;
    this.clip = [];
    this.pasteN = 0;
    ws.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    ws.addEventListener('dblclick', (e) => this.onDbl(e));
    ws.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(S.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e);
    }, { passive: false });
    new ResizeObserver(() => this.layout()).observe(ws);
    on('change', (what) => { if (what !== 'text') this.render(); });
    on('selection', () => this.drawOverlay());
    // An edited picture is processed in the background; show it when it is ready
    onReady((id) => { if (S.doc && byId(id)) this.renderEls([id]); });
  }

  dpmm() { return (S.settings.editDpi || 203) / 25.4; }
  k() { return S.zoom * PXMM; }

  ctx(raw) {
    return { mode: 'edit', values: S.preview ? previewValues(S.doc) : null, dpmm: this.dpmm(), errors: [], fits: [], raw };
  }

  // ------------------------------------------------------------ display
  render() {
    if (S.editingId && !this.holder.contains(this.txNode(S.editingId))) S.editingId = null;
    if (S.editingId) return this.drawOverlay();
    if (!S.doc) {
      this.holder.replaceChildren();
      this.overlay.replaceChildren();
      return;
    }
    const ctx = this.ctx();
    const root = renderLabel(S.doc, ctx);
    root.classList.add('is-edit');
    root.style.transform = `scale(${S.zoom})`;
    root.style.transformOrigin = '0 0';
    this.holder.replaceChildren(root);
    this.paper = root;
    this.layout();
    applyFits(ctx.fits);
    this.drawOverlay();
    emit('rendered', ctx.errors);
  }

  renderEls(ids, raw = false) {
    if (!this.paper) return;
    const ctx = this.ctx(raw);
    for (const id of ids) {
      const e = byId(id);
      const old = this.paper.querySelector(`:scope > [data-id="${id}"]`);
      if (!e || !old) continue;
      old.replaceWith(renderElement(e, ctx));
    }
    applyFits(ctx.fits);
    this.queueCopies();
  }

  /** What is shown around the label: the roll with copies of the label (same design on every label of a print),
   * the labels of a whole-print design, or nothing */
  rollView() {
    const p = S.doc.page, m = mediaById(p.mediaId);
    if (!m || perPrint(m) < 2) return null;
    if (isEach(p, m)) return { each: true, m, g: p.grid || gridOf(m) };
    // Copies only while the design stands on the roll as it is, not turned
    if (!showRow() || Math.abs(p.w - m.labelW) > 0.6 || Math.abs(p.h - m.labelH) > 0.6) return null;
    return { each: false, m, L: rollLayout(m) };
  }

  /** The area to show, in mm: the label, or the roll width around it (with a little backing paper above and below) */
  viewSize() {
    const rv = S.doc && this.rollView();
    if (rv && !rv.each) return { w: rv.m.linerW, h: rv.L.pageH + 8 };
    return { w: S.doc.page.w, h: S.doc.page.h };
  }

  layout() {
    if (!S.doc) return;
    const k = this.k();
    const pw = S.doc.page.w * k, ph = S.doc.page.h * k;
    const rv = this.rollView();
    const view = this.viewSize();
    const bw = view.w * k, bh = view.h * k;
    const m = 70;
    const sw = Math.max(this.ws.clientWidth, bw + 2 * m), sh = Math.max(this.ws.clientHeight, bh + 2 * m);
    this.stage.style.width = sw + 'px';
    this.stage.style.height = sh + 'px';
    const bl = (sw - bw) / 2, bt = (sh - bh) / 2;
    // The label sits where it is on the roll
    const left = rv && !rv.each ? bl + rv.L.xs[0] * k : bl, top = rv && !rv.each ? bt + 4 * k : bt;
    for (const n of [this.holder, this.guides, this.overlay]) {
      Object.assign(n.style, { left: left + 'px', top: top + 'px', width: pw + 'px', height: ph + 'px' });
    }
    // Rounded label corners, from the roll type (a whole-print design shows them on each label instead)
    const media = mediaById(S.doc.page.mediaId);
    this.holder.style.borderRadius = media && media.radius && !(rv && rv.each) ? `${media.radius * k}px` : '';
    this.rowView.hidden = !(rv && !rv.each);
    if (!this.rowView.hidden) Object.assign(this.rowView.style, { left: bl + 'px', top: bt + 'px', width: bw + 'px', height: bh + 'px' });
    this.drawGuides(rv && rv.each ? rv : null);
    this.queueCopies();
  }

  /** A whole-print design: the gaps between labels (not printed), each label's outline and number */
  drawGuides(rv) {
    this.guides.hidden = !rv;
    if (!rv) { this.guides.replaceChildren(); return; }
    const k = this.k(), { g, m } = rv;
    const out = [];
    const box = (cls, x, y, w, hh, extra = {}) => h('div', { class: cls, style: { left: x * k + 'px', top: y * k + 'px', width: w * k + 'px', height: hh * k + 'px', ...extra } });
    for (let c = 1; c < g.cols; c++) out.push(box('cg-gap', c * (g.w + g.gx) - g.gx, 0, g.gx, S.doc.page.h));
    for (let r = 1; r < g.rows; r++) out.push(box('cg-gap', 0, r * (g.h + g.gy) - g.gy, S.doc.page.w, g.gy));
    for (let i = 0; i < g.cols * g.rows; i++) {
      const o = cellOrigin(g, i);
      const cell = box('cg-cell', o.x, o.y, g.w, g.h, { borderRadius: m.radius ? `${m.radius * k}px` : '' });
      cell.append(h('span', { class: 'cg-num' }, String(i + 1)));
      out.push(cell);
    }
    this.guides.replaceChildren(...out);
  }

  /** The other labels of a print, as live copies of the one being designed (redrawn once per frame) */
  queueCopies() {
    if (this.copiesQueued) return;
    this.copiesQueued = true;
    requestAnimationFrame(() => {
      this.copiesQueued = false;
      const rv = S.doc && this.paper && !this.rowView.hidden ? this.rollView() : null;
      if (!rv || rv.each) { this.rowView.replaceChildren(); return; }
      const k = this.k(), { m, L } = rv;
      const out = [];
      for (let i = 0; i < perPrint(m); i++) {
        const x = L.xs[i % m.cols] * k, y = (4 + L.ys[Math.floor(i / m.cols)]) * k;
        // Label 1 is the one being designed (in front); the others show the same design
        if (i) {
          out.push(h('div', {
            class: 'row-copy', style: { left: x + 'px', top: y + 'px', width: m.labelW * k + 'px', height: m.labelH * k + 'px', borderRadius: m.radius ? `${m.radius * k}px` : '' },
          }, this.paper.cloneNode(true)));
        }
        out.push(h('span', { class: 'row-num', style: { left: x + 'px', top: y - 18 + 'px' } }, String(i + 1)));
      }
      this.rowView.replaceChildren(...out);
    });
  }

  setZoom(z, ev) {
    if (!S.doc) return;
    z = clamp(z, 0.2, 12);
    let anchor = null;
    if (ev) {
      const r = this.ws.getBoundingClientRect();
      anchor = { cx: ev.clientX - r.left, cy: ev.clientY - r.top, mm: this.toMM(ev) };
    }
    S.zoom = z;
    if (this.paper) this.paper.style.transform = `scale(${z})`;
    this.layout();
    this.drawOverlay();
    if (anchor) {
      const k = this.k();
      this.ws.scrollLeft = this.holder.offsetLeft + anchor.mm.x * k - anchor.cx;
      this.ws.scrollTop = this.holder.offsetTop + anchor.mm.y * k - anchor.cy;
    }
    emit('zoom');
  }

  fit() {
    if (!S.doc) return;
    const view = this.viewSize();
    const zw = (this.ws.clientWidth - 100) / (view.w * PXMM);
    const zh = (this.ws.clientHeight - 100) / (view.h * PXMM);
    this.setZoom(Math.max(0.2, Math.min(zw, zh, 8)));
    this.ws.scrollLeft = (this.stage.offsetWidth - this.ws.clientWidth) / 2;
    this.ws.scrollTop = (this.stage.offsetHeight - this.ws.clientHeight) / 2;
  }

  toMM(ev) {
    const r = this.holder.getBoundingClientRect();
    const k = this.k();
    return { x: (ev.clientX - r.left) / k, y: (ev.clientY - r.top) / k };
  }

  txNode(id) {
    return this.paper && this.paper.querySelector(`:scope > [data-id="${id}"] .tx`);
  }

  // ------------------------------------------------------------ selection overlay
  drawOverlay(guides = []) {
    const ov = this.overlay;
    const keep = this.temp;
    ov.replaceChildren();
    if (!S.doc) return;
    const k = this.k();
    if (S.grid.show) {
      const g = S.grid.size * k;
      if (g >= 4) {
        ov.append(h('div', {
          class: 'grid', style: {
            backgroundSize: `${g}px ${g}px`,
            backgroundImage: 'linear-gradient(to right, rgba(0,90,200,.13) 1px, transparent 1px),'
              + 'linear-gradient(to bottom, rgba(0,90,200,.13) 1px, transparent 1px)',
          },
        }));
      }
    }
    // 1 mm safe margin; anything outside it may end up on the label edge
    ov.append(h('div', { class: 'safe-area', style: { inset: `${k}px` } }));
    const sel = selected();
    const single = sel.length === 1 ? sel[0] : null;
    for (const e of sel) {
      if (e.type === 'line') {
        const ln = h('div', { class: 'sel-line' });
        const dx = (e.x2 - e.x1) * k, dy = (e.y2 - e.y1) * k;
        Object.assign(ln.style, {
          left: e.x1 * k + 'px', top: e.y1 * k + 'px', width: Math.hypot(dx, dy) + 'px',
          transform: `rotate(${Math.atan2(dy, dx)}rad)`,
        });
        ov.append(ln);
        if (single && !e.locked) {
          for (const [hname, x, y] of [['p1', e.x1, e.y1], ['p2', e.x2, e.y2]]) {
            ov.append(h('div', { class: 'hd hd-pt', 'data-h': hname, style: { left: x * k + 'px', top: y * k + 'px' } }));
          }
        }
        continue;
      }
      const box = h('div', { class: 'sel-box' + (e.locked ? ' locked' : '') + (S.editingId === e.id ? ' editing' : '') });
      Object.assign(box.style, {
        left: e.x * k + 'px', top: e.y * k + 'px', width: e.w * k + 'px', height: e.h * k + 'px',
        transform: e.rot ? `rotate(${e.rot}deg)` : '',
      });
      if (single && !e.locked && S.editingId !== e.id) {
        for (const hn of Object.keys(HANDLES)) box.append(h('div', { class: `hd hd-${hn}`, 'data-h': hn }));
        box.append(h('div', { class: 'hd-stem' }), h('div', { class: 'hd hd-rot', 'data-h': 'rot', title: t('editor.rotate') }));
      }
      ov.append(box);
    }
    if (sel.length > 1) {
      const b = this.groupBox(sel);
      ov.append(h('div', { class: 'sel-group', style: { left: b.x * k + 'px', top: b.y * k + 'px', width: b.w * k + 'px', height: b.h * k + 'px' } }));
    }
    for (const g of guides) {
      ov.append(h('div', {
        class: 'guide',
        style: g.x !== undefined
          ? { left: g.x * k + 'px', top: '-2000px', height: '6000px', width: '0' }
          : { top: g.y * k + 'px', left: '-2000px', width: '6000px', height: '0' },
      }));
    }
    if (keep) ov.append(keep);
  }

  groupBox(els) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const e of els) {
      const b = bbox(e);
      x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
      x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  setTemp(node) {
    if (this.temp) this.temp.remove();
    this.temp = node;
    if (node) this.overlay.append(node);
  }

  // ------------------------------------------------------------ pointer
  onDown(ev) {
    if (ev.button !== 0 || !S.doc) return;
    const act = document.activeElement;
    if (act && act !== document.body && !this.ws.contains(act)) act.blur();
    const p = this.toMM(ev);
    const hd = ev.target.closest('.hd');
    const node = ev.target.closest('.label-root > [data-id]');
    if (S.editingId) {
      if (node && node.dataset.id === S.editingId) return;
      this.endEdit();
    }
    if (hd) {
      const e = selected()[0];
      if (!e) return;
      this.drag = { kind: hd.dataset.h === 'rot' ? 'rotate' : (hd.dataset.h.startsWith('p') ? 'point' : 'resize'), h: hd.dataset.h, start: p, orig: clone(e), id: e.id, moved: false };
    } else if (S.tool !== 'select') {
      this.drag = { kind: S.tool === 'pen' ? 'pen' : 'create', tool: S.tool, start: p, pts: [p], moved: false };
    } else if (node) {
      const id = node.dataset.id;
      if (ev.shiftKey || ev.ctrlKey) {
        select(S.sel.includes(id) ? S.sel.filter((x) => x !== id) : [...S.sel, id]);
        return;
      }
      if (!S.sel.includes(id)) select([id]);
      const movable = selected().filter((e) => !e.locked);
      this.drag = { kind: 'move', start: p, orig: movable.map(clone), moved: false };
    } else {
      this.drag = { kind: 'marquee', start: p, base: ev.shiftKey ? [...S.sel] : [], moved: false };
    }
    ev.preventDefault();
  }

  onMove(ev) {
    const d = this.drag;
    if (!d) {
      if (S.doc && ev.target && this.ws.contains(ev.target)) emit('cursor', this.toMM(ev));
      return;
    }
    const p = this.toMM(ev);
    const k = this.k();
    if (!d.moved) {
      if (Math.hypot(p.x - d.start.x, p.y - d.start.y) * k < 3) return;
      d.moved = true;
      if (['move', 'resize', 'rotate', 'point'].includes(d.kind)) snapshot();
    }
    if (d.kind === 'move') this.dragMove(d, p, ev);
    else if (d.kind === 'resize') this.dragResize(d, p, ev);
    else if (d.kind === 'rotate') this.dragRotate(d, p, ev);
    else if (d.kind === 'point') this.dragPoint(d, p, ev);
    else if (d.kind === 'marquee') this.dragMarquee(d, p);
    else if (d.kind === 'create') this.dragCreate(d, p, ev);
    else if (d.kind === 'pen') this.dragPen(d, p);
    emit('cursor', p);
  }

  onUp(ev) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const p = this.toMM(ev);
    if (d.kind === 'marquee') {
      this.setTemp(null);
      if (!d.moved) { select(d.base); return; }
      const r = this.rectOf(d.start, p);
      const hits = S.doc.elements.filter((e) => {
        const b = bbox(e);
        return b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;
      }).map((e) => e.id);
      select([...d.base, ...hits]);
      return;
    }
    if (d.kind === 'create') return this.finishCreate(d, p, ev);
    if (d.kind === 'pen') return this.finishPen(d);
    if (d.moved) changed(d.kind);
    else this.drawOverlay();
  }

  onDbl(ev) {
    const node = ev.target.closest('.label-root > [data-id]');
    if (!node || S.tool !== 'select') return;
    const e = byId(node.dataset.id);
    if (!e) return;
    if (e.type === 'text') this.startEdit(e.id, ev);
    else if (e.type === 'image' && !e.locked) emit('image-edit', e);
    else emit('focus-prop', e);
  }

  rectOf(a, b, square = false) {
    let w = b.x - a.x, hh = b.y - a.y;
    if (square) {
      const s = Math.max(Math.abs(w), Math.abs(hh));
      w = Math.sign(w || 1) * s;
      hh = Math.sign(hh || 1) * s;
    }
    return { x: Math.min(a.x, a.x + w), y: Math.min(a.y, a.y + hh), w: Math.abs(w), h: Math.abs(hh) };
  }

  dragMove(d, p, ev) {
    let dx = p.x - d.start.x, dy = p.y - d.start.y;
    const guides = [];
    if (!ev.altKey && d.orig.length) {
      const gb = this.groupBox(d.orig);
      const th = 6 / this.k();
      const ids = new Set(d.orig.map((o) => o.id));
      const W = S.doc.page.w, H = S.doc.page.h;
      const tx = [0, W / 2, W], ty = [0, H / 2, H];
      for (const e of S.doc.elements) {
        if (ids.has(e.id)) continue;
        const b = bbox(e);
        tx.push(b.x, b.x + b.w / 2, b.x + b.w);
        ty.push(b.y, b.y + b.h / 2, b.y + b.h);
      }
      const snap = (pos, size, targets) => {
        let best = null;
        for (const s of [pos, pos + size / 2, pos + size]) {
          for (const t of targets) {
            const dd = t - s;
            if (Math.abs(dd) < th && (!best || Math.abs(dd) < Math.abs(best.dd))) best = { dd, t };
          }
        }
        return best;
      };
      const sx = snap(gb.x + dx, gb.w, tx), sy = snap(gb.y + dy, gb.h, ty);
      if (sx) { dx += sx.dd; guides.push({ x: sx.t }); } else if (S.grid.snap && S.grid.show) {
        dx = Math.round((gb.x + dx) / S.grid.size) * S.grid.size - gb.x;
      }
      if (sy) { dy += sy.dd; guides.push({ y: sy.t }); } else if (S.grid.snap && S.grid.show) {
        dy = Math.round((gb.y + dy) / S.grid.size) * S.grid.size - gb.y;
      }
    }
    for (const o of d.orig) {
      const e = byId(o.id);
      if (!e) continue;
      if (e.type === 'line') {
        e.x1 = r2(o.x1 + dx); e.y1 = r2(o.y1 + dy); e.x2 = r2(o.x2 + dx); e.y2 = r2(o.y2 + dy);
      } else {
        e.x = r2(o.x + dx); e.y = r2(o.y + dy);
      }
    }
    this.renderEls(d.orig.map((o) => o.id));
    this.drawOverlay(guides);
  }

  dragResize(d, p, ev) {
    const e = byId(d.id), o = d.orig;
    const [hx, hy] = HANDLES[d.h];
    const a = ((o.rot || 0) * Math.PI) / 180;
    const ux = [Math.cos(a), Math.sin(a)], uy = [-Math.sin(a), Math.cos(a)];
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const ax = cx - hx * (o.w / 2) * ux[0] - hy * (o.h / 2) * uy[0];
    const ay = cy - hx * (o.w / 2) * ux[1] - hy * (o.h / 2) * uy[1];
    const dx = p.x - ax, dy = p.y - ay;
    const lx = dx * ux[0] + dy * ux[1], ly = dx * uy[0] + dy * uy[1];
    let nw = hx ? Math.max(1, lx * hx) : o.w;
    let nh = hy ? Math.max(1, ly * hy) : o.h;
    const keep = ev.shiftKey !== (['image', 'qr', 'path'].includes(e.type));
    if (keep && hx && hy) {
      const s = Math.max(nw / o.w, nh / o.h);
      nw = o.w * s; nh = o.h * s;
    }
    const ncx = ax + hx * (nw / 2) * ux[0] + hy * (nh / 2) * uy[0];
    const ncy = ay + hx * (nw / 2) * ux[1] + hy * (nh / 2) * uy[1];
    e.w = r2(nw); e.h = r2(nh);
    e.x = r2(ncx - nw / 2);
    e.y = r2(ncy - nh / 2);
    this.renderEls([e.id]);
    this.drawOverlay();
    emit('live', e);
  }

  dragRotate(d, p, ev) {
    const e = byId(d.id), o = d.orig;
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    let ang = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI + 90;
    ang = ((ang % 360) + 360) % 360;
    if (ev.shiftKey) ang = Math.round(ang / 15) * 15;
    else {
      const near = Math.round(ang / 90) * 90;
      if (Math.abs(ang - near) < 4) ang = near;
    }
    e.rot = r2(ang % 360);
    this.renderEls([e.id]);
    this.drawOverlay();
    emit('live', e);
  }

  dragPoint(d, p, ev) {
    const e = byId(d.id);
    const other = d.h === 'p1' ? [e.x2, e.y2] : [e.x1, e.y1];
    let x = p.x, y = p.y;
    if (ev.shiftKey) {
      const ang = Math.atan2(y - other[1], x - other[0]);
      const sn = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(x - other[0], y - other[1]);
      x = other[0] + Math.cos(sn) * len;
      y = other[1] + Math.sin(sn) * len;
    }
    if (d.h === 'p1') { e.x1 = r2(x); e.y1 = r2(y); } else { e.x2 = r2(x); e.y2 = r2(y); }
    this.renderEls([e.id]);
    this.drawOverlay();
    emit('live', e);
  }

  dragMarquee(d, p) {
    const r = this.rectOf(d.start, p);
    const k = this.k();
    const box = this.temp && this.temp.classList.contains('marquee') ? this.temp : h('div', { class: 'marquee' });
    Object.assign(box.style, { left: r.x * k + 'px', top: r.y * k + 'px', width: r.w * k + 'px', height: r.h * k + 'px' });
    if (box !== this.temp) this.setTemp(box);
  }

  dragCreate(d, p, ev) {
    const k = this.k();
    if (d.tool === 'line') {
      let { x, y } = p;
      if (ev.shiftKey) {
        const ang = Math.atan2(y - d.start.y, x - d.start.x), sn = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(x - d.start.x, y - d.start.y);
        x = d.start.x + Math.cos(sn) * len; y = d.start.y + Math.sin(sn) * len;
      }
      d.end = { x, y };
      const ln = this.temp && this.temp.classList.contains('sel-line') ? this.temp : h('div', { class: 'sel-line' });
      const dx = (x - d.start.x) * k, dy = (y - d.start.y) * k;
      Object.assign(ln.style, { left: d.start.x * k + 'px', top: d.start.y * k + 'px', width: Math.hypot(dx, dy) + 'px', transform: `rotate(${Math.atan2(dy, dx)}rad)` });
      if (ln !== this.temp) this.setTemp(ln);
      return;
    }
    const r = this.rectOf(d.start, p, ev.shiftKey);
    d.rect = r;
    const box = this.temp && this.temp.classList.contains('marquee') ? this.temp : h('div', { class: 'marquee create' });
    Object.assign(box.style, { left: r.x * k + 'px', top: r.y * k + 'px', width: r.w * k + 'px', height: r.h * k + 'px', borderRadius: d.tool === 'ellipse' ? '50%' : '' });
    if (box !== this.temp) this.setTemp(box);
  }

  dragPen(d, p) {
    const last = d.pts[d.pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < 0.25) return;
    d.pts.push(p);
    const k = this.k();
    let svg = this.temp && this.temp.tagName === 'svg' ? this.temp : null;
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'pen-preview');
      svg.append(document.createElementNS('http://www.w3.org/2000/svg', 'polyline'));
      this.setTemp(svg);
    }
    const pl = svg.firstChild;
    pl.setAttribute('points', d.pts.map((q) => `${q.x * k},${q.y * k}`).join(' '));
    pl.setAttribute('stroke', S.pen.color);
    pl.setAttribute('stroke-width', S.pen.width * k);
  }

  finishCreate(d, p) {
    this.setTemp(null);
    const W = S.doc.page.w, H = S.doc.page.h;
    let el;
    if (d.tool === 'line') {
      const end = d.moved && d.end ? d.end : { x: d.start.x + 25, y: d.start.y };
      el = { ...defaultsFor('line'), x1: r2(d.start.x), y1: r2(d.start.y), x2: r2(end.x), y2: r2(end.y) };
    } else {
      let r = d.moved && d.rect && (d.rect.w > 1.5 || d.rect.h > 1.5) ? d.rect : null;
      if (!r) {
        const [dw, dh] = DEFAULT_SIZE[d.tool] || [20, 10];
        const w = Math.min(dw, W), hh = Math.min(dh, H);
        r = { x: clamp(p.x - w / 2, 0, Math.max(0, W - w)), y: clamp(p.y - hh / 2, 0, Math.max(0, H - hh)), w, h: hh };
      }
      el = { ...defaultsFor(d.tool), x: r2(r.x), y: r2(r.y), w: r2(Math.max(r.w, 1)), h: r2(Math.max(r.h, 1)) };
    }
    el.id = uid();
    el.rot = 0;
    this.addElement(el);
    emit('tool', 'select');
    if (el.type === 'text') {
      this.justCreated = true;
      this.startEdit(el.id, null, true);
    }
  }

  finishPen(d) {
    this.setTemp(null);
    if (d.pts.length < 2) return;
    const xs = d.pts.map((q) => q.x), ys = d.pts.map((q) => q.y);
    const pad = S.pen.width / 2;
    const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
    const w = Math.max(Math.max(...xs) - x + pad, 0.5), hh = Math.max(Math.max(...ys) - y + pad, 0.5);
    const path = 'M' + d.pts.map((q) => `${r2(q.x - x)},${r2(q.y - y)}`).join(' L');
    this.addElement({
      id: uid(), type: 'path', x: r2(x), y: r2(y), w: r2(w), h: r2(hh), vw: r2(w), vh: r2(hh), rot: 0,
      d: path, stroke: S.pen.color, strokeW: S.pen.width, fill: null,
    }, false);
  }

  addElement(el, doSelect = true) {
    snapshot();
    S.doc.elements.push(el);
    changed('add');
    if (doSelect) select([el.id]);
  }

  // ------------------------------------------------------------ text editing
  startEdit(id, ev, selectAll = false) {
    const e = byId(id);
    if (!e || e.type !== 'text' || e.locked) return;
    if (S.editingId) this.endEdit();
    select([id]);
    S.editingId = id;
    this.renderEls([id], true);
    const node = this.txNode(id);
    if (!node) { S.editingId = null; return; }
    node.style.zoom = '1';
    node.contentEditable = 'true';
    node.spellcheck = false;
    if (!e.html) node.innerHTML = `<div dir="${e.dir || 'auto'}"><br></div>`;
    this.editStart = e.html;
    this.editSnap = !this.justCreated;
    if (this.editSnap) snapshot();
    node.focus();
    const sel = window.getSelection();
    if (ev && document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(ev.clientX, ev.clientY);
      if (r && node.contains(r.startContainer)) { sel.removeAllRanges(); sel.addRange(r); }
    } else if (selectAll || !ev) {
      const r = document.createRange();
      r.selectNodeContents(node);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    node.oninput = () => {
      e.html = node.innerHTML;
      // Grow the box when the text no longer fits
      if (!e.fit) {
        const pad = e.pad || [0, 0, 0, 0];
        const need = node.offsetHeight / PXMM + pad[0] + pad[2] + (e.stroke ? 2 * (e.strokeW || 0) : 0);
        if (need > e.h + 0.05) {
          e.h = r2(need);
          const wrap = node.closest('[data-id]');
          wrap.style.height = node.parentElement.style.height = `${(e.h * PXMM).toFixed(3)}px`;
        }
      }
      S.dirty = true;
      this.drawOverlay();
      changed('text');
    };
    node.onpaste = (pe) => {
      pe.preventDefault();
      const t = pe.clipboardData.getData('text/plain');
      if (t) document.execCommand('insertText', false, t);
    };
    node.onkeydown = (ke) => {
      if (ke.key === 'Escape') { ke.preventDefault(); ke.stopPropagation(); this.endEdit(); }
    };
    this.drawOverlay();
    emit('editing', true);
  }

  endEdit() {
    const id = S.editingId;
    if (!id) return;
    const e = byId(id);
    const node = this.txNode(id);
    if (node && e) {
      e.html = node.innerHTML;
      node.contentEditable = 'false';
      node.oninput = node.onpaste = node.onkeydown = null;
    }
    S.editingId = null;
    window.getSelection().removeAllRanges();
    if (e && !textOf(e.html).trim() && !/<img/i.test(e.html)) {
      S.doc.elements = S.doc.elements.filter((x) => x.id !== id);
      if (this.editSnap || this.justCreated) dropLastSnapshot();
      select([]);
    } else if (e && this.editSnap && e.html === this.editStart) {
      dropLastSnapshot();
    }
    this.justCreated = false;
    emit('editing', false);
    changed('edit-end');
  }

  // ------------------------------------------------------------ commands
  deleteSel() {
    if (!S.sel.length) return;
    snapshot();
    const ids = new Set(S.sel);
    S.doc.elements = S.doc.elements.filter((e) => !ids.has(e.id) || e.locked);
    select(S.doc.elements.filter((e) => ids.has(e.id)).map((e) => e.id));
    changed('delete');
  }

  copy() {
    this.clip = selected().map(clone);
    this.pasteN = 0;
  }

  cut() {
    this.copy();
    this.deleteSel();
  }

  paste(list = this.clip) {
    if (!list.length) return;
    this.pasteN++;
    const off = 3 * this.pasteN;
    snapshot();
    const ids = [];
    for (const src of list) {
      const e = clone(src);
      e.id = uid();
      if (e.type === 'line') { e.x1 += off; e.x2 += off; e.y1 += off; e.y2 += off; } else { e.x += off; e.y += off; }
      e.locked = false;
      S.doc.elements.push(e);
      ids.push(e.id);
    }
    changed('paste');
    select(ids);
  }

  duplicate() {
    this.copy();
    this.paste();
  }

  nudge(dx, dy) {
    const els = selected().filter((e) => !e.locked);
    if (!els.length) return;
    const now = Date.now();
    if (!this.lastNudge || now - this.lastNudge > 800) snapshot();
    this.lastNudge = now;
    for (const e of els) {
      if (e.type === 'line') { e.x1 = r2(e.x1 + dx); e.x2 = r2(e.x2 + dx); e.y1 = r2(e.y1 + dy); e.y2 = r2(e.y2 + dy); } else { e.x = r2(e.x + dx); e.y = r2(e.y + dy); }
    }
    this.renderEls(els.map((e) => e.id));
    this.drawOverlay();
    S.dirty = true;
    emit('live', els[0]);
    emit('change', 'nudge-live');
  }

  order(where) {
    const els = S.doc.elements;
    const ids = new Set(S.sel);
    if (!ids.size) return;
    snapshot();
    const sel = els.filter((e) => ids.has(e.id)), rest = els.filter((e) => !ids.has(e.id));
    if (where === 'front') S.doc.elements = [...rest, ...sel];
    else if (where === 'back') S.doc.elements = [...sel, ...rest];
    else {
      const arr = [...els];
      const idxs = arr.map((e, i) => (ids.has(e.id) ? i : -1)).filter((i) => i >= 0);
      if (where === 'forward') {
        for (const i of idxs.reverse()) if (i < arr.length - 1 && !ids.has(arr[i + 1].id)) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
      } else {
        for (const i of idxs) if (i > 0 && !ids.has(arr[i - 1].id)) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
      }
      S.doc.elements = arr;
    }
    changed('order');
  }

  align(mode) {
    const els = selected().filter((e) => !e.locked);
    if (!els.length) return;
    snapshot();
    const ref = els.length > 1 ? this.groupBox(els) : { x: 0, y: 0, w: S.doc.page.w, h: S.doc.page.h };
    for (const e of els) {
      const b = bbox(e);
      let dx = 0, dy = 0;
      if (mode === 'left') dx = ref.x - b.x;
      if (mode === 'hcenter') dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
      if (mode === 'right') dx = ref.x + ref.w - (b.x + b.w);
      if (mode === 'top') dy = ref.y - b.y;
      if (mode === 'vcenter') dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
      if (mode === 'bottom') dy = ref.y + ref.h - (b.y + b.h);
      if (e.type === 'line') { e.x1 = r2(e.x1 + dx); e.x2 = r2(e.x2 + dx); e.y1 = r2(e.y1 + dy); e.y2 = r2(e.y2 + dy); } else { e.x = r2(e.x + dx); e.y = r2(e.y + dy); }
    }
    changed('align');
  }

  selectAll() {
    select(S.doc.elements.map((e) => e.id));
  }
}
