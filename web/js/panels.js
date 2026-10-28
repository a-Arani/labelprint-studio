// Text format bar, properties panel and variables panel
import { S, on, emit, snapshot, changed, byId, selected } from './state.js';
import {
  h, r2, cssFont, api, toast, pickFiles, fileToBase64, fileToDataURL, shrinkImage, uid, dims, clone, confirmBox,
  VAR_KINDS, varTypeName, newVariable, variableNames, formatDate, previewValues, fieldNames, localDigits,
} from './util.js';
import { ICONS } from './icons.js';
import { bbox } from './render.js';
import {
  mediaList, mediaById, matchMedia, fitsRoll, lastRoll, rememberRoll, openMediaManager, perPrint, rollGrid,
  gridOf, gridSize, cellOrigin, cellAt, isEach, showRow,
} from './media.js';
import { t, isRTL, lang } from './i18n.js';
import { openImageEditor, turnImage, mirrorImage, resetImage } from './imageeditor.js';
import { fxOf, isEdited, MODES } from './imagefx.js';

let editor;
let savedRange = null;

const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 54, 60, 72, 96];
const PRESETS = [[100, 50], [100, 25], [100, 75], [100, 100], [100, 150], [55, 50], [50, 25], [50, 30], [40, 30], [60, 40], [80, 50], [58, 40]];
const KEYWORD_PT = { 'xx-small': 7, 'x-small': 7.5, small: 10, medium: 12, large: 13.5, 'x-large': 18, 'xx-large': 24, 'xxx-large': 36 };
// Glyph samples shown next to font names (script samples, not translations)
const SAMPLE_ARABIC = '\u0627\u0628\u062c\u062f \u0647\u0648\u0632';
const SAMPLE_CJK = '\u4e2d\u6587\u5b57\u4f53';

const icon = (name) => h('span', { class: 'ico', html: ICONS[name] });
const listSep = () => t('common.listSep');

function iconBtn(name, title, onclick, extra = {}) {
  return h('button', {
    class: 'icon-btn' + (extra.class ? ' ' + extra.class : ''), title, 'aria-label': title, onclick,
    onmousedown: (e) => e.preventDefault(), 'data-k': extra.key,
  }, icon(name), extra.label ? h('span', { class: 'lbl' }, extra.label) : null);
}

// ================================================================= text formatting
function textTargets() {
  return selected().filter((e) => e.type === 'text' && !e.locked);
}

function editingNode() {
  return S.editingId ? editor.txNode(S.editingId) : null;
}

function restoreRange() {
  const node = editingNode();
  if (!node) return null;
  node.focus();
  if (savedRange && node.contains(savedRange.startContainer)) {
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(savedRange);
  }
  return node;
}

function hasTextSelection() {
  const node = editingNode();
  return !!(node && savedRange && !savedRange.collapsed && node.contains(savedRange.startContainer));
}

export function stripCss(html, props, tags = [], blockAttr = null) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  tpl.content.querySelectorAll('[style]').forEach((n) => {
    for (const p of props) n.style.removeProperty(p);
    if (!n.getAttribute('style')) n.removeAttribute('style');
  });
  for (const tag of tags) tpl.content.querySelectorAll(tag).forEach((n) => n.replaceWith(...n.childNodes));
  if (props.includes('color')) tpl.content.querySelectorAll('font[color]').forEach((n) => n.removeAttribute('color'));
  if (props.includes('font-family')) tpl.content.querySelectorAll('font[face]').forEach((n) => n.removeAttribute('face'));
  if (blockAttr) tpl.content.querySelectorAll('div[' + blockAttr + '],p[' + blockAttr + ']').forEach((n) => n.removeAttribute(blockAttr));
  return tpl.innerHTML;
}

function parsePt(v, base) {
  if (!v) return null;
  if (v in KEYWORD_PT) return (KEYWORD_PT[v] * base) / 12;
  const m = /^([\d.]+)(pt|px|em|%)?$/.exec(v.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return { pt: n, px: n * 0.75, em: n * base, '%': (n / 100) * base, undefined: n * 0.75 }[m[2]];
}

function scaleSizes(html, ratio, base) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  tpl.content.querySelectorAll('[style]').forEach((n) => {
    const v = parsePt(n.style.fontSize, base);
    if (v) n.style.fontSize = `${r2(v * ratio)}pt`;
  });
  return tpl.innerHTML;
}

function fixExecFontSize(node, pt) {
  node.querySelectorAll('font[size]').forEach((f) => {
    const s = document.createElement('span');
    s.style.fontSize = `${pt}pt`;
    s.append(...f.childNodes);
    f.replaceWith(s);
  });
  node.querySelectorAll('[style]').forEach((n) => {
    if (n.style.fontSize === 'xxx-large' || n.style.fontSize === '-webkit-xxx-large') n.style.fontSize = `${pt}pt`;
  });
}

function selectedBlocks(node) {
  const s = window.getSelection();
  if (!s.rangeCount) return [];
  const r = s.getRangeAt(0);
  const blocks = [...node.children].filter((b) => r.intersectsNode(b));
  return blocks.length ? blocks : [node];
}

export function applyText(prop, value) {
  if (hasTextSelection()) {
    const node = restoreRange();
    document.execCommand('styleWithCSS', false, true);
    const ex = (c, v) => document.execCommand(c, false, v);
    if (prop === 'font') { ex('fontName', value); rememberFont(value); }
    else if (prop === 'bold') ex('bold');
    else if (prop === 'italic') ex('italic');
    else if (prop === 'underline') ex('underline');
    else if (prop === 'color') ex('foreColor', value);
    else if (prop === 'size') { ex('fontSize', '7'); fixExecFontSize(node, value); }
    else if (prop === 'align') ex({ right: 'justifyRight', center: 'justifyCenter', left: 'justifyLeft', justify: 'justifyFull' }[value]);
    else if (prop === 'dir') {
      for (const b of selectedBlocks(node)) {
        if (b === node) { node.dir = value; continue; }
        b.dir = value;
        b.style.removeProperty('direction');
      }
    } else return applyElement(prop, value);
    // Formatting commands rewrite the DOM; keep the new selection
    const cur = window.getSelection();
    if (cur.rangeCount && node.contains(cur.anchorNode)) savedRange = cur.getRangeAt(0).cloneRange();
    const e = byId(S.editingId);
    e.html = node.innerHTML;
    S.dirty = true;
    changed('text');
    refreshFormat();
    return;
  }
  applyElement(prop, value);
}

function applyElement(prop, value) {
  if (S.editingId) editor.endEdit();
  const els = textTargets();
  if (!els.length) return;
  snapshot();
  for (const e of els) {
    switch (prop) {
      case 'font': e.font = value; e.html = stripCss(e.html, ['font-family']); rememberFont(value); break;
      case 'size': e.html = scaleSizes(e.html, value / (e.size || 12), e.size || 12); e.size = value; break;
      case 'bold': e.bold = value ?? !e.bold; e.html = stripCss(e.html, ['font-weight'], ['b', 'strong']); break;
      case 'italic': e.italic = value ?? !e.italic; e.html = stripCss(e.html, ['font-style'], ['i', 'em']); break;
      case 'underline': e.underline = value ?? !e.underline; e.html = stripCss(e.html, ['text-decoration'], ['u']); break;
      case 'color': e.color = value; e.html = stripCss(e.html, ['color']); break;
      case 'align': e.align = value; e.html = stripCss(e.html, ['text-align']); break;
      case 'dir': e.dir = value; e.html = stripCss(e.html, ['direction'], [], 'dir'); break;
      default: e[prop] = value;
    }
  }
  changed('fmt');
}

