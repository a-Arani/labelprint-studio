// Image editing: non-destructive adjustments (element.fx) applied on a canvas.
// The original picture (element.src) is never changed; the processed copy is cached per size.

export const FX_DEFAULTS = {
  rot90: 0,          // quarter turns of the picture inside its frame: 0, 90, 180, 270
  brightness: 0,     // -100..100
  contrast: 0,       // -100..100
  gamma: 1,          // midtones, 0.3..3 (above 1 = lighter)
  sharpen: 0,        // 0..100
  blur: 0,           // 0..10 (dots of the output)
  autoLevels: false, // stretch the darkest and lightest tones to full black and white
  mode: 'auto',      // auto | threshold | fs | atkinson | bayer
  level: 128,        // black threshold for the black-and-white modes, 1..254
  removeBg: false,   // make the background colour transparent
  bgColor: '#ffffff',
  bgTol: 12,         // 0..100
};

export const MODES = ['auto', 'threshold', 'fs', 'atkinson', 'bayer'];

/** All settings of an image, including the older separate fields (flipH, invert, gray, dither) */
export function fxOf(e) {
  const fx = { ...FX_DEFAULTS, ...(e.fx || {}) };
  if (!e.fx && e.dither) fx.mode = 'fs';
  return { ...fx, flipH: !!e.flipH, flipV: !!e.flipV, invert: !!e.invert, gray: !!e.gray };
}

/** True when the picture needs processing (otherwise the original is shown as it is) */
export function isEdited(e) {
  const f = fxOf(e);
  return f.flipH || f.flipV || f.invert || f.gray || Object.keys(FX_DEFAULTS).some((k) => f[k] !== FX_DEFAULTS[k]);
}

export const isMono = (e) => fxOf(e).mode !== 'auto';

// ---------------------------------------------------------------- cache and loading
const images = new Map();      // src key -> Promise<HTMLImageElement>
const done = new Map();        // job key -> data URL
const pending = new Map();     // job key -> Promise
const listeners = new Set();

export function onReady(fn) { listeners.add(fn); }

function srcKey(src) {
  let h = 0;
  const step = Math.max(1, Math.floor(src.length / 4096));
  for (let i = 0; i < src.length; i += step) h = (h * 31 + src.charCodeAt(i)) | 0;
  return `${src.length}:${h}`;
}

export function loadImage(src) {
  const k = srcKey(src);
  if (!images.has(k)) {
    const img = new Image();
    img.src = src;
    images.set(k, img.decode().then(() => img));
    if (images.size > 60) images.delete(images.keys().next().value);
  }
  return images.get(k);
}

/** Natural size of the picture after its quarter turns */
export async function sourceSize(src, rot90 = 0) {
  const img = await loadImage(src);
  const turned = rot90 % 180 !== 0;
  return { w: turned ? img.naturalHeight : img.naturalWidth, h: turned ? img.naturalWidth : img.naturalHeight };
}

function settingsKey(f) {
  return JSON.stringify([f.rot90, f.brightness, f.contrast, f.gamma, f.sharpen, f.blur, f.autoLevels, f.mode, f.level,
    f.removeBg, f.bgColor, f.bgTol, f.flipH, f.flipV, f.invert, f.gray]);
}

/**
 * Output size for a frame of wMm x hMm at dpmm dots per mm.
 * The whole picture (before crop) is processed; the crop window shows part of it.
 */
export function targetSize(e, dpmm, nat) {
  const crop = e.crop || [0, 0, 0, 0];
  const fw = Math.max(0.01, 1 - crop[0] - crop[2]), fh = Math.max(0.01, 1 - crop[1] - crop[3]);
  let w = (e.w / fw) * dpmm, h = (e.h / fh) * dpmm;
  if (e.fit === 'contain' || e.fit === 'cover') {
    const s = (e.fit === 'cover' ? Math.max : Math.min)((e.w * dpmm) / nat.w, (e.h * dpmm) / nat.h);
    w = nat.w * s;
    h = nat.h * s;
  }
  // Black and white needs exactly one pixel per printer dot; colour never needs more than the picture's own pixels
  if (!isMono(e)) {
    const k = Math.min(1, Math.max(nat.w / w, nat.h / h), 2400 / Math.max(w, h));
    w *= k;
    h *= k;
  }
  return { w: Math.max(1, Math.min(6000, Math.round(w))), h: Math.max(1, Math.min(6000, Math.round(h))) };
}

/** The processed picture if it is ready (synchronous, for rendering) */
export function cached(e, dpmm, nat) {
  const n = nat || natCache.get(srcKey(e.src));
  if (!n) return null;
  const t = targetSize(e, dpmm, n);
  return done.get(`${srcKey(e.src)}|${settingsKey(fxOf(e))}|${t.w}x${t.h}`) || null;
}

