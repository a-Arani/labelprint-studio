// Templates and products: make each product label from a master label, product table and bulk creation from Excel
import { S, snapshot, changed } from './state.js';
import { h, api, toast, dialog, clone, pickFiles, fileToBase64, fieldNames, inFolder } from './util.js';
import { thumbnail } from './render.js';
import * as logger from './logger.js';
import { t } from './i18n.js';

const folderOf = (p) => (p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export async function loadLabel(path) {
  return api('/api/library/file?path=' + encodeURIComponent(path));
}

/** An independent copy of the template with the field values; returns {path, uid} */
export async function createProduct(template, values, folder) {
  const doc = clone(template);
  delete doc.uid;
  delete doc.meta;
  delete doc.saved;
  doc.kind = 'product';
  doc.fromTemplate = { uid: template.uid, name: template.name };
  for (const v of doc.variables || []) if (v.type === 'field') v.value = String(values[v.name] ?? '').trim();
  const first = fieldNames(template)[0];
  const name = String(values[first] ?? '').trim() || `${template.name} - ${t('product.default')}`;
  doc.name = name;
  const thumb = await thumbnail(doc);
  const res = await api('/api/library/save', { path: inFolder(folder, name), label: doc, thumb, overwrite: false });
  logger.info(`Product created: ${res.path} from template "${template.name}"`);
  return res;
}

/** Change field values of a saved product */
export async function updateProduct(path, changes) {
  if (S.path === path && S.doc) {
    // The label that is open: change it in the editor so autosave writes it
    snapshot();
    for (const v of S.doc.variables || []) if (v.type === 'field' && v.name in changes) v.value = changes[v.name];
    changed('vars');
    return;
  }
  const doc = await loadLabel(path);
  for (const v of doc.variables || []) if (v.type === 'field' && v.name in changes) v.value = changes[v.name];
  const thumb = await thumbnail(doc);
  await api('/api/library/save', { path, label: doc, thumb, overwrite: true });
}

function fieldInputs(template, values = {}) {
  const inputs = {};
  const rows = (template.variables || []).filter((v) => v.type === 'field').map((v) => {
    const inp = h(v.multiline ? 'textarea' : 'input', { class: 'inp', dir: 'auto', rows: v.multiline ? 3 : null });
    inp.value = values[v.name] ?? '';
    inp.placeholder = v.value || '';
    inputs[v.name] = inp;
    return h('label', { class: 'field' }, h('span', {}, v.name), inp);
  });
  return { inputs, rows };
}

/** "New product from this template" form; onDone(path) after the last product is made */
export async function newProductDialog(template, templatePath, onDone) {
  if (!fieldNames(template).length) {
    toast(t('product.noFields'), 'warn', 7000);
    return;
  }
  const { inputs, rows } = fieldInputs(template);
  const folder = h('input', { class: 'inp', value: folderOf(templatePath) });
  const made = h('div', { class: 'muted' });
  let last = null, count = 0;
  const values = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
  const make = async () => {
    const vals = values();
    if (!Object.values(vals).some((x) => x.trim())) { toast(t('product.enterDetails'), 'warn'); return false; }
    try {
      last = (await createProduct(template, vals, folder.value.trim())).path;
      count++;
      made.textContent = t('product.madeLast', { n: count, name: last.split('/').pop().replace(/\.lbl$/, '') });
      return true;
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
  };
  const res = await dialog({
    title: t('product.newTitle', { name: template.name }),
    body: h('div', {}, ...rows, h('label', { class: 'field' }, h('span', {}, t('hist.col.folder')), folder), made),
    buttons: [
      { label: t('product.createOpen'), primary: true, value: 'open', validate: () => { make().then((ok) => ok && closeFn('open')); return false; } },
      {
        label: t('product.createNext'), value: null, validate: () => {
          make().then((ok) => {
            if (!ok) return;
            for (const el of Object.values(inputs)) el.value = '';
            Object.values(inputs)[0]?.focus();
          });
          return false;
        },
      },
      { label: t('common.close'), value: 'close' },
    ],
    onOpen: (_b, close) => { closeFn = close; },
  });
  if (last && onDone) onDone(res === 'open' ? last : null, count);
}

let closeFn = () => {};

/** "Products of this template" table */
export async function openProducts(template, templatePath, openFile) {
  const fields = fieldNames(template);
  const box = h('div', { class: 'prod-wrap' });
  let closeDlg = () => {};
  const load = async () => {
    const rows = (await api('/api/products?template=' + encodeURIComponent(template.uid))).products;
    const head = h('tr', {}, h('th', {}, t('hist.col.label')), ...fields.map((f) => h('th', {}, f)), h('th', {}, t('hist.col.printed')), h('th', {}, t('hist.col.lastNumber')), h('th'));
    const body = rows.map((r) => h('tr', {},
      h('td', { class: 'prod-name', title: r.path }, r.name),
      ...fields.map((f) => {
        const inp = h('input', { class: 'cell', dir: 'auto', value: r.fields[f] ?? '' });
        inp.addEventListener('change', async () => {
          try {
            await updateProduct(r.path, { [f]: inp.value });
            inp.classList.add('saved');
            setTimeout(() => inp.classList.remove('saved'), 900);
          } catch (e) { toast(e.message, 'error'); }
        });
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
        return h('td', {}, inp);
      }),
      h('td', { class: 'num' }, String(r.printed || 0)),
      h('td', { class: 'num' }, Object.values(r.counters || {}).join(t('common.listSep')) || '—'),
      h('td', {}, h('button', { class: 'chip', onclick: () => { closeDlg(); openFile(r.path); } }, t('common.open')))));
    box.replaceChildren(
      rows.length ? h('div', { class: 'prod-scroll' }, h('table', { class: 'tbl prod-grid' }, h('thead', {}, head), h('tbody', {}, ...body)))
        : h('div', { class: 'muted' }, t('product.none')),
      h('div', { class: 'muted' }, t('product.count', { n: rows.length })));
  };
  const fromExcel = async () => {
    const [f] = await pickFiles({ accept: '.xlsx,.csv,.txt' });
    if (!f) return;
    let tb;
    try { tb = await api('/api/table', { filename: f.name, data: await fileToBase64(f) }); } catch (e) { toast(e.message, 'error'); return; }
    const map = fields.map((fl) => tb.columns.findIndex((c) => c.trim() === fl.trim()));
    if (map.every((i) => i < 0)) {
      toast(t('product.columnsMustMatch', { list: fields.join(t('common.listSep')) }), 'error', 9000);
      return;
    }
    const prog = toast(t('product.creating', { i: 0, n: tb.rows.length }), 'info', 600000);
    let ok = 0;
    for (const [i, row] of tb.rows.entries()) {
      prog.textContent = t('product.creating', { i: i + 1, n: tb.rows.length });
      const vals = Object.fromEntries(fields.map((fl, k) => [fl, map[k] >= 0 ? row[map[k]] : '']));
      try { await createProduct(template, vals, folderOf(templatePath)); ok++; } catch (e) { toast(e.message, 'error'); }
    }
    prog.remove();
    toast(t('product.made', { n: ok }), 'ok');
    await load();
  };
  await dialog({
    title: t('product.listTitle', { name: template.name }), wide: true,
    body: h('div', {},
      h('div', { class: 'btn-row wrap' },
        h('button', { class: 'btn btn-primary', onclick: () => newProductDialog(template, templatePath, () => load()) }, t('product.new')),
        h('button', { class: 'btn', onclick: fromExcel }, t('product.fromExcel')),
        h('span', { class: 'muted' }, t('product.fileColumns', { list: fields.join(t('common.listSep')) || '—' }))),
      box),
    buttons: [{ label: t('common.close'), value: null }],
    onOpen: (_b, close) => { closeDlg = close; load().catch((e) => toast(e.message, 'error')); },
  });
}

/** "Make a template from this label": copy the label as a template in the same folder */
export async function makeTemplateFrom(path) {
  const doc = await loadLabel(path);
  const tpl = clone(doc);
  delete tpl.uid;
  delete tpl.fromTemplate;
  tpl.kind = 'template';
  tpl.name = `${doc.name} (${t('lib.template')})`;
  const thumb = await thumbnail(tpl);
  const res = await api('/api/library/save', { path: inFolder(folderOf(path), tpl.name), label: tpl, thumb, overwrite: false });
  logger.info(`Template created: ${res.path} from ${path}`);
  return res.path;
}