function rememberFont(name) {
  S.lastFont = name;
  let rec = [];
  try { rec = JSON.parse(localStorage.getItem('ls.recentFonts') || '[]'); } catch (e) { rec = []; }
  rec = [name, ...rec.filter((f) => f !== name)].slice(0, 6);
  try { localStorage.setItem('ls.recentFonts', JSON.stringify(rec)); } catch (e) { /* storage unavailable */ }
}

function recentFonts() {
  try { return JSON.parse(localStorage.getItem('ls.recentFonts') || '[]'); } catch (e) { return []; }
}

// Insert {variable} into the text or barcode
export function insertVariable(name) {
  const token = `{${name}}`;
  const isField = fieldNames(S.doc).includes(name);
  if (S.editingId) {
    restoreRange();
    document.execCommand('insertText', false, token);
    if (isField) byId(S.editingId).hideEmpty = true;
    return;
  }
  const sel = selected();
  if (sel.length === 1 && (sel[0].type === 'barcode' || sel[0].type === 'qr')) {
    snapshot();
    sel[0].value = token;
    if (isField) sel[0].hideEmpty = true;
    changed('var');
    return;
  }
  if (sel.length === 1 && sel[0].type === 'text') {
    if (isField) sel[0].hideEmpty = true;
    editor.startEdit(sel[0].id);
    const node = editingNode();
    const r = document.createRange();
    r.selectNodeContents(node.lastElementChild || node);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    document.execCommand('insertText', false, token);
    return;
  }
  const W = S.doc.page.w, H = S.doc.page.h;
  editor.addElement({
    id: uid(), type: 'text', x: r2(W / 2 - 20), y: r2(H / 2 - 5), w: 40, h: 10, rot: 0,
    html: `<div dir="auto">${token}</div>`, font: S.lastFont || 'Tahoma', size: 14, color: '#000000', bold: false,
    italic: false, underline: false, align: 'center', dir: 'auto', valign: 'middle', lineHeight: 0, letterSpacing: 0,
    pad: [0.5, 0.5, 0.5, 0.5], wrap: true, fit: false, fill: null, stroke: null, strokeW: 0.3, radius: 0, hideEmpty: isField,
  });
}

// ---------------------------------------------------------------- font picker
class FontPicker {
  constructor(onPick) {
    this.onPick = onPick;
    this.input = h('input', { class: 'inp fontpick-inp', spellcheck: false, 'aria-label': t('fmt.font') });
    this.list = h('div', { class: 'fontpick-list', hidden: true });
    this.el = h('div', { class: 'fontpick' }, this.input, h('span', { class: 'fontpick-caret', html: ICONS.chevron }), this.list);
    this.input.addEventListener('focus', () => { this.input.select(); this.open(''); });
    this.input.addEventListener('input', () => this.open(this.input.value));
    this.input.addEventListener('keydown', (e) => this.key(e));
    this.input.addEventListener('blur', () => setTimeout(() => this.close(), 150));
    this.idx = 0;
  }

  setValue(name) {
    this.value = name;
    this.input.value = name || '';
    this.input.style.fontFamily = cssFont(name);
    const missing = !!name && S.fontSet.size > 0 && !S.fontSet.has(name);
    this.input.classList.toggle('missing', missing);
    this.input.title = missing ? t('font.notInstalled') : '';
  }

  open(q) {
    q = (q || '').trim().toLowerCase();
    const items = [];
    const match = (f) => !q || f.toLowerCase().includes(q);
    const rec = recentFonts().filter((f) => S.fontSet.has(f) && match(f));
    if (!q && rec.length) {
      items.push({ head: t('font.recent') });
      for (const f of rec) {
        const info = S.fonts.find((x) => x.family === f) || {};
        items.push({ name: f, fa: info.fa, cjk: info.cjk });
      }
    }
    const groups = {
      arabic: [t('font.groupArabic'), S.fonts.filter((f) => f.fa && match(f.family))],
      cjk: [t('font.groupCjk'), S.fonts.filter((f) => f.cjk && !f.fa && match(f.family))],
      other: [t('font.groupOther'), S.fonts.filter((f) => !f.fa && !f.cjk && match(f.family))],
    };
    // Show the group that fits the UI language first
    const order = lang === 'fa' || lang === 'ar' ? ['arabic', 'other', 'cjk'] : lang === 'zh' ? ['cjk', 'other', 'arabic'] : ['other', 'arabic', 'cjk'];
    for (const g of order) {
      const [title, fonts] = groups[g];
      if (!fonts.length) continue;
      items.push({ head: title });
      for (const f of fonts) items.push({ name: f.family, fa: f.fa, cjk: f.cjk });
    }
    this.items = items.filter((i) => i.name);
    this.idx = 0;
    this.list.replaceChildren(...items.map((it) => (it.head ? h('div', { class: 'fp-head' }, it.head) : h('div', {
      class: 'fp-item', style: { fontFamily: cssFont(it.name) },
      onmousedown: (e) => { e.preventDefault(); this.pick(it.name); },
    }, h('span', {}, it.name), it.fa ? h('span', { class: 'fp-sample', dir: 'rtl' }, SAMPLE_ARABIC)
      : it.cjk ? h('span', { class: 'fp-sample' }, SAMPLE_CJK) : null))));
    const r = this.input.getBoundingClientRect();
    const left = isRTL() ? r.right - 300 : r.left;
    Object.assign(this.list.style, { top: r.bottom + 'px', left: Math.max(4, Math.min(left, innerWidth - 304)) + 'px' });
    this.list.hidden = false;
    this.mark();
  }

  mark() {
    const nodes = this.list.querySelectorAll('.fp-item');
    nodes.forEach((n, i) => n.classList.toggle('on', i === this.idx));
    if (nodes[this.idx]) nodes[this.idx].scrollIntoView({ block: 'nearest' });
  }

