// Image editor window: crop, turn, mirror, light and detail, black and white for thermal printing, background, shape.
// Everything is a setting on the element (non-destructive); "Apply" is one undo step.
import { S, snapshot, changed } from './state.js';
import { h, dialog, r2 } from './util.js';
import { t } from './i18n.js';
import { ICONS } from './icons.js';
import { FX_DEFAULTS, MODES, fxOf, loadImage, process, trimBounds, pickColor } from './imagefx.js';

const ASPECTS = [['free', null], ['original', 'nat'], ['frame', 'frame'], ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4],
  ['3:2', 3 / 2], ['2:3', 2 / 3], ['16:9', 16 / 9], ['9:16', 9 / 16]];
const MIN_CROP = 0.03;

// ---------------------------------------------------------------- geometry shared with the properties panel
/** Crop fractions after turning the picture a quarter turn (dir 1 = clockwise) */
const turnCrop = (c, dir) => (dir > 0 ? [c[3], c[0], c[1], c[2]] : [c[1], c[2], c[3], c[0]]);

/** Turn the picture inside its frame by 90 degrees; the frame swaps width and height around its centre */
export function turnImage(e, dir) {
  const fx = { ...(e.fx || {}) };
  fx.rot90 = (((fx.rot90 || 0) + (dir > 0 ? 90 : 270)) % 360);
  e.fx = fx;
  e.crop = turnCrop(e.crop || [0, 0, 0, 0], dir);
  const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
  [e.w, e.h] = [e.h, e.w];
  e.x = r2(cx - e.w / 2);
  e.y = r2(cy - e.h / 2);
}

/** Mirror as seen on screen (axis 'h' or 'v'), whatever the quarter turns */
export function mirrorImage(e, axis) {
  const turned = ((e.fx && e.fx.rot90) || 0) % 180 !== 0;
  const flipH = (axis === 'h') !== turned;
  if (flipH) e.flipH = !e.flipH; else e.flipV = !e.flipV;
  const c = e.crop || [0, 0, 0, 0];
  e.crop = axis === 'h' ? [c[2], c[1], c[0], c[3]] : [c[0], c[3], c[2], c[1]];
}

/** Remove every edit, keep the frame */
export function resetImage(e) {
  delete e.fx;
  delete e.dither;
  e.flipH = false;
  e.flipV = false;
  e.invert = false;
  e.gray = false;
  e.crop = [0, 0, 0, 0];
}

