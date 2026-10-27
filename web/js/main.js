// App start-up: top bar, tools, shortcuts, opening and saving labels, language and splash
import { S, on, emit, select, selected, setDoc, doUndo, doRedo, canUndo, canRedo } from './state.js';
import { h, api, toast, dialog, pickFiles, fileToDataURL, shrinkImage, uid, r2, PXMM, dims } from './util.js';
import { t, loadLang, detectLang, applyDom, isRTL, lang } from './i18n.js';
import { Editor } from './editor.js';
import { initPanels, applyText, refreshFormat } from './panels.js';
import { initLibrary, refresh as refreshLibrary, redrawLibrary, importFiles } from './library.js';
import { openPrint } from './print.js';
import { thumbnail } from './render.js';
import { ICONS } from './icons.js';
import { openHistory } from './history.js';
import { openLogs, openVersions, openBackup } from './support.js';
import { newProductDialog, openProducts, makeTemplateFrom, loadLabel } from './products.js';
import { openAbout, langMenu, appMeta } from './about.js';
import * as logger from './logger.js';
import { mediaById } from './media.js';
import { openPrinterControl } from './printercontrol.js';

const $ = (id) => document.getElementById(id);
let editor;
let saveTimer = null;
let saving = false;

// [tool, shortcut key]
const TOOLS = [['select', 'v'], ['text', 't'], ['rect', 'r'], ['ellipse', 'e'], ['line', 'l'], ['pen', 'p'], ['image', 'i'], ['barcode', 'b'], ['qr', 'q']];
const PRESETS = [[100, 50], [100, 25], [100, 75], [100, 100], [100, 150], [55, 50], [50, 25], [50, 30], [40, 30], [60, 40]];
const SPLASH_MIN_MS = 3000;
// This window, for the server: it stops when the last app window is closed
const CLIENT = uid();

const folderLabel = () => S.folder || t('lib.title');

// ---------------------------------------------------------------- document
function normalize(doc) {
  doc.version = doc.version || 1;
  doc.page = { w: 100, h: 50, printRotate: 'auto', bg: '#FFFFFF', ...(doc.page || {}) };
  doc.elements = (doc.elements || []).map((e) => ({ rot: 0, ...e, id: e.id || uid() }));
  doc.variables = doc.variables || [];
  doc.kind = doc.kind || 'label';
  return doc;
}

