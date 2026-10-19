// @ts-check
// Image previews: the full-screen image preview modal, local-path → local
// Go server URL normalization for playtest/composer images, and the
// composer attachment hover preview (create/show/position/hide). Extracted
// from app.js; holds the app reference and reaches back through it for the
// local server base URL, modal focus helpers, and the hover-preview element
// refs, which stay on the app object.

export class ImagePreview {
  constructor(app) {
    this.app = app;
  }

  normalizeLocalPreviewSrc(src) {
    if (typeof src !== 'string' || src.trim().length === 0) return '';

    let normalizedSrc = src.trim();
    try {
      normalizedSrc = decodeURIComponent(normalizedSrc);
    } catch (_) {
      // Leave malformed URIs as-is.
    }

    if (/^(data:|https?:)/i.test(normalizedSrc)) {
      return normalizedSrc;
    }

    const baseUrl = this.app.getLocalServerBaseUrl();
    if ((/^[a-zA-Z]:[\\/]/.test(normalizedSrc) || /^(\/|\\\\)/.test(normalizedSrc)) && baseUrl) {
      return `${baseUrl}/playtest-image?path=${encodeURIComponent(normalizedSrc)}`;
    }

    if (/^file:/i.test(normalizedSrc)) {
      try {
        const fileUrl = new URL(normalizedSrc);
        const filePath = decodeURIComponent(fileUrl.pathname || '');
        if (baseUrl) {
          return `${baseUrl}/playtest-image?path=${encodeURIComponent(filePath.replace(/^\/([a-zA-Z]:)/, '$1'))}`;
        }
      } catch (_) {
        // Fall back to original src if URL parsing fails.
      }
    }

    return normalizedSrc;
  }

  openImagePreview(src, alt = 'Image preview') {
    if (typeof src !== 'string' || src.trim().length === 0) return;

    const modal = document.getElementById('image-preview-modal');
    const imageEl = document.getElementById('image-preview-content');
    const closeBtn = document.getElementById('btn-close-image-preview');
    if (!modal || !imageEl) return;

    this.app.captureModalFocus('image-preview-modal');
    const normalizedSrc = this.normalizeLocalPreviewSrc(src);

    imageEl.src = normalizedSrc;
    imageEl.alt = alt || 'Image preview';
    modal.classList.remove('hidden');
    closeBtn?.focus();
  }

  ensureComposerImageHoverPreview() {
    if (this.app.composerImageHoverPreviewEl && document.body.contains(this.app.composerImageHoverPreviewEl)) {
      return this.app.composerImageHoverPreviewEl;
    }

    const previewEl = document.createElement('div');
    previewEl.id = 'composer-image-hover-preview';
    previewEl.className = 'composer-image-hover-preview';
    previewEl.setAttribute('aria-hidden', 'true');

    const imageEl = document.createElement('img');
    imageEl.className = 'composer-image-hover-preview-image';
    imageEl.alt = '';
    imageEl.addEventListener('load', () => this.positionComposerImageHoverPreview());

    previewEl.appendChild(imageEl);
    document.body.appendChild(previewEl);

    this.app.composerImageHoverPreviewEl = previewEl;
    this.app.composerImageHoverPreviewImageEl = imageEl;

    if (!this.app.composerImageHoverPreviewListenersBound) {
      const reposition = () => this.positionComposerImageHoverPreview();
      window.addEventListener('resize', reposition);
      document.addEventListener('scroll', reposition, true);
      this.app.composerImageHoverPreviewListenersBound = true;
    }

    return previewEl;
  }

  showComposerImageHoverPreview(anchorEl, src, alt = 'Image preview') {
    if (!(anchorEl instanceof HTMLElement)) return;

    const normalizedSrc = this.normalizeLocalPreviewSrc(src);
    if (!normalizedSrc) return;

    const previewEl = this.ensureComposerImageHoverPreview();
    const imageEl = this.app.composerImageHoverPreviewImageEl;
    if (!previewEl || !imageEl) return;

    this.app.activeComposerHoverAnchor = anchorEl;
    previewEl.classList.add('visible');
    previewEl.dataset.side = 'top';

    imageEl.src = normalizedSrc;
    imageEl.alt = alt || 'Image preview';

    this.positionComposerImageHoverPreview();
  }

  positionComposerImageHoverPreview() {
    const previewEl = this.app.composerImageHoverPreviewEl;
    const anchorEl = this.app.activeComposerHoverAnchor;
    if (!previewEl || !anchorEl || !previewEl.classList.contains('visible')) return;

    if (!document.body.contains(anchorEl)) {
      this.hideComposerImageHoverPreview();
      return;
    }

    const anchorRect = anchorEl.getBoundingClientRect();
    if (anchorRect.width === 0 && anchorRect.height === 0) {
      this.hideComposerImageHoverPreview();
      return;
    }

    previewEl.style.left = '0px';
    previewEl.style.top = '0px';

    const previewRect = previewEl.getBoundingClientRect();
    if (previewRect.width === 0 && previewRect.height === 0) return;

    const margin = 16;
    const spacing = 12;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = anchorRect.left + (anchorRect.width / 2) - (previewRect.width / 2);
    left = Math.min(Math.max(left, margin), viewportWidth - previewRect.width - margin);

    let top = anchorRect.top - previewRect.height - spacing;
    let side = 'top';

    if (top < margin) {
      top = anchorRect.bottom + spacing;
      side = 'bottom';
    }

    if (top + previewRect.height > viewportHeight - margin) {
      top = Math.max(margin, viewportHeight - previewRect.height - margin);
    }

    previewEl.style.left = `${Math.round(left)}px`;
    previewEl.style.top = `${Math.round(top)}px`;
    previewEl.dataset.side = side;
  }

  hideComposerImageHoverPreview() {
    this.app.activeComposerHoverAnchor = null;

    if (!this.app.composerImageHoverPreviewEl) return;

    this.app.composerImageHoverPreviewEl.classList.remove('visible');
    this.app.composerImageHoverPreviewEl.style.removeProperty('left');
    this.app.composerImageHoverPreviewEl.style.removeProperty('top');
    delete this.app.composerImageHoverPreviewEl.dataset.side;

    if (this.app.composerImageHoverPreviewImageEl) {
      this.app.composerImageHoverPreviewImageEl.removeAttribute('src');
      this.app.composerImageHoverPreviewImageEl.alt = '';
    }
  }

  closeImagePreview() {
    const modal = document.getElementById('image-preview-modal');
    const imageEl = document.getElementById('image-preview-content');
    if (!modal || modal.classList.contains('hidden')) return;

    modal.classList.add('hidden');
    if (imageEl) {
      imageEl.removeAttribute('src');
      imageEl.alt = '';
    }
    this.app.restoreFocusAfterModal('image-preview-modal');
  }
}