// ---------------------------------------------------------------- the window
export async function openImageEditor(e, { cropFirst = false } = {}) {
  const img = await loadImage(e.src);
  const start = fxOf(e);
  const d = {
    fx: Object.fromEntries(Object.keys(FX_DEFAULTS).map((k) => [k, start[k]])),
    flipH: start.flipH, flipV: start.flipV, invert: start.invert, gray: start.gray,
    crop: [...(e.crop || [0, 0, 0, 0])],
    opacity: e.opacity === undefined ? 1 : e.opacity,
    corner: e.mask === 'circle' ? 'circle' : e.radius ? 'round' : 'square',
    radius: e.radius || 2,
  };
  const orig = JSON.stringify(d);
  let aspect = 'free', comparing = false, picking = false, asPrinted = false;
  const nat = () => (d.fx.rot90 % 180 ? { w: img.naturalHeight, h: img.naturalWidth } : { w: img.naturalWidth, h: img.naturalHeight });
  const dpmm = (S.settings.editDpi || 203) / 25.4;
  const lastPrinter = (S.settings.printers || {})[S.settings.lastPrinter] || {};

  // Frame size in mm for the current crop: the same picture scale as now (crop or turn changes the frame, not the scale)
  const startNat = { w: img.naturalWidth, h: img.naturalHeight };
  const startTurned = (start.rot90 || 0) % 180 !== 0;
  const startVis = {
    w: (startTurned ? startNat.h : startNat.w) * (1 - (e.crop || [0, 0, 0, 0])[0] - (e.crop || [0, 0, 0, 0])[2]),
    h: (startTurned ? startNat.w : startNat.h) * (1 - (e.crop || [0, 0, 0, 0])[1] - (e.crop || [0, 0, 0, 0])[3]),
  };
  const mmPerPx = Math.sqrt((e.w * e.h) / Math.max(1, startVis.w * startVis.h));
  const frameMm = () => {
    const n = nat();
    return { w: Math.max(1, n.w * (1 - d.crop[0] - d.crop[2]) * mmPerPx), h: Math.max(1, n.h * (1 - d.crop[1] - d.crop[3]) * mmPerPx) };
  };
  const geometryChanged = () => JSON.stringify([d.crop, d.fx.rot90]) !== JSON.stringify([e.crop || [0, 0, 0, 0], start.rot90 || 0]);

  // ---------- stage
  const canvas = h('canvas', { class: 'ie-canvas' });
  const box = h('div', { class: 'ie-crop' }, ...['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((k) => h('div', { class: `ie-hd ie-${k}`, 'data-h': k })));
  const frame = h('div', { class: 'ie-frame' }, canvas, box);
  const stage = h('div', { class: 'ie-stage', dir: 'ltr' }, frame);
  const sizeInfo = h('div', { class: 'ie-size muted' });

  let pending = 0;
  const schedule = () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(draw);
  };
  function draw() {
    const n = nat();
    const sw = Math.max(200, stage.clientWidth - 24), sh = Math.max(200, stage.clientHeight - 24);
    const k = Math.min(sw / n.w, sh / n.h);
    const dw = Math.max(1, Math.round(n.w * k)), dh = Math.max(1, Math.round(n.h * k));
    const fx = { ...d.fx, flipH: d.flipH, flipV: d.flipV, invert: d.invert, gray: d.gray };
    let src;
    if (comparing) {
      src = process(img, { ...FX_DEFAULTS, rot90: d.fx.rot90, flipH: d.flipH, flipV: d.flipV }, dw, dh);
    } else if (fx.mode !== 'auto' || asPrinted) {
      // Black and white at the real printer dots, then enlarged with sharp pixels
      const f = frameMm();
      const fw = 1 - d.crop[0] - d.crop[2], fh = 1 - d.crop[1] - d.crop[3];
      const pw = Math.min(3000, Math.max(1, Math.round((f.w / fw) * dpmm))), ph = Math.min(3000, Math.max(1, Math.round((f.h / fh) * dpmm)));
      src = process(img, fx.mode === 'auto' ? { ...fx, mode: 'threshold', level: lastPrinter.threshold || 140 } : fx, pw, ph);
    } else {
      src = process(img, fx, dw, dh);
    }
    canvas.width = dw;
    canvas.height = dh;
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = src.width >= dw;
    g.clearRect(0, 0, dw, dh);
    g.drawImage(src, 0, 0, dw, dh);
    canvas.style.opacity = String(d.opacity);
    Object.assign(frame.style, { width: dw + 'px', height: dh + 'px' });
    Object.assign(box.style, {
      left: d.crop[0] * dw + 'px', top: d.crop[1] * dh + 'px',
      width: (1 - d.crop[0] - d.crop[2]) * dw + 'px', height: (1 - d.crop[1] - d.crop[3]) * dh + 'px',
      borderRadius: d.corner === 'circle' ? '50%' : '',
    });
    const f = frameMm();
    sizeInfo.textContent = t('img.frameSize', { w: r2(f.w), h: r2(f.h) });
  }

  // ---------- crop dragging
  let drag = null;
  frame.addEventListener('pointerdown', async (ev) => {
    const r = canvas.getBoundingClientRect();
    if (picking) {
      const color = await pickColor({ ...e, fx: d.fx, flipH: d.flipH, flipV: d.flipV, gray: d.gray }, (ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height);
      d.fx.bgColor = color;
      d.fx.removeBg = true;
      picking = false;
      frame.classList.remove('picking');
      syncControls();
      schedule();
      return;
    }
    const hd = ev.target.closest('.ie-hd');
    if (!hd && !ev.target.closest('.ie-crop')) return;
    drag = { h: hd ? hd.dataset.h : 'move', x: ev.clientX, y: ev.clientY, c: [...d.crop], W: r.width, H: r.height };
    frame.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  frame.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = (ev.clientX - drag.x) / drag.W, dy = (ev.clientY - drag.y) / drag.H;
    let [l, tp, rt, b] = drag.c;
    if (drag.h === 'move') {
      const w = 1 - l - rt, hh = 1 - tp - b;
      l = Math.min(1 - w, Math.max(0, l + dx));
      tp = Math.min(1 - hh, Math.max(0, tp + dy));
      rt = 1 - w - l;
      b = 1 - hh - tp;
    } else {
      if (drag.h.includes('w')) l = Math.min(1 - rt - MIN_CROP, Math.max(0, l + dx));
      if (drag.h.includes('e')) rt = Math.min(1 - l - MIN_CROP, Math.max(0, rt - dx));
      if (drag.h.includes('n')) tp = Math.min(1 - b - MIN_CROP, Math.max(0, tp + dy));
      if (drag.h.includes('s')) b = Math.min(1 - tp - MIN_CROP, Math.max(0, b - dy));
      const ratio = aspectRatio();
      if (ratio) [l, tp, rt, b] = fitAspect([l, tp, rt, b], ratio, drag.h);
    }
    d.crop = [l, tp, rt, b].map((v) => Math.round(v * 10000) / 10000);
    schedule();
  });
  frame.addEventListener('pointerup', () => { drag = null; });

  function aspectRatio() {
    const a = ASPECTS.find(([k]) => k === aspect);
    if (!a || !a[1]) return null;
    if (a[1] === 'nat') return nat().w / nat().h;
    if (a[1] === 'frame') return e.w / e.h;
    return a[1];
  }
  /** Adjust the crop to a width/height ratio (in mm on the label), keeping the dragged side */
  function fitAspect(c, ratio, handle) {
    let [l, tp, rt, b] = c;
    const n = nat();
    const w = (1 - l - rt) * n.w, hh = (1 - tp - b) * n.h;
    if (handle === 'n' || handle === 's') {
      const nw = Math.min(n.w, hh * ratio);
      const cx = l + (1 - l - rt) / 2;
      l = Math.max(0, Math.min(1 - nw / n.w, cx - nw / n.w / 2));
      rt = 1 - l - nw / n.w;
    } else {
      const nh = Math.min(n.h, w / ratio);
      if (handle.includes('n')) tp = Math.max(0, 1 - b - nh / n.h);
      else b = Math.max(0, 1 - tp - nh / n.h);
      if (1 - tp - b > nh / n.h + 1e-6) b = 1 - tp - nh / n.h;
    }
    return [l, tp, rt, b];
  }
  function applyAspect() {
    const ratio = aspectRatio();
    if (!ratio) return;
    const n = nat();
    let w = (1 - d.crop[0] - d.crop[2]) * n.w, hh = (1 - d.crop[1] - d.crop[3]) * n.h;
    if (w / hh > ratio) w = hh * ratio; else hh = w / ratio;
    const cx = (d.crop[0] + (1 - d.crop[0] - d.crop[2]) / 2) * n.w, cy = (d.crop[1] + (1 - d.crop[1] - d.crop[3]) / 2) * n.h;
    const x = Math.min(n.w - w, Math.max(0, cx - w / 2)), y = Math.min(n.h - hh, Math.max(0, cy - hh / 2));
    d.crop = [x / n.w, y / n.h, 1 - (x + w) / n.w, 1 - (y + hh) / n.h].map((v) => Math.max(0, Math.round(v * 10000) / 10000));
  }

  // ---------- controls
  const ctl = {};
  const icon = (name) => h('span', { class: 'ico', html: ICONS[name] });
  const tool = (name, title, fn) => h('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, onclick: () => { fn(); syncControls(); schedule(); } }, icon(name));
  const slider = (key, min, max, step, read = (v) => v, write = (v) => v) => {
    const out = h('span', { class: 'ie-val' });
    const inp = h('input', { type: 'range', min, max, step, class: 'ie-range' });
    inp.addEventListener('input', () => { d.fx[key] = read(parseFloat(inp.value)); out.textContent = String(Math.round(parseFloat(inp.value))); schedule(); });
    inp.addEventListener('dblclick', () => { d.fx[key] = FX_DEFAULTS[key]; syncControls(); schedule(); });
    ctl[key] = () => { inp.value = write(d.fx[key]); out.textContent = String(Math.round(write(d.fx[key]))); };
    return h('span', { class: 'ie-slider' }, inp, out);
  };
  const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);
  const check = (label, get, set) => {
    const c = h('input', { type: 'checkbox' });
    c.addEventListener('change', () => { set(c.checked); syncControls(); schedule(); });
    ctl['c_' + label] = () => { c.checked = get(); };
    return h('label', { class: 'check' }, c, h('span', {}, label));
  };
  const section = (title, ...kids) => h('section', { class: 'ie-sec' }, h('h4', {}, title), ...kids);

  const aspectSel = h('select', { class: 'inp' }, ...ASPECTS.map(([k]) => h('option', { value: k }, t('img.aspect.' + k.replace(':', '_')))));
  aspectSel.addEventListener('change', () => { aspect = aspectSel.value; applyAspect(); schedule(); });
  const modeSel = h('select', { class: 'inp' }, ...MODES.map((m) => h('option', { value: m }, t('img.mode.' + m))));
  modeSel.addEventListener('change', () => { d.fx.mode = modeSel.value; syncControls(); schedule(); });
  const color = h('input', { type: 'color', class: 'color-inp' });
  color.addEventListener('input', () => { d.fx.bgColor = color.value; d.fx.removeBg = true; syncControls(); schedule(); });
  const pickBtn = h('button', {
    class: 'icon-btn', type: 'button', title: t('img.pick'), 'aria-label': t('img.pick'),
    onclick: () => { picking = !picking; frame.classList.toggle('picking', picking); pickBtn.classList.toggle('on', picking); },
  }, icon('eyedropper'));
  const cornerSel = h('select', { class: 'inp' }, ...['square', 'round', 'circle'].map((k) => h('option', { value: k }, t('img.corner.' + k))));
  cornerSel.addEventListener('change', () => { d.corner = cornerSel.value; syncControls(); schedule(); });
  const radius = h('input', { class: 'inp num', type: 'number', min: 0.5, step: 0.5 });
  radius.addEventListener('change', () => { d.radius = Math.max(0.5, parseFloat(radius.value) || 2); });
  const opacity = h('input', { type: 'range', min: 10, max: 100, step: 5, class: 'ie-range' });
  const opacityVal = h('span', { class: 'ie-val' });
  opacity.addEventListener('input', () => { d.opacity = parseFloat(opacity.value) / 100; opacityVal.textContent = opacity.value; schedule(); });
  const levelRow = h('div', {});
  const radiusRow = h('div', {});
  const bgRow = h('div', { class: 'ie-inline' });

  function syncControls() {
    for (const fn of Object.values(ctl)) fn();
    modeSel.value = d.fx.mode;
    color.value = d.fx.bgColor;
    cornerSel.value = d.corner;
    radius.value = d.radius;
    opacity.value = Math.round(d.opacity * 100);
    opacityVal.textContent = opacity.value;
    levelRow.hidden = d.fx.mode === 'auto';
    radiusRow.hidden = d.corner !== 'round';
    bgRow.classList.toggle('off', !d.fx.removeBg);
  }

  const compare = h('button', { class: 'btn btn-ghost', type: 'button' }, icon('compare'), h('span', {}, t('img.compare')));
  const hold = (on) => () => { comparing = on; schedule(); };
  compare.addEventListener('pointerdown', hold(true));
  compare.addEventListener('pointerup', hold(false));
  compare.addEventListener('pointerleave', hold(false));
  const printedChk = check(t('img.asPrinted'), () => asPrinted, (v) => { asPrinted = v; });

  const controls = h('div', { class: 'ie-controls' },
    section(t('img.cropTurn'),
      field(t('img.aspect'), aspectSel),
      h('div', { class: 'btn-row wrap' },
        tool('rotL', t('img.rotateLeft'), () => { d.fx.rot90 = (d.fx.rot90 + 270) % 360; d.crop = turnCrop(d.crop, -1); }),
        tool('rotR', t('img.rotateRight'), () => { d.fx.rot90 = (d.fx.rot90 + 90) % 360; d.crop = turnCrop(d.crop, 1); }),
        tool('flipH', t('img.flipH'), () => {
          if (d.fx.rot90 % 180) d.flipV = !d.flipV; else d.flipH = !d.flipH;
          d.crop = [d.crop[2], d.crop[1], d.crop[0], d.crop[3]];
        }),
        tool('flipV', t('img.flipV'), () => {
          if (d.fx.rot90 % 180) d.flipH = !d.flipH; else d.flipV = !d.flipV;
          d.crop = [d.crop[0], d.crop[3], d.crop[2], d.crop[1]];
        }),
        h('button', {
          class: 'btn btn-ghost', type: 'button',
          onclick: async () => { d.crop = await trimBounds({ ...e, fx: d.fx, flipH: d.flipH, flipV: d.flipV }); schedule(); },
        }, t('img.trim')),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { d.crop = [0, 0, 0, 0]; schedule(); } }, t('img.resetCrop')))),
    section(t('img.light'),
      field(t('img.brightness'), slider('brightness', -100, 100, 1)),
      field(t('img.contrast'), slider('contrast', -100, 100, 1)),
      field(t('img.midtones'), slider('gamma', -100, 100, 1, (v) => Math.pow(3, v / 100), (g) => (Math.log(g) / Math.log(3)) * 100)),
      field(t('img.sharpen'), slider('sharpen', 0, 100, 1)),
      field(t('img.blur'), slider('blur', 0, 10, 1)),
      check(t('img.autoLevels'), () => d.fx.autoLevels, (v) => { d.fx.autoLevels = v; }),
      field(t('props.opacity'), h('span', { class: 'ie-slider' }, opacity, opacityVal))),
    section(t('img.bw'),
      field(t('img.mode'), modeSel),
      h('div', {}, levelRow),
      check(t('props.invert'), () => d.invert, (v) => { d.invert = v; }),
      check(t('props.gray'), () => d.gray, (v) => { d.gray = v; }),
      printedChk),
    section(t('img.background'),
      check(t('img.removeBg'), () => d.fx.removeBg, (v) => { d.fx.removeBg = v; }),
      bgRow),
    section(t('img.shape'),
      field(t('img.corners'), cornerSel),
      radiusRow));
  levelRow.append(field(t('img.level'), slider('level', 1, 254, 1)));
  bgRow.append(field(t('img.bgColor'), h('span', { class: 'ie-inline' }, color, pickBtn)), field(t('img.bgTol'), slider('bgTol', 0, 100, 1)));
  radiusRow.append(field(t('props.cornerRadius'), h('span', { class: 'num-wrap' }, radius, h('em', {}, 'mm'))));

  const body = h('div', { class: 'ie' },
    h('div', { class: 'ie-left' }, stage, h('div', { class: 'ie-under' }, compare, sizeInfo)),
    controls);
  syncControls();

  const apply = () => {
    snapshot();
    const fx = {};
    for (const k of Object.keys(FX_DEFAULTS)) if (d.fx[k] !== FX_DEFAULTS[k]) fx[k] = d.fx[k];
    if (Object.keys(fx).length) e.fx = fx; else delete e.fx;
    delete e.dither;
    e.flipH = d.flipH;
    e.flipV = d.flipV;
    e.invert = d.invert;
    e.gray = d.gray;
    if (geometryChanged()) {
      const f = frameMm();
      const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
      e.w = r2(f.w);
      e.h = r2(f.h);
      e.x = r2(cx - e.w / 2);
      e.y = r2(cy - e.h / 2);
      e.fit = 'fill';
    }
    e.crop = d.crop;
    if (d.opacity < 1) e.opacity = d.opacity; else delete e.opacity;
    if (d.corner === 'circle') { e.mask = 'circle'; delete e.radius; }
    else if (d.corner === 'round') { delete e.mask; e.radius = d.radius; }
    else { delete e.mask; delete e.radius; }
    changed('image');
  };

  await dialog({
    title: t('img.title'), body, wide: true,
    buttons: [
      { label: t('img.apply'), primary: true, value: null, validate: () => { if (JSON.stringify(d) !== orig) apply(); return true; } },
      { label: t('common.cancel'), value: null },
      {
        label: t('img.resetAll'), value: null,
        validate: () => {
          Object.assign(d, { fx: { ...FX_DEFAULTS }, flipH: false, flipV: false, invert: false, gray: false, crop: [0, 0, 0, 0], opacity: 1, corner: 'square' });
          syncControls();
          schedule();
          return false;
        },
      },
    ],
    onOpen: (dlg) => {
      dlg.classList.add('dlg-image');
      requestAnimationFrame(() => {
        if (cropFirst && aspect === 'free') aspectSel.focus();
        draw();
      });
      new ResizeObserver(schedule).observe(stage);
    },
  });
}