  key(e) {
    if (this.list.hidden) return;
    if (e.key === 'ArrowDown') { this.idx = Math.min(this.items.length - 1, this.idx + 1); this.mark(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { this.idx = Math.max(0, this.idx - 1); this.mark(); e.preventDefault(); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const it = this.items[this.idx];
      const typed = this.input.value.trim();
      this.pick(it ? it.name : typed);
    }
    if (e.key === 'Escape') { this.close(); this.input.blur(); }
  }

  pick(name) {
    if (!name) return;
    this.close();
    this.setValue(name);
    this.input.blur();
    this.onPick(name);
  }

  close() {
    this.list.hidden = true;
    this.setValue(this.value);
  }
}

// ---------------------------------------------------------------- format bar
let fmt = {};

function buildFormatBar(bar) {
  const fp = new FontPicker((name) => applyText('font', name));
  const size = h('input', { class: 'inp size-inp', type: 'number', step: '0.5', min: '2', max: '400', list: 'size-list', title: t('fmt.size'), 'aria-label': t('fmt.size') });
  const dl = h('datalist', { id: 'size-list' }, ...SIZES.map((s) => h('option', { value: s })));
  size.addEventListener('change', () => { const v = parseFloat(size.value); if (v > 0) applyText('size', v); });
  size.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); size.blur(); } });
  const grow = iconBtn('plus', t('fmt.bigger'), () => stepSize(1));
  const shrink = h('button', { class: 'icon-btn', title: t('fmt.smaller'), 'aria-label': t('fmt.smaller'), onmousedown: (e) => e.preventDefault(), onclick: () => stepSize(-1) }, h('span', { class: 'ico txt-ico' }, '−'));
  const toggle = (k, label, title, cls) => h('button', {
    class: 'icon-btn tbtn ' + cls, title, 'aria-label': title, onmousedown: (e) => e.preventDefault(),
    onclick: () => applyText(k, hasTextSelection() ? undefined : !(textTargets()[0] || {})[k]),
  }, label);
  const color = h('input', { type: 'color', class: 'color-inp', title: t('fmt.color'), 'aria-label': t('fmt.color') });
  color.addEventListener('change', () => applyText('color', color.value));
  const al = (v, ic, tip) => iconBtn(ic, tip, () => applyText('align', v), { key: 'align-' + v });
  const dirB = (v, ic, tip) => iconBtn(ic, tip, () => applyText('dir', v), { key: 'dir-' + v });
  const va = (v, ic, tip) => iconBtn(ic, tip, () => applyElement('valign', v), { key: 'valign-' + v });
  const varBtn = h('button', { class: 'btn btn-ghost var-btn', onmousedown: (e) => e.preventDefault(), onclick: (e) => varMenu(e.currentTarget) }, icon('vars'), h('span', {}, t('fmt.variable')));
  fmt = {
    fp, size, color,
    bold: toggle('bold', 'B', t('fmt.bold'), 'b'),
    italic: toggle('italic', 'I', t('fmt.italic'), 'i'),
    underline: toggle('underline', 'U', t('fmt.underline'), 'u'),
  };
  // Alignment buttons follow the reading direction of the UI
  const aligns = [al('left', 'alignLeft', t('fmt.alignLeft')), al('center', 'alignCenter', t('fmt.alignCenter')), al('right', 'alignRight', t('fmt.alignRight'))];
  if (isRTL()) aligns.reverse();
  bar.replaceChildren(
    h('div', { class: 'grp' }, fp.el, size, dl, grow, shrink),
    h('div', { class: 'grp' }, fmt.bold, fmt.italic, fmt.underline, h('label', { class: 'color-wrap', title: t('fmt.color') }, h('span', { class: 'txt-ico', style: { fontWeight: 700 } }, 'A'), color)),
    h('div', { class: 'grp' }, ...aligns, al('justify', 'alignJustify', t('fmt.justify'))),
    h('div', { class: 'grp' }, dirB('ltr', 'ltr', t('fmt.ltr')), dirB('rtl', 'rtl', t('fmt.rtl'))),
    h('div', { class: 'grp' }, va('top', 'vTop', t('fmt.top')), va('middle', 'vMiddle', t('fmt.middle')), va('bottom', 'vBottom', t('fmt.bottom'))),
    h('div', { class: 'grp' }, varBtn),
  );
}

function stepSize(dir) {
  const cur = parseFloat(fmt.size.value) || 12;
  let next;
  if (dir > 0) next = SIZES.find((s) => s > cur + 0.01) || cur + 4;
  else next = [...SIZES].reverse().find((s) => s < cur - 0.01) || Math.max(2, cur - 1);
  fmt.size.value = next;
  applyText('size', next);
}

function varMenu(anchor) {
  const names = S.doc ? variableNames(S.doc) : [];
  const menu = h('div', { class: 'menu' });
  if (!names.length) menu.append(h('div', { class: 'menu-empty' }, t('fmt.noVariables')));
  for (const n of names) menu.append(h('button', { class: 'menu-item', dir: 'auto', onmousedown: (e) => e.preventDefault(), onclick: () => { close(); insertVariable(n); } }, `{${n}}`));
  menu.append(h('div', { class: 'menu-sep' }));
  for (const type of VAR_KINDS) {
    menu.append(h('button', {
      class: 'menu-item', onmousedown: (e) => e.preventDefault(),
      onclick: () => { close(); const v = addVariable(type); if (v) insertVariable(v.name); },
    }, `+ ${varTypeName(type)}`));
  }
  const r = anchor.getBoundingClientRect();
  document.body.append(menu);
  const left = isRTL() ? r.right - menu.offsetWidth : r.left;
  Object.assign(menu.style, { top: r.bottom + 4 + 'px', left: Math.max(4, left) + 'px' });
  const close = () => { menu.remove(); document.removeEventListener('mousedown', outside, true); };
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('mousedown', outside, true));
}

export function refreshFormat() {
  if (!fmt.fp) return;
  const els = textTargets();
  const e = els[0];
  const bar = document.getElementById('formatbar');
  bar.classList.toggle('disabled', !e);
  if (!e) {
    fmt.fp.setValue(S.lastFont || '');
    return;
  }
  let font = e.font, size = e.size, bold = e.bold, italic = e.italic, underline = e.underline, color = e.color;
  const node = editingNode();
  const s = window.getSelection();
  if (node && s.rangeCount && node.contains(s.anchorNode)) {
    const at = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement;
    const cs = getComputedStyle(at);
    font = cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
    size = r2(parseFloat(cs.fontSize) * 0.75);
    bold = parseInt(cs.fontWeight, 10) >= 600;
    italic = cs.fontStyle === 'italic';
    underline = cs.textDecorationLine.includes('underline');
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(cs.color);
    if (m) color = '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('');
  }
  if (document.activeElement !== fmt.fp.input) fmt.fp.setValue(font);
  if (document.activeElement !== fmt.size) fmt.size.value = size;
  fmt.bold.classList.toggle('on', !!bold);
  fmt.italic.classList.toggle('on', !!italic);
  fmt.underline.classList.toggle('on', !!underline);
  fmt.color.value = /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#000000';
  bar.querySelectorAll('[data-k]').forEach((b) => {
    const [k, v] = b.dataset.k.split('-');
    b.classList.toggle('on', e[k] === v);
  });
}

// ================================================================= properties panel
function mutate(fn, what = 'prop') {
  snapshot();
  fn();
  changed(what);
}

function field(label, input, extra) {
  return h('label', { class: 'field' + (extra ? ' ' + extra : '') }, h('span', {}, label), input);
}

function num(key, value, onSet, { step = 0.1, min = null, max = null, suffix = '' } = {}) {
  const inp = h('input', { class: 'inp num', type: 'number', step, value: value ?? '', 'data-key': key });
  if (min !== null) inp.min = min;
  if (max !== null) inp.max = max;
  inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (!Number.isNaN(v)) onSet(v);
  });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  return suffix ? h('span', { class: 'num-wrap' }, inp, h('em', {}, suffix)) : inp;
}

