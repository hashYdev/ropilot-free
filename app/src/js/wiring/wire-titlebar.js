// @ts-check
// Title bar window-control button wiring (minimize/maximize/close).
import { electronAPI } from '../core/platform.js';

export function wireTitlebar(app) {
  // Title bar
  document.getElementById('btn-minimize').onclick = () => electronAPI().minimize();
  document.getElementById('btn-maximize').onclick = () => electronAPI().maximize();
  document.getElementById('btn-close').onclick = () => electronAPI().close();
}
