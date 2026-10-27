// "Print history" dialog: one label (jobs, ranges, correcting the last number) and all labels (totals per label and folder)
import { S } from './state.js';
import { h, api, toast, dialog, askText, formatDateTime, ltr } from './util.js';
import { openPrint } from './print.js';
import { t } from './i18n.js';

const STATUS_CLASS = { ok: 'st-ok', partial: 'st-warn', error: 'st-err', cancelled: 'st-muted', running: 'st-warn' };

const range = (a, b) => ltr(a === b ? `${a}` : `${a}–${b}`);
const rangesText = (rs) => (rs || []).map(([a, b]) => range(a, b)).join(t('common.listSep')) || '—';

function jobRange(j) {
  if (j.counter && j.c_from !== null) {
    if (j.sent_to === null || j.sent_to === undefined) return t('hist.nothingSent', { range: range(j.c_from, j.c_to) });
    return j.sent_to === j.c_to ? range(j.c_from, j.c_to) : t('hist.partOf', { sent: range(j.c_from, j.sent_to), range: range(j.c_from, j.c_to) });
  }
  if (j.rows_from) return t('hist.rows', { range: range(j.rows_from, j.rows_to) });
  return '—';
}

const statusBadge = (st) => h('span', { class: `st ${STATUS_CLASS[st] || ''}` }, STATUS_CLASS[st] ? t('hist.status.' + st) : st);

const folderOf = (p) => (p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : t('lib.title'));

const sentOf = (j) => t('hist.sentOf', { sent: j.sent, planned: j.planned });

function table(head, rows) {
  return h('table', { class: 'tbl' },
    h('thead', {}, h('tr', {}, ...head.map((x) => h('th', {}, x)))),
    h('tbody', {}, ...rows));
}

async function labelTab(box, target, close) {
  box.replaceChildren(h('div', { class: 'muted' }, t('common.loading')));
  const res = await api('/api/history/label?uid=' + encodeURIComponent(target.uid));
  const sm = res.summary;
  const isOpen = S.doc && S.doc.uid === target.uid;
  const counterRows = Object.entries(sm.counters).map(([name, c]) => h('div', { class: 'hist-counter' },
    h('b', {}, name), ' — ' + t('hist.lastNumber') + ' ', h('b', { class: 'num' }, String(c.last ?? '—')),
    h('span', { class: 'muted' }, ` (${formatDateTime(c.updated)})`),
    h('button', {
      class: 'chip', onclick: async () => {
        const v = await askText(t('hist.correctTitle', { name }), String(c.last ?? ''), t('hist.correctHint'));
        if (v === null || v === '' || Number.isNaN(Number(v))) return;
        const note = await askText(t('hist.note'), '') || '';
        await api('/api/history/adjust', { uid: target.uid, counter: name, value: Number(v), note });
        toast(t('hist.corrected'), 'ok');
        labelTab(box, target, close);
      },
    }, t('hist.correct')),
    h('div', { class: 'muted' }, t('hist.printedRanges') + ' ', rangesText(sm.ranges[name]))));
  const rows = res.jobs.map((j) => h('tr', {},
    h('td', { class: 'num' }, formatDateTime(j.started)),
    h('td', {}, jobRange(j)),
    h('td', {}, sentOf(j)),
    h('td', {}, j.printer || ''),
    h('td', {}, statusBadge(j.status), j.error ? h('div', { class: 'err-text' }, j.error) : null),
    h('td', {}, isOpen && j.counter && j.c_from !== null ? h('button', {
      class: 'chip', onclick: () => { close(); openPrint({ from: j.c_from, to: j.sent_to ?? j.c_to }); },
    }, t('print.reprint')) : null)));
  const adj = res.adjustments.map((a) => h('div', { class: 'muted' },
    `${formatDateTime(a.ts)}: ` + t('hist.adjusted', { name: a.counter, old: a.old ?? '—', value: a.new }) + (a.note ? ` (${a.note})` : '')));
  box.replaceChildren(...[
    h('div', { class: 'hist-head' }, h('b', {}, target.name || ''),
      h('span', {}, ' — ' + t('hist.labelTotal', { n: sm.sent, jobs: sm.jobs })),
      sm.lastPrint ? h('span', { class: 'muted' }, ' — ' + t('hist.lastPrint', { when: formatDateTime(sm.lastPrint) })) : null),
    ...counterRows,
    res.jobs.length
      ? table([t('hist.col.time'), t('hist.col.range'), t('hist.col.count'), t('print.printer'), t('hist.col.status'), ''], rows)
      : h('div', { class: 'muted' }, t('hist.none')),
    adj.length ? h('div', { class: 'hist-adj' }, h('h4', {}, t('hist.manual')), ...adj) : null].filter(Boolean));
}

