// Send page errors and user actions to the server log (data/logs/app.log, tagged [client])
const queue = [];
let timer = null;

function flush() {
  clearTimeout(timer);
  timer = null;
  if (!queue.length) return;
  const entries = queue.splice(0, queue.length);
  try {
    fetch('/api/log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }), keepalive: true,
    }).catch(() => {});
  } catch (e) { /* not important */ }
}

export function log(level, msg, ctx) {
  queue.push({ level, msg: String(msg).slice(0, 3000), ctx: ctx || undefined });
  if (level === 'error' || queue.length > 30) flush();
  else if (!timer) timer = setTimeout(flush, 2000);
}

export const info = (msg, ctx) => log('info', msg, ctx);
export const warn = (msg, ctx) => log('warn', msg, ctx);
export const error = (msg, ctx) => log('error', msg, ctx);

window.addEventListener('error', (e) => {
  error(`Page error: ${e.message}`, { at: `${e.filename}:${e.lineno}:${e.colno}`, stack: e.error && e.error.stack });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  error(`Unhandled rejection: ${(r && r.message) || r}`, { stack: r && r.stack });
});
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