const natCache = new Map();

/** Process the picture of element e for a frame at dpmm; resolves to a data URL */
export async function processFor(e, dpmm) {
  const f = fxOf(e);
  const img = await loadImage(e.src);
  const k = srcKey(e.src);
  const turned = f.rot90 % 180 !== 0;
  const nat = { w: turned ? img.naturalHeight : img.naturalWidth, h: turned ? img.naturalWidth : img.naturalHeight };
  natCache.set(k, nat);
  const t = targetSize(e, dpmm, nat);
  const key = `${k}|${settingsKey(f)}|${t.w}x${t.h}`;
  if (done.has(key)) return done.get(key);
  if (!pending.has(key)) {
    pending.set(key, Promise.resolve().then(() => {
      const url = process(img, f, t.w, t.h).toDataURL('image/png');
      done.set(key, url);
      if (done.size > 80) done.delete(done.keys().next().value);
      pending.delete(key);
      return url;
    }));
  }
  return pending.get(key);
}

/** Start processing for the editor and tell listeners when it is ready */
export function request(e, dpmm) {
  processFor(e, dpmm).then(() => { for (const fn of listeners) fn(e.id); }).catch(() => {});
}

// ---------------------------------------------------------------- the pipeline
function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Draw the picture turned and mirrored into a w x h canvas and apply every setting */
export function process(img, f, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.save();
  g.translate(w / 2, h / 2);
  g.rotate((f.rot90 * Math.PI) / 180);
  g.scale(f.flipH ? -1 : 1, f.flipV ? -1 : 1);
  const turned = f.rot90 % 180 !== 0;
  const dw = turned ? h : w, dh = turned ? w : h;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  g.restore();
  const data = g.getImageData(0, 0, w, h);
  adjust(data, f);
  g.putImageData(data, 0, 0);
  return c;
}

/** All pixel operations, in place on an ImageData */
export function adjust(data, f) {
  const d = data.data, n = d.length / 4, W = data.width, H = data.height;
  // 1. Background: pixels close to the chosen colour become transparent
  if (f.removeBg) {
    const [br, bg, bb] = hexRgb(f.bgColor);
    const tol = (f.bgTol / 100) * 442;
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const dist = Math.hypot(d[p] - br, d[p + 1] - bg, d[p + 2] - bb);
      if (dist <= tol) d[p + 3] = 0;
      else if (dist <= tol * 1.4) d[p + 3] = Math.round(d[p + 3] * ((dist - tol) / (tol * 0.4)));
    }
  }
  // 2. Tones: automatic levels, then brightness, contrast and midtones through one lookup table
  let lo = 0, hi = 255;
  if (f.autoLevels) {
    const hist = new Uint32Array(256);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      if (d[p + 3] < 16) continue;
      hist[Math.round(0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2])]++;
      count++;
    }
    let acc = 0;
    for (lo = 0; lo < 255 && (acc += hist[lo]) < count * 0.005; lo++);
    acc = 0;
    for (hi = 255; hi > 0 && (acc += hist[hi]) < count * 0.005; hi--);
    if (hi - lo < 10) { lo = 0; hi = 255; }
  }
  const lut = new Uint8ClampedArray(256);
  const c = f.contrast * 2.55;
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  for (let v = 0; v < 256; v++) {
    let x = ((v - lo) * 255) / (hi - lo);
    x += f.brightness * 2.55;
    x = cf * (x - 128) + 128;
    x = 255 * Math.pow(Math.min(1, Math.max(0, x / 255)), 1 / (f.gamma || 1));
    lut[v] = x;
  }
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    d[p] = lut[d[p]];
    d[p + 1] = lut[d[p + 1]];
    d[p + 2] = lut[d[p + 2]];
  }
  // 3. Softening and sharpening
  if (f.blur > 0) boxBlur(d, W, H, Math.round(f.blur));
  if (f.sharpen > 0) unsharp(d, W, H, f.sharpen / 50);
  // 4. Greyscale and negative
  if (f.gray || f.invert) {
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      if (f.gray) d[p] = d[p + 1] = d[p + 2] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      if (f.invert) { d[p] = 255 - d[p]; d[p + 1] = 255 - d[p + 1]; d[p + 2] = 255 - d[p + 2]; }
    }
  }
  // 5. Black and white for thermal printing
  if (f.mode !== 'auto') toBlackWhite(d, W, H, f.mode, f.level);
}

