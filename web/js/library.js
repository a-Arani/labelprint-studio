// Label library: folder tree, open, Word/PowerPoint import, rename, move, delete
import { S, emit, on } from './state.js';
import { h, api, toast, askText, confirmBox, pickFiles, fileToBase64, inFolder } from './util.js';
import { thumbnail } from './render.js';
import { ICONS } from './icons.js';
import { t } from './i18n.js';

let app;
let tree = null;
let query = '';
const open = new Set(JSON.parse(localStorageGet('ls.openFolders') || '[""]'));

function localStorageGet(k) {
  try { return localStorage.getItem(k); } catch (e) { return null; }
}

function saveOpen() {
  try { localStorage.setItem('ls.openFolders', JSON.stringify([...open])); } catch (e) { /* storage unavailable */ }
}

const icon = (n) => h('span', { class: 'ico', html: ICONS[n] });
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export async function refresh() {
  try {
    tree = await api('/api/library/tree');
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  draw();
}

function matches(file) {
  return !query || file.name.toLowerCase().includes(query) || file.path.toLowerCase().includes(query);
}

function folderHas(node) {
  return node.files.some(matches) || node.folders.some(folderHas);
}

function draw() {
  const box = document.getElementById('lib-tree');
  if (!tree) return;
  const out = [];
  const walk = (node, depth) => {
    const isRoot = node.path === '';
    const expanded = query ? true : open.has(node.path);
    if (!isRoot) {
      if (query && !folderHas(node)) return;
      out.push(h('div', {
        class: 'lib-row lib-folder' + (S.folder === node.path ? ' active' : ''),
        style: { paddingInlineStart: 6 + depth * 14 + 'px' },
        draggable: true, 'data-path': node.path, 'data-kind': 'folder',
        onclick: () => {
          S.folder = node.path;
          if (open.has(node.path)) open.delete(node.path); else open.add(node.path);
          saveOpen();
          draw();
        },
        oncontextmenu: (e) => menu(e, node, 'folder'),
      }, h('span', { class: 'caret' + (expanded ? ' open' : '') }, '▸'), icon('folder'), h('span', { class: 'nm' }, h('bdi', {}, node.name)),
      node.printed ? h('span', { class: 'cnt', title: t('lib.folderPrinted', { n: node.printed }) }, String(node.printed)) : null));
    }
    if (!expanded && !isRoot) return;
    for (const f of node.folders) walk(f, isRoot ? 0 : depth + 1);
    for (const f of node.files) {
      if (!matches(f)) continue;
      out.push(h('div', {
        class: 'lib-row lib-file' + (S.path === f.path ? ' current' : ''),
        style: { paddingInlineStart: 8 + (isRoot ? 0 : depth + 1) * 14 + 'px' },
        draggable: true, 'data-path': f.path, 'data-kind': 'file', title: f.path,
        onclick: () => app.openFile(f.path),
        oncontextmenu: (e) => menu(e, f, 'file'),
      }, f.thumb
        ? h('img', { class: 'thumb', loading: 'lazy', src: `/api/library/thumb?path=${encodeURIComponent(f.path)}&t=${f.mtime}` })
        : h('span', { class: 'thumb empty' }, icon('file')),
      // <bdi>: each name keeps its own direction, so "50×100" never reads backwards in a right-to-left interface
      h('span', { class: 'nm' }, h('bdi', {}, f.name)),
      f.kind === 'template' ? h('span', { class: 'pill', title: t('lib.templateTip') }, t('lib.template')) : null,
      f.printed ? h('span', {
        class: 'cnt', title: t('lib.printed', { n: f.printed }) + Object.entries(f.counters || {}).map(([k, v]) => ' — ' + t('lib.lastCounter', { name: k, value: v })).join(''),
      }, String(f.printed)) : null));
    }
  };
  walk(tree, 0);
  if (!out.length) out.push(h('div', { class: 'lib-empty' }, query ? t('lib.noMatch') : t('lib.empty')));
  box.replaceChildren(...out);
  document.getElementById('lib-root').classList.toggle('active', S.folder === '');
}

function menu(ev, item, kind) {
  ev.preventDefault();
  const m = h('div', { class: 'menu' });
  const add = (label, fn, danger) => m.append(h('button', { class: 'menu-item' + (danger ? ' danger' : ''), onclick: () => { close(); fn(); } }, label));
  if (kind === 'file') {
    add(t('common.open'), () => app.openFile(item.path));
    add(t('lib.history'), () => app.historyFor(item));
    add(t('lib.versions'), () => app.versionsFor(item.path));
    if (item.kind === 'template') {
      add(t('lib.newProduct'), () => app.newProduct(item.path));
      add(t('lib.products'), () => app.openProducts(item.path));
    } else {
      add(t('lib.makeTemplate'), () => app.makeTemplate(item.path));
    }
    add(t('common.rename'), () => rename(item, kind));
    add(t('common.copy'), () => copy(item));
    add(t('common.delete'), () => remove(item, kind), true);
  } else {
    add(t('lib.newLabelHere'), () => { S.folder = item.path; app.newLabel(); });
    add(t('lib.newFolderHere'), () => newFolder(item.path));
    add(t('lib.importHere'), () => { S.folder = item.path; importFiles(); });
    add(t('common.rename'), () => rename(item, kind));
    add(t('common.copy'), () => copy(item));
    add(t('common.delete'), () => remove(item, kind), true);
  }
  Object.assign(m.style, { top: ev.clientY + 'px', left: ev.clientX + 'px' });
  document.body.append(m);
  const r = m.getBoundingClientRect();
  if (r.bottom > innerHeight) m.style.top = Math.max(0, innerHeight - r.height - 8) + 'px';
  if (r.right > innerWidth) m.style.left = Math.max(0, innerWidth - r.width - 8) + 'px';
  const close = () => { m.remove(); document.removeEventListener('mousedown', out, true); };
  const out = (e) => { if (!m.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('mousedown', out, true));
}

async function rename(item, kind) {
  const name = await askText(kind === 'file' ? t('lib.renameLabel') : t('lib.renameFolder'), item.name);
  if (!name || name === item.name) return;
  try {
    const { path } = await api('/api/library/rename', { path: item.path, name });
    if (kind === 'file' && S.path === item.path) app.pathChanged(path, name);
    if (kind === 'folder' && S.path && S.path.startsWith(item.path + '/')) app.pathChanged(path + S.path.slice(item.path.length));
    if (kind === 'folder' && open.has(item.path)) { open.delete(item.path); open.add(path); saveOpen(); }
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
}

async function copy(item) {
  try {
    await api('/api/library/copy', { path: item.path });
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
}

async function remove(item, kind) {
  const ok = await confirmBox(t('common.delete'), kind === 'file'
    ? t('lib.deleteLabel', { name: item.name })
    : t('lib.deleteFolder', { name: item.name }), t('common.delete'), true);
  if (!ok) return;
  try {
    await api('/api/library/delete', { path: item.path });
    if (S.path && (S.path === item.path || S.path.startsWith(item.path + '/'))) app.closeDoc();
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
}

async function newFolder(parent = S.folder) {
  const name = await askText(t('lib.newFolder'), '', t('lib.folderName'));
  if (!name) return;
  try {
    const { path } = await api('/api/library/mkdir', { path: inFolder(parent, name) });
    open.add(parent);
    open.add(path);
    saveOpen();
    S.folder = path;
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
}

async function move(path, dest) {
  if (path === dest || parentOf(path) === dest) return;
  try {
    const res = await api('/api/library/move', { path, dest });
    if (S.path === path) app.pathChanged(res.path);
    else if (S.path && S.path.startsWith(path + '/')) app.pathChanged(res.path + S.path.slice(path.length));
    open.add(dest);
    saveOpen();
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------------------------------------------------------------- import
export async function importFiles(directory = false) {
  const files = (await pickFiles({ accept: '.docx,.pptx', multiple: true, directory }))
    .filter((f) => /\.(docx|pptx)$/i.test(f.name) && !f.name.startsWith('~$'));
  if (!files.length) {
    if (directory) toast(t('lib.noOfficeFiles'), 'warn');
    return;
  }
  await importList(files.map((f) => ({ file: f, rel: directory ? (f.webkitRelativePath || f.name) : f.name })));
}

async function importList(items) {
  const base = S.folder;
  const prog = toast(t('lib.importing', { i: 0, n: items.length, name: '' }), 'info', 600000);
  const missing = new Set();
  let ok = 0, lastPath = null;
  const failed = [];
  for (let i = 0; i < items.length; i++) {
    const { file, rel } = items[i];
    prog.textContent = t('lib.importing', { i: i + 1, n: items.length, name: file.name });
    try {
      const res = await api('/api/import', { filename: file.name, data: await fileToBase64(file) });
      const sub = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      const folder = [base, sub].filter(Boolean).join('/');
      for (const label of res.labels) {
        for (const f of label.meta?.fonts || []) if (S.fontSet.size && !S.fontSet.has(f)) missing.add(f);
        const thumb = await thumbnail(label);
        const saved = await api('/api/library/save', {
          path: (folder ? folder + '/' : '') + label.name, label, thumb, overwrite: false,
        });
        lastPath = saved.path;
        const parts = saved.path.split('/');
        for (let j = 1; j < parts.length; j++) open.add(parts.slice(0, j).join('/'));
      }
      ok++;
    } catch (e) {
      failed.push(`${file.name}: ${e.message}`);
    }
  }
  prog.remove();
  saveOpen();
  await refresh();
  if (ok) toast(t('lib.imported', { n: ok }), 'ok');
  if (failed.length) toast(t('lib.importFailed') + ' ' + failed.slice(0, 3).join(' | ') + (failed.length > 3 ? ' …' : ''), 'error', 8000);
  if (missing.size) toast(t('lib.missingFonts', { list: [...missing].join(t('common.listSep')) }), 'warn', 9000);
  if (items.length === 1 && lastPath) app.openFile(lastPath);
}

// ---------------------------------------------------------------- setup
export function initLibrary(appApi) {
  app = appApi;
  const pane = document.getElementById('library');
  pane.querySelector('#lib-new-folder').onclick = () => newFolder();
  pane.querySelector('#lib-import').onclick = () => importFiles(false);
  pane.querySelector('#lib-import-dir').onclick = () => importFiles(true);
  pane.querySelector('#lib-new').onclick = () => app.newLabel();
  const search = pane.querySelector('#lib-search');
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); draw(); });
  const root = pane.querySelector('#lib-root');
  root.onclick = () => { S.folder = ''; draw(); };

  // Drag and drop onto folders
  let dragPath = null;
  pane.addEventListener('dragstart', (e) => {
    const r = e.target.closest('[data-path]');
    if (!r) return;
    dragPath = r.dataset.path;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragPath);
  });
  pane.addEventListener('dragover', (e) => {
    const tgt = e.target.closest('.lib-folder, #lib-root');
    if (!dragPath && !(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    pane.querySelectorAll('.drop').forEach((n) => n.classList.remove('drop'));
    if (tgt) tgt.classList.add('drop');
  });
  pane.addEventListener('dragleave', (e) => {
    const tgt = e.target.closest('.lib-folder, #lib-root');
    if (tgt) tgt.classList.remove('drop');
  });
  pane.addEventListener('drop', async (e) => {
    e.preventDefault();
    pane.querySelectorAll('.drop').forEach((n) => n.classList.remove('drop'));
    const tgt = e.target.closest('.lib-folder, #lib-root');
    const dest = tgt ? (tgt.dataset.path || '') : S.folder;
    if (dragPath) {
      const p = dragPath;
      dragPath = null;
      await move(p, dest);
      return;
    }
    const files = [...(e.dataTransfer.files || [])].filter((f) => /\.(docx|pptx)$/i.test(f.name));
    if (files.length) {
      S.folder = dest;
      await importList(files.map((f) => ({ file: f, rel: f.name })));
    }
  });
  pane.addEventListener('dragend', () => { dragPath = null; });
  on('doc', draw);
  on('printed', () => refresh());
  refresh();
}

export function currentFolderName() {
  return S.folder || t('lib.title');
}

export { draw as redrawLibrary, emit };