function sel(key, value, options, onSet) {
  const s = h('select', { class: 'inp', 'data-key': key }, ...options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
  s.addEventListener('change', () => onSet(s.value));
  return s;
}

function check(label, value, onSet, key) {
  const c = h('input', { type: 'checkbox', checked: !!value, 'data-key': key });
  c.addEventListener('change', () => onSet(c.checked));
  return h('label', { class: 'check' }, c, h('span', {}, label));
}

function colorPick(key, value, onSet, allowNone = true) {
  const has = !!value;
  const c = h('input', { type: 'color', class: 'color-inp', value: has ? value : '#000000', 'data-key': key, disabled: !has && allowNone });
  const none = allowNone ? h('input', { type: 'checkbox', checked: has, title: t('props.enabled') }) : null;
  c.addEventListener('change', () => onSet(c.value));
  if (none) none.addEventListener('change', () => onSet(none.checked ? c.value : null));
  return h('span', { class: 'color-field' }, none, c);
}

function textInput(key, value, onSet, area = false) {
  const inp = h(area ? 'textarea' : 'input', { class: 'inp', 'data-key': key, dir: 'auto', rows: area ? 3 : null });
  inp.value = value ?? '';
  inp.addEventListener('change', () => onSet(inp.value));
  if (!area) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  return inp;
}

function section(title, ...kids) {
  return h('section', { class: 'psec' }, title ? h('h4', {}, title) : null, ...kids);
}

function row(...kids) {
  return h('div', { class: 'prow' }, ...kids);
}

const dashes = () => [['', t('dash.solid')], ['dash', t('dash.dash')], ['sysDot', t('dash.dot')], ['dashDot', t('dash.dashDot')]];

function geometry(e) {
  const set = (k) => (v) => mutate(() => { e[k] = r2(v); });
  if (e.type === 'line') {
    const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
    return section(t('props.position'),
      row(field('X1', num('x1', r2(e.x1), set('x1'))), field('Y1', num('y1', r2(e.y1), set('y1')))),
      row(field('X2', num('x2', r2(e.x2), set('x2'))), field('Y2', num('y2', r2(e.y2), set('y2')))),
      row(field(t('props.length'), num('len', r2(len), (v) => mutate(() => {
        const a = Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
        e.x2 = r2(e.x1 + Math.cos(a) * v); e.y2 = r2(e.y1 + Math.sin(a) * v);
      }), { min: 0.1 })), h('span')));
  }
  return section(t('props.posSize'),
    row(field('X', num('x', r2(e.x), set('x'))), field('Y', num('y', r2(e.y), set('y')))),
    row(field(t('props.width'), num('w', r2(e.w), set('w'), { min: 0.5 })), field(t('props.height'), num('h', r2(e.h), set('h'), { min: 0.5 }))),
    row(field(t('props.rotation'), num('rot', r2(e.rot || 0), (v) => mutate(() => { e.rot = r2(((v % 360) + 360) % 360); }), { step: 1, suffix: '°' })),
      h('div', { class: 'rot-quick' }, ...[0, 90, 180, 270].map((a) => h('button', { class: 'chip', onclick: () => mutate(() => { e.rot = a; }) }, a + '°')))));
}

function strokeRow(e) {
  return row(
    field(t('props.outline'), colorPick('stroke', e.stroke, (v) => mutate(() => { e.stroke = v; if (v && !e.strokeW) e.strokeW = 0.3; }))),
    field(t('props.thickness'), num('strokeW', e.strokeW || 0, (v) => mutate(() => { e.strokeW = Math.max(0, v); }), { step: 0.1, min: 0, suffix: 'mm' })),
  );
}

function typeProps(e) {
  const set = (k, fn = (v) => v) => (v) => mutate(() => { e[k] = fn(v); });
  const hideEmpty = () => check(t('props.hideEmpty'), e.hideEmpty, set('hideEmpty'), 'hideEmpty');
  switch (e.type) {
    case 'text': {
      const pad = e.pad || [0, 0, 0, 0];
      return section(t('type.text'),
        row(field(t('props.lineSpacing'), sel('lineHeight', e.lineHeight || 0, [[0, t('props.normal')], [0.8, '0.8'], [0.9, '0.9'], [1, '1'], [1.1, '1.1'], [1.2, '1.2'], [1.4, '1.4'], [1.6, '1.6'], [2, '2']], set('lineHeight', parseFloat))),
          field(t('props.letterSpacing'), num('letterSpacing', e.letterSpacing || 0, set('letterSpacing'), { step: 0.5, suffix: 'pt' }))),
        row(field(t('props.padding'), num('pad', r2(pad[0]), (v) => mutate(() => { e.pad = [v, v, v, v]; }), { min: 0, step: 0.5, suffix: 'mm' })),
          field(t('props.cornerRadius'), num('radius', e.radius || 0, set('radius'), { min: 0, step: 0.5, suffix: 'mm' }))),
        row(check(t('props.wrap'), e.wrap !== false, set('wrap'), 'wrap'), check(t('props.fit'), e.fit, set('fit'), 'fit')),
        hideEmpty(),
        row(field(t('props.background'), colorPick('fill', e.fill, set('fill'))), h('span')),
        strokeRow(e));
    }
    case 'shape':
      return section(t('type.shape'),
        row(field(t('props.kind'), sel('shape', e.shape, ['rect', 'ellipse', 'triangle', 'rtTriangle', 'diamond', 'hexagon', 'octagon'].map((k) => [k, t('shape.' + k)]), set('shape'))),
          field(t('props.cornerRadius'), num('radius', e.radius || 0, set('radius'), { min: 0, step: 0.5, suffix: 'mm' }))),
        row(field(t('props.fill'), colorPick('fill', e.fill, set('fill'))), field(t('props.dash'), sel('dash', e.dash || '', dashes(), set('dash', (v) => v || null)))),
        strokeRow(e));
    case 'line':
      return section(t('type.line'),
        row(field(t('props.color'), colorPick('stroke', e.stroke, set('stroke'), false)), field(t('props.thickness'), num('strokeW', e.strokeW, set('strokeW', (v) => Math.max(0.05, v)), { min: 0.05, step: 0.1, suffix: 'mm' }))),
        row(field(t('props.dash'), sel('dash', e.dash || '', dashes(), set('dash', (v) => v || null))), field(t('props.cap'), sel('cap', e.cap || 'butt', ['butt', 'round', 'square'].map((k) => [k, t('cap.' + k)]), set('cap')))));
    case 'image': {
      const f = fxOf(e);
      // Older labels keep "dither" as its own field; carry it over when the first new setting is made
      const setFx = (k) => (v) => mutate(() => { e.fx = { ...(e.dither && !e.fx ? { mode: 'fs' } : {}), ...(e.fx || {}), [k]: v }; delete e.dither; });
      const level = h('input', { type: 'range', min: 1, max: 254, step: 1, value: f.level, 'data-key': 'level', class: 'ie-range', title: t('img.level') });
      level.addEventListener('change', () => setFx('level')(Number(level.value)));
      const corner = e.mask === 'circle' ? 'circle' : e.radius ? 'round' : 'square';
      const setCorner = (v) => mutate(() => {
        delete e.mask;
        if (v === 'circle') { e.mask = 'circle'; delete e.radius; } else if (v === 'round') e.radius = e.radius || 2; else delete e.radius;
      });
      return section(t('type.image'),
        h('div', { class: 'prow prow-btn' },
          h('button', { class: 'btn btn-primary', onclick: () => openImageEditor(e) }, t('img.edit')),
          h('button', { class: 'btn', onclick: () => openImageEditor(e, { cropFirst: true }) }, icon('crop'), t('img.cropBtn'))),
        h('div', { class: 'btn-row' },
          iconBtn('rotL', t('img.rotateLeft'), () => mutate(() => turnImage(e, -1))),
          iconBtn('rotR', t('img.rotateRight'), () => mutate(() => turnImage(e, 1))),
          iconBtn('flipH', t('img.flipH'), () => mutate(() => mirrorImage(e, 'h'))),
          iconBtn('flipV', t('img.flipV'), () => mutate(() => mirrorImage(e, 'v')))),
        row(field(t('img.mode'), sel('mode', f.mode, MODES.map((m) => [m, t('img.mode.' + m)]), setFx('mode'))),
          f.mode !== 'auto' ? field(t('img.level'), level) : h('span')),
        row(check(t('props.invert'), e.invert, set('invert'), 'invert'), check(t('img.removeBg'), f.removeBg, setFx('removeBg'), 'removeBg')),
        row(field(t('props.imageFit'), sel('fit', e.fit || 'fill', ['fill', 'contain', 'cover'].map((k) => [k, t('fit.' + k)]), set('fit'))),
          field(t('img.corners'), sel('corner', corner, ['square', 'round', 'circle'].map((k) => [k, t('img.corner.' + k)]), setCorner))),
        corner === 'round' ? row(field(t('props.cornerRadius'), num('radius', e.radius, set('radius', (v) => Math.max(0.5, v)), { min: 0.5, step: 0.5, suffix: 'mm' })), h('span')) : null,
        row(h('button', { class: 'btn', onclick: () => replaceImage(e) }, t('props.replaceImage')),
          h('button', { class: 'btn btn-ghost', onclick: () => fixAspect(e) }, t('props.originalRatio'))),
        isEdited(e) || (e.crop || []).some((c) => c) ? h('button', { class: 'btn btn-ghost', onclick: () => mutate(() => resetImage(e)) }, t('img.resetEdits')) : null,
        strokeRow(e));
    }
    case 'barcode':
      return section(t('type.barcode'),
        field(t('props.value'), textInput('value', e.value, set('value'))),
        row(field(t('props.kind'), sel('format', e.format, [['CODE128', 'Code 128'], ['EAN13', 'EAN-13'], ['EAN8', 'EAN-8'], ['UPC', 'UPC-A'], ['CODE39', 'Code 39'], ['ITF', 'ITF'], ['ITF14', 'ITF-14'], ['codabar', 'Codabar']], set('format'))),
          field(t('props.color'), colorPick('color', e.color || '#000000', set('color'), false))),
        row(check(t('props.showText'), e.showText, set('showText'), 'showText'), field(t('props.textSize'), num('textSize', e.textSize || 8, set('textSize'), { min: 4, step: 0.5, suffix: 'pt' }))),
        hideEmpty());
    case 'qr':
      return section(t('type.qr'),
        field(t('props.qrText'), textInput('value', e.value, set('value'), true)),
        row(field(t('props.ecc'), sel('ecc', e.ecc || 'M', ['L', 'M', 'Q', 'H'].map((k) => [k, t('ecc.' + k)]), set('ecc'))),
          field(t('props.color'), colorPick('color', e.color || '#000000', set('color'), false))),
        hideEmpty());
    case 'path':
      return section(t('type.path'),
        row(field(t('props.color'), colorPick('stroke', e.stroke, set('stroke'), false)), field(t('props.thickness'), num('strokeW', e.strokeW, set('strokeW', (v) => Math.max(0.05, v)), { min: 0.05, step: 0.1, suffix: 'mm' }))));
    default: return null;
  }
}

async function replaceImage(e) {
  const [f] = await pickFiles({ accept: 'image/*' });
  if (!f) return;
  const img = await shrinkImage(await fileToDataURL(f));
  mutate(() => { e.src = img.src; e.crop = [0, 0, 0, 0]; e.h = r2((e.w * img.h) / img.w); });
}

function fixAspect(e) {
  const img = new Image();
  img.onload = () => {
    const c = e.crop || [0, 0, 0, 0];
    const turned = ((e.fx && e.fx.rot90) || 0) % 180 !== 0;
    const nw = turned ? img.naturalHeight : img.naturalWidth, nh = turned ? img.naturalWidth : img.naturalHeight;
    const ratio = (nh * (1 - c[1] - c[3])) / (nw * (1 - c[0] - c[2]));
    mutate(() => { e.h = r2(e.w * ratio); });
  };
  img.src = e.src;
}

function arrange(els) {
  const locked = els.every((e) => e.locked);
  const hAlign = [iconBtn('aLeft', t('align.left'), () => editor.align('left')), iconBtn('aHCenter', t('align.hcenter'), () => editor.align('hcenter')), iconBtn('aRight', t('align.right'), () => editor.align('right'))];
  if (isRTL()) hAlign.reverse();
  return section(t('arrange.title'),
    h('div', { class: 'btn-row' },
      iconBtn('front', t('arrange.front'), () => editor.order('front')),
      iconBtn('forward', t('arrange.forward'), () => editor.order('forward')),
      iconBtn('backward', t('arrange.backward'), () => editor.order('backward')),
      iconBtn('back', t('arrange.back'), () => editor.order('back'))),
    h('div', { class: 'btn-row' }, ...hAlign,
      iconBtn('aTop', t('align.top'), () => editor.align('top')),
      iconBtn('aVCenter', t('align.vcenter'), () => editor.align('vcenter')),
      iconBtn('aBottom', t('align.bottom'), () => editor.align('bottom'))),
    h('div', { class: 'btn-row wrap' },
      iconBtn(locked ? 'unlock' : 'lock', locked ? t('arrange.unlock') : t('arrange.lock'), () => mutate(() => { for (const e of els) e.locked = !locked; }), { label: locked ? t('arrange.unlock') : t('arrange.lock') }),
      iconBtn('dup', t('arrange.duplicateTip'), () => editor.duplicate(), { label: t('arrange.duplicate') }),
      iconBtn('trash', t('arrange.deleteTip'), () => editor.deleteSel(), { label: t('common.delete'), class: 'danger' })));
}

// ---------------------------------------------------------------- label, template/product and variables
function kindPanel() {
  const d = S.doc;
  const fieldsV = (d.variables || []).filter((v) => v.type === 'field');
  if (d.kind === 'product') {
    const inputs = fieldsV.map((v) => {
      const inp = h(v.multiline ? 'textarea' : 'input', { class: 'inp', dir: 'auto', 'data-key': 'f-' + v.name, rows: v.multiline ? 3 : null });
      inp.value = v.value ?? '';
      inp.addEventListener('change', () => mutate(() => { v.value = inp.value; }, 'vars'));
      if (!v.multiline) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
      return field(v.name, inp);
    });
    return section(t('product.specs'),
      h('div', { class: 'var-sample' }, t('product.fromTemplate', { name: (d.fromTemplate || {}).name || '?' })),
      ...inputs);
  }
  if (d.kind === 'template') {
    return section(t('template.title'),
      h('div', { class: 'var-sample' }, fieldsV.length ? t('template.fields', { list: fieldsV.map((v) => v.name).join(listSep()) }) : t('template.noFields')),
      h('div', { class: 'btn-row wrap' },
        h('button', { class: 'btn btn-primary', onclick: () => emit('product-new') }, t('template.newProduct')),
        h('button', { class: 'btn', onclick: () => emit('products-open') }, t('template.products'))),
      check(t('template.isTemplate'), true, () => mutate(() => { d.kind = 'label'; }, 'kind'), 'kind'));
  }
  return section(null, check(t('template.makeTemplate'), false,
    () => mutate(() => { d.kind = 'template'; delete d.fromTemplate; }, 'kind'), 'kind'));
}

// Scale every element by the same factor and centre it on the new page
export function scaleContent(doc, ow, oh, nw, nh) {
  const k = Math.min(nw / ow, nh / oh);
  if (!Number.isFinite(k) || (Math.abs(k - 1) < 1e-3 && Math.abs(nw - ow) < 0.01 && Math.abs(nh - oh) < 0.01)) return;
  const dx = (nw - ow * k) / 2, dy = (nh - oh * k) / 2;
  for (const e of doc.elements) {
    if (e.type === 'line') {
      e.x1 = r2(e.x1 * k + dx); e.y1 = r2(e.y1 * k + dy); e.x2 = r2(e.x2 * k + dx); e.y2 = r2(e.y2 * k + dy);
    } else {
      e.x = r2(e.x * k + dx); e.y = r2(e.y * k + dy); e.w = r2(e.w * k); e.h = r2(e.h * k);
    }
    if (e.strokeW) e.strokeW = r2(e.strokeW * k);
    if (e.radius) e.radius = r2(e.radius * k);
    if (e.type === 'text') {
      e.html = scaleSizes(e.html, k, e.size || 12);
      e.size = r2((e.size || 12) * k);
      e.pad = (e.pad || [0, 0, 0, 0]).map((v) => r2(v * k));
      if (e.letterSpacing) e.letterSpacing = r2(e.letterSpacing * k);
    }
    if (e.type === 'barcode' && e.textSize) e.textSize = r2(e.textSize * k);
  }
}

export const rotValue = (v) => (v === undefined || v === null || v === 0 ? 'auto' : String(v));
export const rotOptions = () => ['auto', 'auto180', '0', '90', '180', '270'].map((k) => [k, t('rot.' + k)]);

// Resize the label; with "scale content" on, the elements follow (one undo step)
function resizePage(w, hh, extra) {
  const p = S.doc.page;
  mutate(() => {
    const ow = p.w, oh = p.h;
    p.w = Math.max(5, r2(w));
    p.h = Math.max(5, r2(hh));
    if (extra) extra();
    if (S.scaleContent) scaleContent(S.doc, ow, oh, p.w, p.h);
  }, 'page');
}

// ---------- a whole print designed at once, every label different
function moveEl(e, dx, dy) {
  if (e.type === 'line') {
    e.x1 = r2(e.x1 + dx); e.y1 = r2(e.y1 + dy); e.x2 = r2(e.x2 + dx); e.y2 = r2(e.y2 + dy);
  } else {
    e.x = r2(e.x + dx); e.y = r2(e.y + dy);
  }
  return e;
}
const copyEl = (e, dx, dy) => moveEl({ ...clone(e), id: uid() }, dx, dy);

/** The elements sorted into the labels of grid g (in print order), by where their middle is */
function byCell(g) {
  const out = Array.from({ length: g.cols * g.rows }, () => []);
  for (const e of S.doc.elements) {
    const b = bbox(e);
    out[cellAt(g, b.x + b.w / 2, b.y + b.h / 2)].push(e);
  }
  return out;
}

/** Lay the design out for grid ng: every label keeps its content, a new label gets a copy of label 1 */
function regrid(og, ng) {
  const cells = byCell(og);
  const els = [];
  for (let k = 0; k < ng.cols * ng.rows; k++) {
    const to = cellOrigin(ng, k);
    if (k < cells.length) {
      const from = cellOrigin(og, k);
      for (const e of cells[k]) els.push(moveEl(e, to.x - from.x, to.y - from.y));
    } else {
      for (const e of cells[0]) els.push(copyEl(e, to.x, to.y));
    }
  }
  S.doc.elements = els;
}

const sameGrid = (a, b) => ['cols', 'rows', 'w', 'h', 'gx', 'gy'].every((k) => Math.abs((a[k] || 0) - (b[k] || 0)) < 0.01);

/** Same design on every label (one label to design), or every label different (the whole print to design) */
async function setAcross(each) {
  const p = S.doc.page, m = mediaById(p.mediaId);
  if (!m || perPrint(m) < 2 || each === isEach(p, m)) return;
  if (each) {
    const g = gridOf(m), size = gridSize(g);
    mutate(() => {
      // Every label starts as a copy of the one designed so far
      const one = S.doc.elements;
      const els = [...one];
      for (let k = 1; k < g.cols * g.rows; k++) {
        const o = cellOrigin(g, k);
        for (const e of one) els.push(copyEl(e, o.x, o.y));
      }
      S.doc.elements = els;
      Object.assign(p, { w: size.w, h: size.h, across: 'each', grid: g });
    }, 'page');
    return;
  }
  const g = p.grid || gridOf(m);
  const cells = byCell(g);
  if (cells.slice(1).some((c) => c.length) && !(await confirmBox(t('page.acrossSame'), t('page.acrossDrop'), t('common.ok')))) return;
  mutate(() => {
    S.doc.elements = cells[0];
    Object.assign(p, { w: g.w, h: g.h });
    delete p.across;
    delete p.grid;
  }, 'page');
}

/** Put a roll on the open label: the label gets the size of one of its labels (upright or turned as the design is),
 * or, designed as a whole print, the size of one print with every label's content in its place */
export function useRoll(id) {
  const p = S.doc && S.doc.page;
  const m = p && mediaById(id);
  if (!m) return;
  rememberRoll(id);
  if (p.across === 'each') {
    const og = p.grid || gridOf(m);
    if (perPrint(m) < 2) {
      mutate(() => {
        S.doc.elements = byCell(og)[0];
        Object.assign(p, { w: m.labelW, h: m.labelH, mediaId: id });
        delete p.across;
        delete p.grid;
      }, 'page');
      return;
    }
    const ng = gridOf(m), size = gridSize(ng);
    if (p.mediaId === id && sameGrid(og, ng) && Math.abs(p.w - size.w) < 0.01 && Math.abs(p.h - size.h) < 0.01) return;
    mutate(() => {
      regrid(og, ng);
      Object.assign(p, { w: size.w, h: size.h, grid: ng, mediaId: id });
    }, 'page');
    return;
  }
  const keepTurn = (p.w > p.h) !== (m.labelW > m.labelH) && Math.abs(m.labelW - m.labelH) > 0.6;
  const w = keepTurn ? m.labelH : m.labelW, hh = keepTurn ? m.labelW : m.labelH;
  if (p.mediaId === id && Math.abs(p.w - w) < 0.01 && Math.abs(p.h - hh) < 0.01) return;
  resizePage(w, hh, () => { p.mediaId = id; });
}

function pagePanel() {
  const p = S.doc.page;
  const setPage = (fn) => mutate(fn, 'page');
  const resize = resizePage;
  const preset = sel('preset', '', [['', t('page.presets')], ...PRESETS.map(([w, hh]) => [`${w}x${hh}`, dims(w, hh)])], (v) => {
    if (!v) return;
    const [w, hh] = v.split('x').map(Number);
    resize(w, hh);
  });
  const ms = mediaList();
  const m = ms.find((x) => x.id === p.mediaId);
  const each = isEach(p, m);
  const turned = m ? Math.abs(p.w - m.labelH) < 0.6 && Math.abs(p.h - m.labelW) < 0.6 && Math.abs(m.labelW - m.labelH) > 0.6 : false;
  const mediaSel = sel('media', m ? m.id : '', [['', t('page.manual')], ...ms.map((x) => [x.id, perPrint(x) > 1 ? `${x.name} (${rollGrid(x)})` : x.name])], (id) => {
    if (!id) { setPage(() => { delete p.mediaId; delete p.across; delete p.grid; }); return; }
    useRoll(id);
  });
  const orient = !each && m && Math.abs(m.labelW - m.labelH) > 0.6 ? field(t('page.orientOnRoll'), sel('orient', turned ? 'turned' : 'same',
    [['same', t('orient.same')], ['turned', t('orient.turned')]], (v) => resize(v === 'turned' ? m.labelH : m.labelW, v === 'turned' ? m.labelW : m.labelH))) : h('span');
  const scaleChk = check(t('page.scaleContent'), S.scaleContent, (v) => {
    S.scaleContent = v;
    try { localStorage.setItem('ls.scaleContent', v ? '1' : ''); } catch (e) { /* storage unavailable */ }
  }, 'scaleContent');
  const info = m ? [rollGrid(m) || null, t('page.rollInfo', { size: dims(m.labelW, m.labelH), width: m.linerW })].filter(Boolean).join(' · ') : null;
  // Several labels in each print: the same design on all of them, or each one different (designed together)
  const rowSize = m ? gridSize(gridOf(m)) : null;
  const across = m && perPrint(m) > 1 ? h('div', { class: 'across' },
    h('span', { class: 'across-t' }, t('page.across')),
    h('div', { class: 'seg' }, ...[[false, 'page.acrossSame'], [true, 'page.acrossEach']].map(([v, key]) => h('button', {
      class: 'seg-b' + (each === v ? ' on' : ''), type: 'button', 'aria-pressed': String(each === v), onclick: () => setAcross(v),
    }, t(key)))),
    each ? null : check(t('page.showRow'), showRow(), (v) => {
      try { localStorage.setItem('ls.showRow', v ? '1' : '0'); } catch (e) { /* storage unavailable */ }
      emit('change', 'view');
    }, 'showRow')) : null;
  const mismatch = !m ? null
    : each ? (Math.abs(p.w - rowSize.w) > 0.6 || Math.abs(p.h - rowSize.h) > 0.6
      ? h('div', { class: 'roll-mismatch' }, h('span', { class: 'err-text' }, t('page.rowMismatch', { size: dims(rowSize.w, rowSize.h) })),
        h('button', { class: 'chip', type: 'button', onclick: () => useRoll(m.id) }, t('page.useRollSize', { size: dims(rowSize.w, rowSize.h) }))) : null)
      // The label is not the size of one label of its roll (both are shown in millimetres)
      : !fitsRoll(p, m) ? h('div', { class: 'roll-mismatch' }, h('span', { class: 'err-text' }, t('page.rollMismatch', { size: dims(m.labelW, m.labelH) })),
        h('button', { class: 'chip', type: 'button', onclick: () => useRoll(m.id) }, t('page.useRollSize', { size: dims(m.labelW, m.labelH) }))) : null;
  return section(t('page.title'),
    h('div', { class: 'prow prow-btn' }, field(t('page.roll'), mediaSel), h('button', {
      class: 'btn btn-ghost', onclick: () => openMediaManager(p.mediaId || (matchMedia(p) || {}).id || lastRoll(), (id) => useRoll(id), { forLabel: true }),
    }, t('page.rollTypes'))),
    info ? h('div', { class: 'var-sample' }, info) : null,
    across,
    mismatch,
    // Designed as a whole print, the size comes from the roll
    each ? h('div', { class: 'var-sample' }, t('page.rowDesign', { size: dims(p.w, p.h) })) : null,
    each ? null : row(field(t('props.width'), num('pw', p.w, (v) => resize(v, p.h), { min: 5, step: 0.5, suffix: 'mm' })),
      field(t('props.height'), num('ph', p.h, (v) => resize(p.w, v), { min: 5, step: 0.5, suffix: 'mm' }))),
    each ? null : row(preset, h('button', { class: 'btn btn-ghost', title: t('page.swapTip'), onclick: () => resize(p.h, p.w) }, t('page.swap'))),
    each ? null : scaleChk,
    row(orient, field(t('page.printRotate'), sel('printRotate', rotValue(p.printRotate), each ? rotOptions().filter(([v]) => ['auto', 'auto180', '0', '180'].includes(v)) : rotOptions(), (v) => setPage(() => { p.printRotate = v; })))),
    row(check(t('page.showGrid'), S.grid.show, (v) => { S.grid.show = v; editor.drawOverlay(); }, 'gshow'),
      field(t('page.gridSize'), num('gsize', S.grid.size, (v) => { S.grid.size = Math.max(0.5, v); editor.drawOverlay(); }, { min: 0.5, step: 0.5, suffix: 'mm' }))),
  );
}

export function addVariable(type) {
  if (!S.doc) return null;
  const vars = S.doc.variables || (S.doc.variables = []);
  const v = newVariable(type, vars);
  mutate(() => vars.push(v), 'vars');
  return v;
}

const digitOptions = () => [['en', '123'], ['fa', localDigits('123', 'fa')], ['ar', localDigits('123', 'ar')]];

function varCard(v) {
  const set = (k, fn = (x) => x) => (x) => mutate(() => { v[k] = fn(x); }, 'vars');
  const rename = (x) => {
    const name = x.trim().replace(/[{}]/g, '');
    if (!name || name === v.name) return;
    const old = v.name;
    mutate(() => {
      v.name = name;
      // Use the new name in every text and barcode
      const re = new RegExp('\\{\\s*' + old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\}', 'g');
      for (const e of S.doc.elements) {
        if (e.html) e.html = e.html.replace(re, `{${name}}`);
        if (e.value) e.value = e.value.replace(re, `{${name}}`);
      }
    }, 'vars');
  };
  const body = [];
  if (v.type === 'field') {
    const isTpl = S.doc.kind === 'template';
    body.push(field(isTpl ? t('var.sampleValue') : t('var.value'), textInput('value', v.value, set('value'), !!v.multiline)));
    body.push(check(t('var.multiline'), v.multiline, set('multiline'), 'multiline'));
  } else if (v.type === 'counter') {
    body.push(row(field(t('var.start'), num('start', v.start, set('start'), { step: 1 })), field(t('var.step'), num('step', v.step, set('step'), { step: 1 }))));
    body.push(row(field(t('var.pad'), num('pad', v.pad || 0, set('pad', (x) => Math.max(0, Math.round(x))), { step: 1, min: 0 })), field(t('var.digits'), sel('digits', v.digits || 'en', digitOptions(), set('digits')))));
    body.push(row(field(t('var.prefix'), textInput('prefix', v.prefix, set('prefix'))), field(t('var.suffix'), textInput('suffix', v.suffix, set('suffix')))));
  } else if (v.type === 'date') {
    const now = new Date();
    const formats = ['yyyy/mm/dd', 'yyyy-mm-dd', 'dd/mm/yyyy', 'dd.mm.yyyy', 'mm/dd/yyyy', 'yy/mm/dd', 'yyyy/m/d', 'yyyy/mm']
      .map((f) => [f, formatDate(now, { calendar: v.calendar, format: f })]);
    body.push(row(field(t('var.calendar'), sel('calendar', v.calendar, ['gregorian', 'jalali', 'hijri'].map((k) => [k, t('cal.' + k)]), set('calendar'))),
      field(t('var.digits'), sel('digits', v.digits || 'en', digitOptions(), set('digits')))));
    body.push(row(field(t('var.format'), sel('format', v.format, formats, set('format'))),
      field(t('var.offset'), num('offset', v.offset || 0, set('offset', (x) => Math.round(x)), { step: 1 }))));
    body.push(h('div', { class: 'var-sample' }, t('var.today', { value: formatDate(new Date(Date.now() + (v.offset || 0) * 864e5), v) })));
  } else if (v.type === 'text') {
    body.push(field(t('var.value'), textInput('value', v.value, set('value'))));
    body.push(check(t('var.ask'), v.ask, set('ask'), 'ask'));
  } else if (v.type === 'list') {
    const ta = h('textarea', { class: 'inp', rows: 4, dir: 'auto', placeholder: t('var.listPlaceholder') });
    ta.value = (v.values || []).join('\n');
    ta.addEventListener('change', () => mutate(() => { v.values = ta.value.split('\n').map((s) => s.trim()).filter(Boolean); }, 'vars'));
    body.push(ta);
  }
  return h('div', { class: 'var-card' },
    h('div', { class: 'var-head' },
      h('span', { class: 'var-type' }, varTypeName(v.type)),
      textInput('name', v.name, rename),
      iconBtn('plus', t('var.insert'), () => insertVariable(v.name)),
      iconBtn('trash', t('var.delete'), () => mutate(() => { S.doc.variables = S.doc.variables.filter((x) => x !== v); }, 'vars'), { class: 'danger' })),
    ...body);
}

function varsPanel() {
  const vars = S.doc.variables || [];
  const data = S.doc.data;
  const add = h('div', { class: 'btn-row wrap' }, ...VAR_KINDS.map((type) => h('button', { class: 'chip', onclick: () => addVariable(type) }, '+ ' + varTypeName(type))));
  const table = h('div', { class: 'var-table' },
    data && data.rows && data.rows.length
      ? h('div', {}, h('div', { class: 'var-sample' }, t('vars.table', { rows: data.rows.length, cols: data.columns.map((c) => `{${c}}`).join(listSep()) })),
        h('div', { class: 'btn-row wrap' },
          ...data.columns.map((c) => h('button', { class: 'chip', dir: 'auto', onclick: () => insertVariable(c) }, `{${c}}`)),
          h('button', { class: 'chip danger', onclick: () => mutate(() => { delete S.doc.data; }, 'vars') }, t('vars.removeTable'))))
      : null,
    h('button', { class: 'btn btn-ghost', onclick: loadTable }, t('vars.loadTable')));
  const pv = S.preview ? previewValues(S.doc) : null;
  return section(t('vars.title'),
    ...vars.map(varCard), add, table,
    pv && Object.keys(pv).length ? h('div', { class: 'var-sample' }, t('vars.sample', { values: Object.entries(pv).map(([k, v]) => `${k}=${v}`).join(listSep()) })) : null);
}

async function loadTable() {
  const [f] = await pickFiles({ accept: '.xlsx,.csv,.txt' });
  if (!f) return;
  try {
    const tb = await api('/api/table', { filename: f.name, data: await fileToBase64(f) });
    if (!tb.rows.length) { toast(t('vars.tableEmpty'), 'warn'); return; }
    mutate(() => { S.doc.data = tb; }, 'vars');
    toast(t('vars.tableRead', { n: tb.rows.length }), 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function buildProps() {
  const panel = document.getElementById('props');
  const active = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  if (!S.doc) { panel.replaceChildren(); return; }
  const els = selected();
  const parts = [];
  if (!els.length) {
    parts.push(kindPanel(), pagePanel(), varsPanel());
  } else if (els.length === 1) {
    const e = els[0];
    parts.push(h('div', { class: 'ptitle' }, t('type.' + e.type), e.locked ? h('span', { class: 'badge' }, t('props.locked')) : null));
    parts.push(geometry(e), typeProps(e), arrange(els));
  } else {
    parts.push(h('div', { class: 'ptitle' }, t('props.selectedCount', { n: els.length })), arrange(els));
  }
  panel.replaceChildren(...parts.filter(Boolean));
  if (active) {
    const again = panel.querySelector(`[data-key="${active}"]`);
    if (again) again.focus();
  }
}

// Fast number updates while dragging
function liveGeometry(e) {
  const panel = document.getElementById('props');
  const setv = (k, v) => {
    const i = panel.querySelector(`[data-key="${k}"]`);
    if (i && document.activeElement !== i) i.value = r2(v);
  };
  if (!e) return;
  if (e.type === 'line') { setv('x1', e.x1); setv('y1', e.y1); setv('x2', e.x2); setv('y2', e.y2); setv('len', Math.hypot(e.x2 - e.x1, e.y2 - e.y1)); return; }
  setv('x', e.x); setv('y', e.y); setv('w', e.w); setv('h', e.h); setv('rot', e.rot || 0);
}

export function initPanels(ed) {
  editor = ed;
  buildFormatBar(document.getElementById('formatbar'));
  document.addEventListener('selectionchange', () => {
    const node = editingNode();
    const s = window.getSelection();
    // Only while the text itself has focus; when focus moves to the toolbar the old selection is kept
    if (node && s.rangeCount && node.contains(s.anchorNode) && node.contains(document.activeElement)) {
      savedRange = s.getRangeAt(0).cloneRange();
      refreshFormat();
    }
  });
  on('selection', () => { buildProps(); refreshFormat(); });
  on('change', (what) => {
    if (what === 'text') return;
    if (what === 'nudge-live') return;
    buildProps();
    refreshFormat();
  });
  on('live', liveGeometry);
  on('editing', () => { savedRange = null; refreshFormat(); });
  on('fonts', () => refreshFormat());
  on('image-edit', (e) => openImageEditor(e));
  // A roll was edited: the open label keeps the size of one label of its roll
  on('rolls-saved', (resized) => {
    if (!S.doc) return;
    if (resized.includes(S.doc.page.mediaId)) useRoll(S.doc.page.mediaId);
    emit('change', 'view');
  });
  on('focus-prop', () => {
    const i = document.querySelector('#props [data-key="value"]');
    if (i) { i.focus(); if (i.select) i.select(); }
  });
}

export { bbox, scaleSizes };