function boxBlur(d, W, H, r) {
  const tmp = new Float32Array(W * H * 4);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? d : tmp, dst = pass === 0 ? tmp : d;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, cnt = 0;
        for (let k = -r; k <= r; k++) {
          const xx = pass === 0 ? Math.min(W - 1, Math.max(0, x + k)) : x;
          const yy = pass === 0 ? y : Math.min(H - 1, Math.max(0, y + k));
          const p = (yy * W + xx) * 4;
          s0 += src[p]; s1 += src[p + 1]; s2 += src[p + 2]; s3 += src[p + 3]; cnt++;
        }
        const q = (y * W + x) * 4;
        dst[q] = s0 / cnt; dst[q + 1] = s1 / cnt; dst[q + 2] = s2 / cnt; dst[q + 3] = s3 / cnt;
      }
    }
  }
}

function unsharp(d, W, H, amount) {
  const src = new Uint8ClampedArray(d);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const blur = (src[p - 4 + ch] + src[p + 4 + ch] + src[p - W * 4 + ch] + src[p + W * 4 + ch] + src[p + ch] * 4) / 8;
        d[p + ch] = src[p + ch] + (src[p + ch] - blur) * amount * 2;
      }
    }
  }
}

const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];

/** Luminance over white; transparent pixels stay transparent */
function toBlackWhite(d, W, H, mode, level) {
  const n = W * H;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4, a = d[p + 3] / 255;
    lum[i] = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) * a + 255 * (1 - a);
  }
  const t = Math.min(254, Math.max(1, level));
  const spread = (i, err, k) => { if (i >= 0 && i < n) lum[i] += err * k; };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, old = lum[i];
      let black;
      if (mode === 'bayer') black = old < t + (BAYER[(y % 8) * 8 + (x % 8)] / 64 - 0.5) * 255;
      else black = old < t;
      const nv = black ? 0 : 255;
      lum[i] = nv;
      const err = old - nv;
      if (mode === 'fs') {
        if (x + 1 < W) spread(i + 1, err, 7 / 16);
        if (y + 1 < H) {
          if (x > 0) spread(i + W - 1, err, 3 / 16);
          spread(i + W, err, 5 / 16);
          if (x + 1 < W) spread(i + W + 1, err, 1 / 16);
        }
      } else if (mode === 'atkinson') {
        const e8 = err / 8;
        if (x + 1 < W) spread(i + 1, e8, 1);
        if (x + 2 < W) spread(i + 2, e8, 1);
        if (y + 1 < H) {
          if (x > 0) spread(i + W - 1, e8, 1);
          spread(i + W, e8, 1);
          if (x + 1 < W) spread(i + W + 1, e8, 1);
        }
        if (y + 2 < H) spread(i + 2 * W, e8, 1);
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const v = lum[i] < 128 ? 0 : 255;
    d[p] = d[p + 1] = d[p + 2] = v;
    // Keep transparency (removed background); everything else becomes solid black or white
    d[p + 3] = d[p + 3] < 128 ? 0 : 255;
    if (d[p + 3] === 0 && v === 0) d[p + 3] = 255;
  }
}

// ---------------------------------------------------------------- tools for the image editor
/** Crop fractions [left, top, right, bottom] that cut away the plain border around the content */
export async function trimBounds(e) {
  const f = fxOf(e);
  const img = await loadImage(e.src);
  const turned = f.rot90 % 180 !== 0;
  const nw = turned ? img.naturalHeight : img.naturalWidth, nh = turned ? img.naturalWidth : img.naturalHeight;
  const s = Math.min(1, 600 / Math.max(nw, nh));
  const w = Math.max(1, Math.round(nw * s)), h = Math.max(1, Math.round(nh * s));
  const d = process(img, f, w, h).getContext('2d').getImageData(0, 0, w, h).data;
  const p0 = [d[0], d[1], d[2], d[3]];
  const plain = (i) => (d[i + 3] < 16 && p0[3] < 16) || (Math.abs(d[i] - p0[0]) + Math.abs(d[i + 1] - p0[1]) + Math.abs(d[i + 2] - p0[2]) < 40 && Math.abs(d[i + 3] - p0[3]) < 40);
  let x1 = w, y1 = h, x2 = -1, y2 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!plain((y * w + x) * 4)) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  if (x2 < 0) return [0, 0, 0, 0];
  return [x1 / w, y1 / h, (w - 1 - x2) / w, (h - 1 - y2) / h].map((v) => Math.max(0, Math.round(v * 1000) / 1000));
}

/** Colour of the processed-but-not-yet-thresholded picture at fraction (fx, fy) */
export async function pickColor(e, fx, fy) {
  const f = { ...fxOf(e), mode: 'auto', removeBg: false, invert: false };
  const img = await loadImage(e.src);
  const c = process(img, f, 400, 400);
  const p = c.getContext('2d').getImageData(Math.min(399, Math.floor(fx * 400)), Math.min(399, Math.floor(fy * 400)), 1, 1).data;
  return '#' + [p[0], p[1], p[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
}