async function openFile(path, force = false) {
  if (S.path === path && !force) return;
  await flushSave();
  try {
    const doc = await api('/api/library/file?path=' + encodeURIComponent(path));
    setDoc(normalize(doc), path);
    logger.info(`Opened: ${path} (${doc.elements.length} elements, kind ${doc.kind})`);
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    S.folder = folder;
    redrawLibrary();
    requestAnimationFrame(() => editor.fit());
    const missing = (doc.meta?.fonts || []).filter((f) => S.fontSet.size && !S.fontSet.has(f));
    const used = new Set(doc.elements.filter((e) => e.type === 'text').map((e) => e.font));
    for (const f of used) if (f && S.fontSet.size && !S.fontSet.has(f) && !missing.includes(f)) missing.push(f);
    if (missing.length) toast(t('lib.missingFonts', { list: missing.join(t('common.listSep')) }), 'warn', 7000);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function newLabel() {
  await flushSave();
  const name = h('input', { class: 'inp', value: t('doc.newName'), dir: 'auto' });
  const w = h('input', { class: 'inp', type: 'number', value: 100, min: 5, step: 0.5 });
  const hh = h('input', { class: 'inp', type: 'number', value: 50, min: 5, step: 0.5 });
  const chips = h('div', { class: 'btn-row wrap' }, ...PRESETS.map(([pw, ph]) => h('button', {
    class: 'chip', type: 'button', onclick: () => { w.value = pw; hh.value = ph; },
  }, dims(pw, ph))));
  const ok = await dialog({
    title: t('doc.newTitle'),
    body: h('div', {},
      h('label', { class: 'field' }, h('span', {}, t('media.name')), name),
      h('div', { class: 'prow' }, h('label', { class: 'field' }, h('span', {}, t('doc.widthMm')), w), h('label', { class: 'field' }, h('span', {}, t('doc.heightMm')), hh)),
      chips,
      h('div', { class: 'muted' }, t('doc.folder', { name: folderLabel() }))),
    buttons: [{ label: t('doc.create'), value: true, primary: true }, { label: t('common.cancel'), value: false }],
  });
  if (!ok) return;
  const doc = normalize({ name: name.value.trim() || t('doc.newName'), page: { w: parseFloat(w.value) || 100, h: parseFloat(hh.value) || 50 } });
  try {
    const thumb = await thumbnail(doc);
    const { path, uid: newUid } = await api('/api/library/save', { path: (S.folder ? S.folder + '/' : '') + doc.name, label: doc, thumb, overwrite: false });
    doc.name = path.split('/').pop().replace(/\.lbl$/, '');
    doc.uid = newUid;
    logger.info(`New label: ${path} ${doc.page.w}x${doc.page.h}`);
    setDoc(doc, path);
    await refreshLibrary();
    requestAnimationFrame(() => editor.fit());
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function save(quiet = false) {
  if (!S.doc || !S.path) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (saving) { saveTimer = setTimeout(() => save(true), 400); return; }
  saving = true;
  setSaveState('saving');
  try {
    const doc = S.doc;
    const thumb = await thumbnail(doc);
    const res = await api('/api/library/save', { path: S.path, label: doc, thumb, overwrite: true, version: quiet ? 'auto' : 'force' });
    if (!doc.uid) doc.uid = res.uid;
    if (S.doc === doc) S.dirty = false;
    setSaveState('saved');
    if (!quiet) toast(t('save.saved'), 'ok', 1500);
    refreshLibrary();
  } catch (e) {
    setSaveState('error');
    toast(t('save.failed', { error: e.message }), 'error', 6000);
  } finally {
    saving = false;
  }
}

async function saveAs() {
  if (!S.doc) return;
  const name = h('input', { class: 'inp', dir: 'auto', value: (S.doc.name || t('print.untitled')) + t('media.copySuffix') });
  const ok = await dialog({
    title: t('save.asTitle'),
    body: h('div', {}, h('label', { class: 'field' }, h('span', {}, t('media.name')), name), h('div', { class: 'muted' }, t('doc.folder', { name: folderLabel() }))),
    buttons: [{ label: t('common.save'), value: true, primary: true }, { label: t('common.cancel'), value: false }],
  });
  if (!ok || !name.value.trim()) return;
  await flushSave();
  try {
    const thumb = await thumbnail(S.doc);
    const { path, uid: newUid } = await api('/api/library/save', { path: (S.folder ? S.folder + '/' : '') + name.value.trim(), label: { ...S.doc, uid: undefined }, thumb, overwrite: false });
    S.path = path;
    S.doc.uid = newUid;
    logger.info(`Saved as: ${path}`);
    S.doc.name = path.split('/').pop().replace(/\.lbl$/, '');
    S.dirty = false;
    emit('doc');
    setSaveState('saved');
    await refreshLibrary();
    toast(t('save.saved'), 'ok', 1500);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function flushSave() {
  if (saveTimer || (S.dirty && S.path)) await save(true);
}

function scheduleSave() {
  if (!S.path) return;
  setSaveState('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(true), 1500);
}

function closeDoc() {
  clearTimeout(saveTimer);
  saveTimer = null;
  setDoc(null, null);
}

function pathChanged(path) {
  S.path = path;
  if (S.doc) S.doc.name = path.split('/').pop().replace(/\.lbl$/, '');
  emit('doc');
}

function setSaveState(st) {
  const el = $('status-save');
  el.dataset.state = st;
  el.textContent = st ? t('save.state.' + st) : '';
}

function restored(label, path) {
  setDoc(normalize(label), path);
  refreshLibrary();
  requestAnimationFrame(() => editor.fit());
  save(true);
}

// ---------------------------------------------------------------- language
async function switchLang(code) {
  await flushSave();
  try { await api('/api/settings/set', { lang: code }); } catch (e) { toast(e.message, 'error'); return; }
  logger.info(`Language changed: ${lang} -> ${code}`);
  try {
    if (S.path) localStorage.setItem('ls.reopen', S.path);
    localStorage.setItem('ls.lang', code);
    sessionStorage.setItem('ls.splash', '1');
  } catch (e) { /* storage unavailable */ }
  location.reload();
}

function popupMenu(anchor, items) {
  const m = h('div', { class: 'menu' });
  for (const it of items) {
    if (it === '-') { m.append(h('div', { class: 'menu-sep' })); continue; }
    m.append(h('button', { class: 'menu-item', disabled: it.disabled, onclick: () => { close(); it.fn(); } }, it.label));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const left = isRTL() ? r.left : r.right - m.offsetWidth;
  Object.assign(m.style, { top: r.bottom + 4 + 'px', left: Math.min(Math.max(4, left), innerWidth - m.offsetWidth - 4) + 'px' });
  const close = () => { m.remove(); document.removeEventListener('mousedown', out, true); };
  const out = (e) => { if (!m.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('mousedown', out, true));
}

function moreMenu(anchor) {
  const openData = (sub) => () => api('/api/open-data', { sub }).catch((e) => toast(e.message, 'error'));
  popupMenu(anchor, [
    { label: t('more.versions'), fn: () => openVersions(restored), disabled: !S.doc },
    { label: t('backup.title'), fn: () => openBackup() },
    { label: t('logs.title'), fn: () => openLogs() },
    { label: t('more.openLibrary'), fn: openData('library') },
    { label: t('more.trash'), fn: openData('trash') },
    { label: t('pc.open'), fn: () => openPrinterControl() },
    '-',
    { label: t('lang.title') + '…', fn: () => langMenu(anchor, switchLang) },
    { label: t('more.about'), fn: () => openAbout(switchLang) },
  ]);
}

// ---------------------------------------------------------------- images and paste
async function insertImageFile(file) {
  if (!S.doc) return;
  const img = await shrinkImage(await fileToDataURL(file));
  const W = S.doc.page.w, H = S.doc.page.h;
  let w = W * 0.6, hh = (w * img.h) / img.w;
  if (hh > H * 0.85) { hh = H * 0.85; w = (hh * img.w) / img.h; }
  editor.addElement({
    id: uid(), type: 'image', x: r2((W - w) / 2), y: r2((H - hh) / 2), w: r2(w), h: r2(hh), rot: 0,
    src: img.src, fit: 'fill', crop: [0, 0, 0, 0], flipH: false, flipV: false, invert: false, dither: false,
    stroke: null, strokeW: 0,
  });
}

async function chooseImage() {
  const [f] = await pickFiles({ accept: 'image/*' });
  if (f) await insertImageFile(f);
}

function setTool(tool) {
  if (tool === 'image') { chooseImage(); tool = 'select'; }
  if (S.editingId && tool !== 'select') editor.endEdit();
  S.tool = tool;
  document.querySelectorAll('#tools [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
  $('workspace').dataset.tool = tool;
  $('pen-opts').hidden = tool !== 'pen';
}

// ---------------------------------------------------------------- chrome
function buildChrome() {
  const tb = (id, ic, title, fn, label) => {
    const b = $(id);
    b.innerHTML = ICONS[ic] + (label ? `<span class="lbl">${label}</span>` : '');
    b.title = title;
    b.setAttribute('aria-label', label || title);
    b.onclick = fn;
    b.onmousedown = (e) => e.preventDefault();
  };
  tb('btn-new', 'newDoc', t('tb.newTip'), newLabel, t('tb.new'));
  tb('btn-import', 'importFile', t('tb.importTip'), () => importFiles(false), t('tb.import'));
  tb('btn-save', 'save', t('tb.saveTip'), () => save(false), t('common.save'));
  tb('btn-saveas', 'saveAs', t('save.asTitle'), saveAs);
  tb('btn-undo', 'undo', t('tb.undo'), () => doUndo());
  tb('btn-redo', 'redo', t('tb.redo'), () => doRedo());
  tb('btn-zoomout', 'zoomOut', t('tb.zoomOut'), () => editor.setZoom(S.zoom / 1.25));
  tb('btn-zoomin', 'zoomIn', t('tb.zoomIn'), () => editor.setZoom(S.zoom * 1.25));
  tb('btn-fit', 'fit', t('tb.fit'), () => editor.fit());
  tb('btn-grid', 'grid', t('tb.grid'), () => { S.grid.show = !S.grid.show; $('btn-grid').classList.toggle('on', S.grid.show); editor.drawOverlay(); });
  tb('btn-preview', 'eye', t('tb.previewTip'), () => {
    S.preview = !S.preview;
    $('btn-preview').classList.toggle('on', S.preview);
    editor.render();
    emit('change', 'preview');
  }, t('tb.preview'));
  tb('btn-print', 'print', t('tb.printTip'), () => openPrint(), t('print.print'));
  tb('btn-history', 'history', t('lib.history'), () => openHistory(), t('tb.history'));
  tb('btn-lang', 'globe', t('lang.title'), (e) => langMenu(e.currentTarget, switchLang), lang.toUpperCase());
  tb('btn-more', 'more', t('tb.more'), (e) => moreMenu(e.currentTarget));
  $('brand').onclick = () => openAbout(switchLang);
  $('brand').title = t('more.about');

  const tools = $('tools');
  for (const [tool, key] of TOOLS) {
    const title = `${t('tool.' + tool)} (${key.toUpperCase()})`;
    tools.append(h('button', {
      class: 'tool' + (tool === 'select' ? ' on' : ''), 'data-tool': tool, title, 'aria-label': title, html: ICONS[tool],
      onclick: () => setTool(tool), onmousedown: (e) => e.preventDefault(),
    }));
  }
  const penColor = h('input', { type: 'color', value: S.pen.color, title: t('tool.penColor'), oninput: (e) => { S.pen.color = e.target.value; } });
  const penW = h('input', { type: 'range', min: 0.2, max: 4, step: 0.1, value: S.pen.width, title: t('tool.penWidth'), oninput: (e) => { S.pen.width = parseFloat(e.target.value); } });
  tools.append(h('div', { id: 'pen-opts', class: 'pen-opts', hidden: true }, penColor, penW));

  $('welcome-new').onclick = newLabel;
  $('welcome-import').onclick = () => importFiles(false);
  $('welcome-import-dir').onclick = () => importFiles(true);
}

function updateChrome() {
  const has = !!S.doc;
  document.body.classList.toggle('no-doc', !has);
  $('btn-undo').disabled = !canUndo();
  $('btn-redo').disabled = !canRedo();
  for (const id of ['btn-save', 'btn-saveas', 'btn-print', 'btn-zoomin', 'btn-zoomout', 'btn-fit', 'btn-preview', 'btn-grid']) $(id).disabled = !has;
  $('doc-title').textContent = has ? (S.doc.name || t('doc.untitled')) : '';
  $('doc-folder').textContent = has && S.path && S.path.includes('/') ? S.path.slice(0, S.path.lastIndexOf('/')) : '';
  document.title = has ? `${S.doc.name || t('doc.untitled')} — ${t('app.name')}` : t('app.name');
  if (has) {
    const p = S.doc.page;
    const media = mediaById(p.mediaId);
    const rot = { auto: '', auto180: t('rot.auto180'), 0: '', '0': '' }[p.printRotate] ?? `${p.printRotate}°`;
    $('status-size').textContent = `${dims(p.w, p.h)} mm` + (media ? ' · ' + t('status.roll', { name: media.name }) : '')
      + (rot ? ' · ' + t('status.printRot', { rot }) : '');
  } else {
    $('status-size').textContent = '';
    setSaveState('');
  }
  $('status-zoom').textContent = has ? Math.round(S.zoom * 100) + '%' : '';
}

function onKey(e) {
  const tg = e.target;
  const typing = tg.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tg.tagName);
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (document.querySelector('.dlg-back')) return;
  if (ctrl && (k === 's' || e.code === 'KeyS')) { e.preventDefault(); save(false); return; }
  if (ctrl && (k === 'p' || e.code === 'KeyP')) { e.preventDefault(); openPrint(); return; }
  if (S.editingId) {
    if (ctrl && ['KeyB', 'KeyI', 'KeyU'].includes(e.code)) {
      e.preventDefault();
      applyText({ KeyB: 'bold', KeyI: 'italic', KeyU: 'underline' }[e.code]);
    }
    return;
  }
  if (typing) return;
  if (ctrl) {
    const code = e.code;
    if (code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if (code === 'KeyY' || (code === 'KeyZ' && e.shiftKey)) { e.preventDefault(); doRedo(); }
    else if (code === 'KeyD') { e.preventDefault(); editor.duplicate(); }
    else if (code === 'KeyA') { e.preventDefault(); if (S.doc) editor.selectAll(); }
    else if (code === 'KeyN') { e.preventDefault(); newLabel(); }
    else if (code === 'Digit0') { e.preventDefault(); editor.fit(); }
    else if (code === 'Equal' || code === 'NumpadAdd') { e.preventDefault(); editor.setZoom(S.zoom * 1.25); }
    else if (code === 'Minus' || code === 'NumpadSubtract') { e.preventDefault(); editor.setZoom(S.zoom / 1.25); }
    else if (['KeyB', 'KeyI', 'KeyU'].includes(code)) { e.preventDefault(); applyText({ KeyB: 'bold', KeyI: 'italic', KeyU: 'underline' }[code]); }
    return;
  }
  if (!S.doc) return;
  if (k === 'delete' || k === 'backspace') { e.preventDefault(); editor.deleteSel(); return; }
  if (k.startsWith('arrow')) {
    e.preventDefault();
    const st = e.shiftKey ? 5 : 0.5;
    editor.nudge(k === 'arrowleft' ? -st : k === 'arrowright' ? st : 0, k === 'arrowup' ? -st : k === 'arrowdown' ? st : 0);
    return;
  }
  if (k === 'enter') {
    const s = selected();
    if (s.length === 1 && s[0].type === 'text') { e.preventDefault(); editor.startEdit(s[0].id); }
    return;
  }
  if (k === 'escape') {
    if (S.tool !== 'select') setTool('select'); else select([]);
    return;
  }
  // Shortcuts use the physical key, so they work with any keyboard layout
  const tool = TOOLS.find(([, key]) => key === e.code.replace('Key', '').toLowerCase());
  if (tool && !e.altKey) setTool(tool[0]);
}

function onCopy(e, cut) {
  const tg = e.target;
  if (S.editingId || tg.isContentEditable || ['INPUT', 'TEXTAREA'].includes(tg.tagName)) return;
  const els = selected();
  if (!els.length) return;
  e.preventDefault();
  e.clipboardData.setData('application/x-label-studio', JSON.stringify(els));
  e.clipboardData.setData('text/plain', els.map((x) => x.value || (x.html ? x.html.replace(/<[^>]+>/g, ' ') : '')).join('\n').trim());
  editor.copy();
  if (cut) editor.deleteSel();
}

async function onPaste(e) {
  const tg = e.target;
  if (!S.doc || S.editingId || tg.isContentEditable || ['INPUT', 'TEXTAREA'].includes(tg.tagName)) return;
  const dt = e.clipboardData;
  const own = dt.getData('application/x-label-studio');
  e.preventDefault();
  if (own) {
    try { editor.paste(JSON.parse(own)); return; } catch (err) { /* fall through to plain text */ }
  }
  const file = [...dt.files].find((f) => f.type.startsWith('image/'));
  if (file) { await insertImageFile(file); return; }
  const text = dt.getData('text/plain');
  if (text && text.trim()) {
    const W = S.doc.page.w, H = S.doc.page.h;
    editor.addElement({
      id: uid(), type: 'text', x: r2(W * 0.1), y: r2(H / 2 - 6), w: r2(W * 0.8), h: 12, rot: 0,
      html: text.trim().split('\n').map((l) => `<div dir="auto">${l.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) || '<br>'}</div>`).join(''),
      font: S.lastFont || 'Tahoma', size: 14, color: '#000000', bold: false, italic: false, underline: false,
      align: 'center', dir: 'auto', valign: 'middle', lineHeight: 0, letterSpacing: 0, pad: [0.5, 0.5, 0.5, 0.5],
      wrap: true, fit: false, fill: null, stroke: null, strokeW: 0.3, radius: 0,
    });
  }
}

// ---------------------------------------------------------------- splash
function hideSplash() {
  const sp = $('splash');
  if (!sp) return;
  const wait = Math.max(0, SPLASH_MIN_MS - performance.now());
  setTimeout(() => {
    sp.classList.add('gone');
    setTimeout(() => sp.remove(), 350);
    try { sessionStorage.setItem('ls.splash', '1'); } catch (e) { /* storage unavailable */ }
  }, document.documentElement.classList.contains('no-splash') ? 0 : wait);
}

// ---------------------------------------------------------------- start
async function boot() {
  const ping = () => api('/api/ping', { client: CLIENT }).catch(() => {});
  ping();
  setInterval(ping, 15000);
  window.addEventListener('pagehide', () => {
    try { navigator.sendBeacon('/api/bye', new Blob([JSON.stringify({ client: CLIENT })], { type: 'text/plain' })); } catch (e) { /* the server stops on its own */ }
  });
  try { S.settings = await api('/api/settings/get', {}); } catch (e) { S.settings = {}; }
  let stored = null;
  try { stored = localStorage.getItem('ls.lang'); } catch (e) { /* storage unavailable */ }
  await loadLang(S.settings.lang || stored || detectLang());
  applyDom(document);
  document.title = t('app.name');
  appMeta().then((m) => {
    if (m.version) $('status-version').textContent = t('status.version', { v: m.version });
    const sv = $('splash-version');
    if (sv && m.version) sv.textContent = 'v' + m.version;
  });

  buildChrome();
  editor = new Editor($('workspace'));
  window.labelEditor = editor;
  initPanels(editor);
  initLibrary({
    openFile, newLabel, closeDoc, pathChanged,
    historyFor: (item) => openHistory({ uid: item.uid, name: item.name, path: item.path }),
    versionsFor: async (path) => { await openFile(path); openVersions(restored); },
    newProduct: async (path) => {
      const tpl = S.path === path ? S.doc : await loadLabel(path);
      newProductDialog(tpl, path, (p) => { refreshLibrary(); if (p) openFile(p); });
    },
    openProducts: async (path) => {
      const tpl = S.path === path ? S.doc : await loadLabel(path);
      openProducts(tpl, path, openFile);
    },
    makeTemplate: async (path) => {
      try {
        const p = await makeTemplateFrom(path);
        await refreshLibrary();
        openFile(p);
        toast(t('template.made'), 'ok', 6000);
      } catch (e) { toast(e.message, 'error'); }
    },
  });
  on('product-new', async () => {
    await flushSave();
    newProductDialog(S.doc, S.path, (p) => { refreshLibrary(); if (p) openFile(p); });
  });
  on('products-open', async () => {
    await flushSave();
    openProducts(S.doc, S.path, openFile);
  });
  on('change', (what) => {
    updateChrome();
    if (what !== 'doc' && what !== 'preview' && S.dirty) scheduleSave();
  });
  on('doc', updateChrome);
  on('selection', updateChrome);
  on('zoom', updateChrome);
  on('tool', setTool);
  on('cursor', (p) => { $('status-pos').textContent = `${r2(p.x)} , ${r2(p.y)} mm`; });
  document.addEventListener('keydown', onKey);
  document.addEventListener('copy', (e) => onCopy(e, false));
  document.addEventListener('cut', (e) => onCopy(e, true));
  document.addEventListener('paste', onPaste);
  window.addEventListener('beforeunload', (e) => {
    if (saveTimer || saving) { save(true); e.preventDefault(); e.returnValue = ''; }
  });
  updateChrome();
  api('/api/fonts').then((r) => {
    S.fonts = r.fonts;
    S.fontSet = new Set(r.fonts.map((f) => f.family));
    emit('fonts');
    refreshFormat();
  }).catch(() => {});
  // After a language switch, reopen the label that was open
  let reopen = null;
  try { reopen = localStorage.getItem('ls.reopen'); localStorage.removeItem('ls.reopen'); } catch (e) { /* storage unavailable */ }
  if (reopen) openFile(reopen);
  hideSplash();
}

boot().catch((e) => {
  logger.error(`Start-up failed: ${e.message}`, { stack: e.stack });
  hideSplash();
});

export { PXMM };
