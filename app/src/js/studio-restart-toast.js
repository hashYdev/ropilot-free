// Top-right "Restart Roblox Studio" notification, styled like the Blender
// install toast (css/blender-install-toast.css).
//
// The desktop server sends studio_restart_needed ({reason, platform}) when a
// Blender import was blocked because the running Studio doesn't have the asset
// upload API on yet (Ropilot turns it on at startup, but Studio only reads it
// when it starts). It stays until dismissed. The helper doesn't send
// flags_enabled (a notice at startup); the message is kept for reuse.
import { escapeHtml } from './utils.js';

let toast = null;

const MESSAGES = {
  flags_enabled: {
    title: 'Restart Roblox Studio',
    detail: 'Ropilot turned on model uploads for Blender imports. Save your place and restart Studio to use them.',
  },
  upload_blocked: {
    title: 'Restart Roblox Studio',
    detail: 'Studio blocked a Blender import because it hasn’t picked up Ropilot’s setting yet. Save your place, restart Studio, then try again.',
  },
  beta_off: {
    title: 'Turn on Studio’s asset uploads',
    detail: 'In Roblox Studio, turn on File › Beta Features › “CreateAssetAsync Luau API”, restart Studio, then try the import again.',
  },
};

function hide() {
  if (!toast) return;
  const el = toast;
  toast = null;
  el.classList.remove('visible');
  setTimeout(() => el.remove(), 250);
}

function ensureToast() {
  if (toast?.isConnected) return toast;
  toast = document.createElement('div');
  toast.className = 'blender-install-toast studio-restart-toast';
  toast.dataset.state = 'notice';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.innerHTML = `
    <div class="bit-row">
      <div class="bit-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/>
        </svg>
      </div>
      <div class="bit-text">
        <div class="bit-title"></div>
        <div class="bit-detail"></div>
      </div>
      <button type="button" class="bit-close" aria-label="Dismiss">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </div>`;
  toast.querySelector('.bit-close').addEventListener('click', hide);
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast?.classList.add('visible'));
  return toast;
}

/** Show the restart notice (content of a studio_restart_needed message). */
export function showStudioRestartToast(notice) {
  const message = MESSAGES[notice?.reason] || MESSAGES.upload_blocked;
  const el = ensureToast();
  el.querySelector('.bit-title').textContent = message.title;
  el.querySelector('.bit-detail').innerHTML = escapeHtml(message.detail);
}