async function allTab(box, gotoLabel) {
  const q = h('input', { class: 'inp', placeholder: t('hist.search') });
  const period = h('select', { class: 'inp' },
    ...[['1', 'today'], ['7', 'days7'], ['30', 'days30'], ['365', 'year'], ['', 'all']].map(([v, k]) => h('option', { value: v, selected: v === '30' }, t('hist.period.' + k))));
  const out = h('div');
  let jobs = [];
  const load = async () => {
    let since = '';
    if (period.value) {
      const d = new Date(Date.now() - (Number(period.value) - 1) * 864e5);
      since = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 00:00:00`;
    }
    jobs = (await api(`/api/history/jobs?since=${encodeURIComponent(since)}&q=${encodeURIComponent(q.value.trim())}`)).jobs;
    const byLabel = new Map(), byFolder = new Map();
    for (const j of jobs) {
      const key = j.label_uid || j.label_name;
      const L = byLabel.get(key) || { uid: j.label_uid, name: j.label_name, path: j.label_path, sent: 0, jobs: 0, last: null, lastTo: null };
      L.sent += j.sent;
      L.jobs++;
      if (!L.last || j.started > L.last) { L.last = j.started; L.lastTo = j.sent_to; L.name = j.label_name; L.path = j.label_path; }
      byLabel.set(key, L);
      const f = folderOf(j.label_path);
      byFolder.set(f, (byFolder.get(f) || 0) + j.sent);
    }
    const total = jobs.reduce((a, j) => a + j.sent, 0);
    out.replaceChildren(
      h('div', { class: 'hist-head' }, t('hist.total', { n: total, jobs: jobs.length })),
      h('h4', {}, t('hist.perFolder')),
      table([t('hist.col.folder'), t('hist.col.printed')], [...byFolder].sort((a, b) => b[1] - a[1]).map(([f, n]) => h('tr', {}, h('td', {}, f), h('td', { class: 'num' }, String(n))))),
      h('h4', {}, t('hist.perLabel')),
      table([t('hist.col.label'), t('hist.col.folder'), t('hist.col.printed'), t('hist.col.jobs'), t('hist.col.lastNumber'), t('hist.col.lastPrint')],
        [...byLabel.values()].sort((a, b) => (b.last || '').localeCompare(a.last || '')).map((L) => h('tr', {
          class: L.uid ? 'clickable' : '', onclick: () => L.uid && gotoLabel({ uid: L.uid, name: L.name, path: L.path }),
        }, h('td', {}, L.name || ''), h('td', {}, folderOf(L.path)), h('td', { class: 'num' }, String(L.sent)),
        h('td', { class: 'num' }, String(L.jobs)), h('td', { class: 'num' }, L.lastTo ?? '—'),
        h('td', { class: 'num' }, formatDateTime(L.last))))),
      h('h4', {}, t('hist.allJobs')),
      table([t('hist.col.time'), t('hist.col.label'), t('hist.col.range'), t('hist.col.count'), t('hist.col.status')], jobs.map((j) => h('tr', {},
        h('td', { class: 'num' }, formatDateTime(j.started)), h('td', {}, j.label_name || ''),
        h('td', {}, jobRange(j)), h('td', {}, sentOf(j)),
        h('td', {}, statusBadge(j.status))))));
  };
  const csv = () => {
    // Plain column names and timestamps so the file is easy to process
    const cols = ['started', 'label_name', 'label_path', 'counter', 'c_from', 'c_to', 'sent_to', 'sent', 'planned', 'copies', 'printer', 'method', 'status', 'error'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.map(cell).join(','), ...jobs.map((j) => cols.map((c) => cell(j[c])).join(','))];
    const a = h('a', { href: URL.createObjectURL(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv' })), download: 'print-history.csv' });
    document.body.append(a);
    a.click();
    a.remove();
  };
  let timer;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
  period.addEventListener('change', load);
  box.replaceChildren(h('div', { class: 'prow hist-filter' }, q, period), h('button', { class: 'btn btn-ghost', onclick: csv }, t('hist.csv')), out);
  await load();
}

/** target: {uid, name, path}; defaults to the open label */
export async function openHistory(target) {
  target = target || (S.doc && S.doc.uid ? { uid: S.doc.uid, name: S.doc.name, path: S.path } : null);
  const box = h('div', { class: 'hist' });
  const tabL = h('button', { class: 'tab' }, t('hist.thisLabel'));
  const tabA = h('button', { class: 'tab' }, t('hist.allLabels'));
  let closeFn = () => {};
  const show = (which, tg) => {
    tabL.classList.toggle('on', which === 'label');
    tabA.classList.toggle('on', which === 'all');
    tabL.hidden = !tg;
    const run = which === 'label' ? labelTab(box, tg, closeFn) : allTab(box, (x) => { target = x; tabL.hidden = false; show('label', x); });
    run.catch((e) => { box.replaceChildren(h('div', { class: 'err-text' }, e.message)); });
  };
  tabL.onclick = () => target && show('label', target);
  tabA.onclick = () => show('all', target);
  await dialog({
    title: t('lib.history'), wide: true,
    body: h('div', {}, h('div', { class: 'tabs' }, tabL, tabA), box),
    buttons: [{ label: t('common.close'), value: null }],
    onOpen: (_b, close) => { closeFn = close; show(target ? 'label' : 'all', target); },
  });
}
