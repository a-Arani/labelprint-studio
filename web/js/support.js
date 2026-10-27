// Support tools: logs, diagnostics file, previous label versions and backups
import { S } from './state.js';
import { h, api, toast, dialog, confirmBox, formatDateTime } from './util.js';
import { t } from './i18n.js';

export async function openLogs() {
  const pre = h('pre', { class: 'logbox', dir: 'ltr' });
  const only = h('input', { type: 'checkbox' });
  const load = async () => {
    try {
      const r = await api(`/api/logs/tail?n=600&errors=${only.checked ? 1 : 0}`);
      pre.textContent = r.lines.join('\n') || (only.checked ? t('logs.noErrors') : '');
      pre.scrollTop = pre.scrollHeight;
    } catch (e) {
      pre.textContent = e.message;
    }
  };
  only.addEventListener('change', load);
  await dialog({
    title: t('logs.title'), wide: true,
    body: h('div', { class: 'logs' },
      h('div', { class: 'btn-row wrap' },
        h('label', { class: 'check' }, only, h('span', {}, t('logs.onlyErrors'))),
        h('button', { class: 'btn btn-ghost', onclick: load }, t('logs.refresh')),
        h('button', { class: 'btn btn-ghost', onclick: () => api('/api/open-data', { sub: 'logs' }).catch((e) => toast(e.message, 'error')) }, t('logs.openFolder')),
        h('button', {
          class: 'btn', onclick: async () => {
            try {
              const r = await api('/api/diagnostics', {});
              toast(t('logs.diagMade', { name: r.path.split(/[\\/]/).pop() }), 'ok', 8000);
            } catch (e) { toast(e.message, 'error'); }
          },
        }, t('logs.diagnostics'))),
      pre),
    buttons: [{ label: t('common.close'), value: null }],
    onOpen: load,
  });
}

/** onRestore(label): opens the restored label in the editor */
export async function openVersions(onRestore) {
  if (!S.doc || !S.path) return;
  const list = h('div', { class: 'ver-list' }, h('div', { class: 'muted' }, t('common.loading')));
  const path = S.path;
  let closeFn = () => {};
  const load = async () => {
    const r = await api('/api/versions?path=' + encodeURIComponent(path));
    if (!r.versions.length) {
      list.replaceChildren(h('div', { class: 'muted' }, t('ver.none')));
      return;
    }
    list.replaceChildren(...r.versions.map((v) => h('div', { class: 'ver-row' },
      h('span', { class: 'num' }, formatDateTime(v.time)),
      h('span', { class: 'muted' }, `${Math.max(1, Math.round(v.size / 1024))} KB`),
      h('button', {
        class: 'chip', onclick: async () => {
          if (!(await confirmBox(t('ver.restore'), t('ver.restoreText', { when: formatDateTime(v.time) }), t('ver.restore')))) return;
          try {
            const label = await api('/api/versions/restore', { path, id: v.id });
            closeFn();
            onRestore(label, path);
            toast(t('ver.restored'), 'ok');
          } catch (e) { toast(e.message, 'error'); }
        },
      }, t('ver.restore')))));
  };
  await dialog({
    title: t('ver.title', { name: S.doc.name }), body: list, buttons: [{ label: t('common.close'), value: null }],
    onOpen: (_b, close) => { closeFn = close; load().catch((e) => toast(e.message, 'error')); },
  });
}

export async function openBackup() {
  const dir = h('input', { class: 'inp', dir: 'ltr', placeholder: t('backup.placeholder'), value: S.settings.backupDir || '' });
  const list = h('div', { class: 'ver-list' });
  let where = '';
  const load = async () => {
    const r = await api('/api/backup/list');
    where = r.dir;
    list.replaceChildren(...(r.backups.length ? r.backups.slice(0, 8).map((b) => h('div', { class: 'ver-row' },
      h('span', { class: 'num' }, formatDateTime(b.time)), h('span', { class: 'muted' }, b.name),
      h('span', { class: 'muted' }, `${(b.size / 1e6).toFixed(1)} MB`))) : [h('div', { class: 'muted' }, t('backup.none'))]));
  };
  await dialog({
    title: t('backup.title'),
    body: h('div', {},
      h('div', { class: 'muted' }, t('backup.daily')),
      h('label', { class: 'field' }, h('span', {}, t('backup.secondDir')), dir),
      h('div', { class: 'btn-row wrap' },
        h('button', {
          class: 'btn', onclick: async () => {
            S.settings.backupDir = dir.value.trim();
            await api('/api/settings/set', { backupDir: S.settings.backupDir });
            toast(t('backup.dirSaved'), 'ok', 1500);
          },
        }, t('backup.saveDir')),
        h('button', {
          class: 'btn btn-primary', onclick: async (e) => {
            e.target.disabled = true;
            try {
              const r = await api('/api/backup/now', {});
              toast(t('backup.made', { name: r.path.split(/[\\/]/).pop() }), 'ok', 6000);
              await load();
            } catch (err) { toast(err.message, 'error'); } finally { e.target.disabled = false; }
          },
        }, t('backup.now')),
        h('button', { class: 'btn btn-ghost', onclick: () => api('/api/open-data', { sub: 'backups' }).catch((e) => toast(e.message, 'error')) }, t('backup.openFolder'))),
      h('h4', {}, t('backup.recent')), list),
    buttons: [{ label: t('common.close'), value: null }],
    onOpen: () => load().catch(() => {}),
  });
  return where;
}
