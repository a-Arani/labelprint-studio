// Printer control: paper movement, sensor, tests and settings sent straight to a TSPL printer (USB queue or network)
import { S } from './state.js';
import { h, api, toast, dialog, confirmBox } from './util.js';
import { t } from './i18n.js';
import { ICONS } from './icons.js';
import { loadPrinters, profileFor, saveProfile, pickDefaultPrinter } from './printers.js';
import { mediaList, normMedia, tsplOf, layoutTestCanvas } from './media.js';
import { toMono, monoToBase64 } from './render.js';

const FINISH = ['tear', 'peel', 'cut', 'cutBatch', 'none'];

export async function openPrinterControl(printerName, mediaId) {
  const list = await loadPrinters();
  let prof = profileFor(printerName || pickDefaultPrinter(list));
  const media = mediaList();
  const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);
  const icon = (name) => h('span', { class: 'ico', html: ICONS[name] });

  const printerSel = h('select', { class: 'inp' }, ...list.printers.map((p) => h('option', { value: p.name, selected: p.name === prof.printer }, p.name)));
  if (!list.printers.length) printerSel.append(h('option', { value: '' }, t('print.noPrinters')));
  const method = h('select', { class: 'inp' },
    h('option', { value: 'tspl' }, t('print.methodTspl')), h('option', { value: 'network' }, t('print.methodNetwork')));
  const host = h('input', { class: 'inp', dir: 'ltr', placeholder: '192.168.1.50' });
  const port = h('input', { class: 'inp', type: 'number', dir: 'ltr' });
  const rollSel = h('select', { class: 'inp' }, ...media.map((m) => h('option', { value: m.id }, m.name)));
  rollSel.value = media.some((m) => m.id === mediaId) ? mediaId : (S.doc && media.some((m) => m.id === S.doc.page.mediaId) ? S.doc.page.mediaId : media[0].id);
  const distance = h('input', { class: 'inp num', type: 'number', min: 0.1, max: 500, step: 0.5, value: 10, title: t('pc.distance'), 'aria-label': t('pc.distance') });
  const finish = h('select', { class: 'inp' }, ...FINISH.map((k) => h('option', { value: k }, t('pc.finish.' + k))));
  const raw = h('textarea', { class: 'inp pc-raw', rows: 4, dir: 'ltr', spellcheck: false, placeholder: 'SOUND 3,100' });
  const netRow = h('div', { class: 'prow' }, field(t('print.ip'), host), field(t('print.port'), port));
  const printerRow = field(t('print.printer'), printerSel);

  const fill = () => {
    method.value = prof.method === 'network' ? 'network' : 'tspl';
    host.value = prof.host || '';
    port.value = prof.port || 9100;
    finish.value = FINISH.includes(prof.finish) ? prof.finish : 'tear';
    netRow.hidden = method.value !== 'network';
    printerRow.hidden = method.value === 'network';
  };
  const current = () => {
    const m = normMedia(media.find((x) => x.id === rollSel.value) || media[0]);
    return {
      ...prof, method: method.value, printer: printerSel.value, host: host.value.trim(), port: parseInt(port.value, 10) || 9100,
      finish: finish.value, ...tsplOf(m),
    };
  };
  printerSel.addEventListener('change', () => { prof = profileFor(printerSel.value); fill(); });
  method.addEventListener('change', () => { netRow.hidden = method.value !== 'network'; printerRow.hidden = method.value === 'network'; });

  const send = async (cmd, extra = {}, okKey = 'pc.sent') => {
    const st = { ...current(), ...extra };
    if (st.method === 'network' ? !st.host : !st.printer) { toast(t(st.method === 'network' ? 'print.noIp' : 'print.noPrinter'), 'error'); return false; }
    try {
      await api('/api/printer/command', { cmd, settings: st });
      toast(t(okKey), 'ok', 2500);
      return true;
    } catch (e) {
      toast(e.message, 'error', 7000);
      return false;
    }
  };
  const mm = () => ({ mm: parseFloat(distance.value) || 0 });
  const btn = (label, fn, cls = 'btn', ic = null) => h('button', { class: cls, type: 'button', onclick: fn }, ic ? icon(ic) : null, label);

  const alignmentTest = async () => {
    const st = current();
    const m = normMedia(media.find((x) => x.id === rollSel.value) || media[0]);
    const mono = toMono(layoutTestCanvas(m, st.dpi || 203, st), 140);
    try {
      await api('/api/print', { jobName: 'alignment test', settings: st, pages: [{ w: mono.w, h: mono.h, bits: monoToBase64(mono), copies: 1 }] });
      toast(t('media.testSent'), 'ok');
    } catch (e) { toast(e.message, 'error', 7000); }
  };

  // A titled group of buttons; given arrays, each one is a row of its own
  const group = (title, ...kids) => h('section', { class: 'pc-group' }, h('h4', {}, title),
    ...(Array.isArray(kids[0]) ? kids : [kids]).map((row) => h('div', { class: 'btn-row wrap' }, ...row)));
  const body = h('div', { class: 'pc' },
    h('div', { class: 'pc-top' },
      printerRow,
      netRow,
      h('div', { class: 'prow' }, field(t('print.method'), method), field(t('print.roll'), rollSel))),
    group(t('pc.paper'),
      [btn(t('pc.feedLabel'), () => send('feed'), 'btn', 'forward'),
        btn(t('pc.backLabel'), () => send('backlabel'), 'btn', 'backward'),
        btn(t('pc.home'), () => send('home'))],
      [h('span', { class: 'pc-dist' }, field(t('pc.distance'), h('span', { class: 'num-wrap' }, distance, h('em', {}, 'mm')))),
        btn(t('pc.feedMm'), () => send('feedmm', mm()), 'btn', 'forward'),
        btn(t('pc.backfeed'), () => send('backfeed', mm()), 'btn', 'backward')]),
    group(t('pc.sensor'),
      btn(t('media.calibrate'), () => send('calibrate', {}, 'media.calibrateSent')),
      btn(t('pc.autodetect'), () => send('autodetect', {}, 'media.calibrateSent'))),
    group(t('pc.tests'),
      btn(t('pc.selftest'), () => send('selftest')),
      btn(t('pc.alignment'), alignmentTest),
      btn(t('pc.beep'), () => send('beep'))),
    h('section', { class: 'pc-group' }, h('h4', {}, t('pc.after')),
      h('div', { class: 'prow prow-btn' }, finish,
        btn(t('pc.apply'), async () => {
          if (await send('finish', { finish: finish.value })) {
            prof.finish = finish.value;
            await saveProfile({ ...prof, printer: printerSel.value || prof.printer });
          }
        }, 'btn btn-primary'))),
    h('details', { class: 'print-adv pc-adv' },
      h('summary', {}, t('pc.advanced')),
      field(t('pc.raw'), raw),
      h('div', { class: 'btn-row wrap' },
        btn(t('pc.sendRaw'), () => send('raw', { text: raw.value })),
        btn(t('pc.factory'), async () => {
          if (await confirmBox(t('pc.factory'), t('pc.factoryText'), t('pc.factory'), true)) send('factory');
        }, 'btn btn-ghost danger'))));
  fill();
  await dialog({ title: t('pc.title'), body, buttons: [{ label: t('common.close'), value: null }] });
}
