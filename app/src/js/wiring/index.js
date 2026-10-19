// @ts-check
// Aggregates per-feature wiring; call order follows the original bindEvents() top-to-bottom order (by first occurrence of each section).
import { wireTitlebar } from './wire-titlebar.js';
import { wireWindow } from './wire-window.js';
import { wireSidebar } from './wire-sidebar.js';
import { wireMisc } from './wire-misc.js';
import { wireModals } from './wire-modals.js';
import { wireComposer } from './wire-composer.js';
import { wireIpc } from './wire-ipc.js';

export function bindAllEvents(app) {
  wireTitlebar(app);
  wireWindow(app);
  wireSidebar(app);
  wireMisc(app);
  wireModals(app);
  wireComposer(app);
  wireIpc(app);
}
