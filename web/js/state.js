// Shared app state: open document, selection, undo history and events
import { clone } from './util.js';

const listeners = {};

export const S = {
  doc: null,          // the open label
  path: null,         // its path in the library
  dirty: false,
  sel: [],            // ids of the selected elements
  editingId: null,    // text element being edited in place
  tool: 'select',
  zoom: 1,
  preview: false,     // show variable values instead of {names}
  fonts: [],
  fontSet: new Set(),
  settings: {},
  folder: '',         // folder selected in the library
  grid: { show: false, snap: true, size: 1 },
  pen: { color: '#000000', width: 0.6 },
  scaleContent: (() => { try { return localStorage.getItem('ls.scaleContent') === '1'; } catch (e) { return false; } })(),
};

const undo = [];
const redo = [];

export function on(evt, fn) {
  (listeners[evt] = listeners[evt] || []).push(fn);
}

export function emit(evt, ...args) {
  for (const fn of listeners[evt] || []) fn(...args);
}

// Call before every change so the previous state goes into the undo history
export function snapshot() {
  if (!S.doc) return;
  undo.push(clone(S.doc));
  if (undo.length > 150) undo.shift();
  redo.length = 0;
  S.dirty = true;
}

export function changed(what = 'doc') {
  S.dirty = true;
  emit('change', what);
}

export function canUndo() { return undo.length > 0; }
export function canRedo() { return redo.length > 0; }

export function doUndo() {
  if (!undo.length) return;
  redo.push(clone(S.doc));
  S.doc = undo.pop();
  S.sel = S.sel.filter((id) => S.doc.elements.some((e) => e.id === id));
  S.dirty = true;
  emit('change', 'undo');
  emit('selection');
}

export function doRedo() {
  if (!redo.length) return;
  undo.push(clone(S.doc));
  S.doc = redo.pop();
  S.sel = S.sel.filter((id) => S.doc.elements.some((e) => e.id === id));
  S.dirty = true;
  emit('change', 'redo');
  emit('selection');
}

export function dropLastSnapshot() {
  undo.pop();
}

export function setDoc(doc, path) {
  S.doc = doc;
  S.path = path;
  S.sel = [];
  S.editingId = null;
  S.dirty = false;
  undo.length = 0;
  redo.length = 0;
  emit('doc');
  emit('change', 'doc');
  emit('selection');
}

export function select(ids) {
  S.sel = ids.filter((id, i) => ids.indexOf(id) === i);
  emit('selection');
}

export const byId = (id) => S.doc && S.doc.elements.find((e) => e.id === id);
export const selected = () => S.sel.map(byId).filter(Boolean);
