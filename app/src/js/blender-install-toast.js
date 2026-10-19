// Top-right notification for Ropilot's one-time Blender install.
//
// The desktop server sends blender_install messages ({state, version,
// received, total, error}) while it downloads and unpacks Blender. The toast
// shows a determinate progress bar while downloading, an indeterminate one
// while verifying/unpacking, then "installed" (auto-hides) or the error (stays
// until dismissed). Dismissing it mid-install hides it until the outcome.
import { escapeHtml } from './utils.js';

const READY_HIDE_MS = 4000;

let toast = null;
let hideTimer = null;
let dismissed = false;

function megabytes(bytes) {
  return `${Math.round((Number(bytes) || 0) / 1_000_000)} MB`;
}

function ensureToast() {
  if (toast?.isConnected) return toast;
  toast = document.createElement('div');
  toast.className = 'blender-install-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.innerHTML = `
    <div class="bit-row">
      <div class="bit-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>
        </svg>
      </div>
      <div class="bit-text">
        <div class="bit-title"></div>
        <div class="bit-detail"></div>
      </div>
      <div class="bit-percent"></div>
      <button type="button" class="bit-close" aria-label="Dismiss">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </div>
    <div class="bit-bar"><div class="bit-fill"></div></div>`;
  toast.querySelector('.bit-close').addEventListener('click', () => {
    dismissed = true;
    hide();
  });
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast?.classList.add('visible'));
  return toast;
}

function hide() {
  clearTimeout(hideTimer);
  hideTimer = null;
  if (!toast) return;
  const el = toast;
  toast = null;
  el.classList.remove('visible');
  setTimeout(() => el.remove(), 250);
}

/** Render the latest install progress (content of a blender_install message). */
export function updateBlenderInstallToast(progress) {
  if (!progress || typeof progress !== 'object') return;
  const state = String(progress.state || '');
  const final = state === 'ready' || state === 'error';
  if (dismissed && !final) return;
  if (final) dismissed = false;

  const version = progress.version ? ` ${progress.version}` : '';
  const total = Number(progress.total) || 0;
  const received = Math.min(Number(progress.received) || 0, total || Infinity);
  const percent = total > 0 ? Math.floor((received / total) * 100) : 0;

  let title = `Installing Blender${version}`;
  let detail = 'Starting…';
  let percentText = '';
  let mode = 'indeterminate';
  switch (state) {
    case 'downloading':
      detail = total > 0 ? `${megabytes(received)} of ${megabytes(total)}` : 'Downloading…';
      percentText = total > 0 ? `${percent}%` : '';
      mode = total > 0 ? 'determinate' : 'indeterminate';
      break;
    case 'verifying':
      detail = 'Verifying download…';
      break;
    case 'extracting':
      detail = 'Unpacking…';
      break;
    case 'ready':
      title = `Blender${version} installed`;
      detail = 'Ready for 3D modeling';
      mode = 'done';
      break;
    case 'error':
      title = 'Blender install failed';
      detail = `${progress.error || 'Unknown error'}. It retries on the next Blender request.`;
      mode = 'error';
      break;
    default:
      break;
  }

  const el = ensureToast();
  el.dataset.state = mode;
  el.querySelector('.bit-title').textContent = title;
  el.querySelector('.bit-detail').innerHTML = escapeHtml(detail);
  el.querySelector('.bit-percent').textContent = percentText;
  el.querySelector('.bit-fill').style.width = mode === 'determinate' ? `${percent}%` : '';

  clearTimeout(hideTimer);
  hideTimer = state === 'ready' ? setTimeout(hide, READY_HIDE_MS) : null;
}
