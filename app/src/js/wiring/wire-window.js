// @ts-check
// Window focus wiring: auto-focus the chat input when the window gains focus (Electron IPC with web fallback).
import { electronAPI } from '../core/platform.js';

export function wireWindow(app) {
  // Auto-focus chat input when the Electron window gains focus from outside
  const focusChatInput = () => {
    const activeEl = document.activeElement;
    const tagName = activeEl?.tagName?.toLowerCase();
    // Don't steal focus if user is already in an input, textarea, or select
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return;
    // Don't steal focus if a modal is open
    const openModal = document.querySelector('.modal:not(.hidden)');
    if (openModal) return;
    // Focus the chat input if the chat view is visible
    const chatView = document.getElementById('chat-view');
    if (chatView && !chatView.classList.contains('hidden')) {
      document.getElementById('input-message')?.focus();
    }
  };
  // Use Electron IPC for reliable window focus detection
  const api = electronAPI();
  if (api?.onWindowFocus) {
    api.onWindowFocus(focusChatInput);
  } else {
    // Fallback for browser-based usage (Cloudflare Pages)
    window.addEventListener('focus', focusChatInput);
  }
}
