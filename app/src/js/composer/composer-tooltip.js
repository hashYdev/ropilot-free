// @ts-check
// Synara "picker" tooltips for the composer: one shared frosted popup that
// follows any element carrying data-composer-tip (picker tabs, the model
// trigger, the effort card buttons, model-row descriptors). Opens after a
// short rest, then instantly while the pointer moves between tipped elements
// (Base UI's tooltip delay group), and never while that element's menu is open.

const OPEN_DELAY_MS = 600;
const WARM_WINDOW_MS = 400;

export function initComposerTooltips(root = document) {
  if (!root?.body || root.getElementById('composer-tooltip')) return null;
  const tip = root.createElement('div');
  tip.id = 'composer-tooltip';
  tip.className = 'composer-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  root.body.appendChild(tip);

  let current = null;
  let timer = 0;
  let lastHiddenAt = 0;

  const hide = () => {
    window.clearTimeout(timer);
    timer = 0;
    if (!tip.hidden) lastHiddenAt = Date.now();
    tip.hidden = true;
    tip.classList.remove('is-visible');
    current = null;
  };

  const place = (el) => {
    const rect = el.getBoundingClientRect();
    const side = el.dataset.composerTipSide
      || (el.closest('.composer-model-row') ? 'left' : 'top');
    const gap = el.dataset.composerTipGap ? Number(el.dataset.composerTipGap) : (el.id === 'composer-model-trigger' ? 6 : 4);
    tip.dataset.side = side;
    tip.style.left = '0px';
    tip.style.top = '0px';
    const tipRect = tip.getBoundingClientRect();
    const pad = 8;
    let left;
    let top;
    if (side === 'left' || side === 'right') {
      // Row descriptors sit beside the picker, not over the rows above.
      const panel = el.closest('.composer-dropdown-menu')?.getBoundingClientRect() || rect;
      left = side === 'left' ? panel.left - gap - tipRect.width : panel.right + gap;
      if (left < pad) left = panel.right + gap;
      top = rect.top + rect.height / 2 - tipRect.height / 2;
    } else {
      left = rect.left + rect.width / 2 - tipRect.width / 2;
      top = rect.top - gap - tipRect.height;
      if (top < pad) top = rect.bottom + gap;
    }
    left = Math.min(Math.max(pad, left), window.innerWidth - pad - tipRect.width);
    top = Math.min(Math.max(pad, top), window.innerHeight - pad - tipRect.height);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  };

  const show = (el) => {
    if (!el.isConnected || current !== el) return;
    if (el.getAttribute('aria-expanded') === 'true') return;
    const text = el.dataset.composerTip || '';
    if (!text) return;
    tip.textContent = text;
    tip.classList.toggle('is-wide', text.length > 48);
    tip.hidden = false;
    place(el);
    tip.classList.add('is-visible');
  };

  root.addEventListener('pointerover', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const el = target?.closest('[data-composer-tip]') || null;
    if (el === current) return;
    hide();
    if (!el) return;
    current = el;
    const warm = Date.now() - lastHiddenAt < WARM_WINDOW_MS;
    timer = window.setTimeout(() => show(el), warm ? 0 : OPEN_DELAY_MS);
  });
  root.addEventListener('pointerdown', hide, true);
  root.addEventListener('keydown', hide, true);
  root.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);

  return { hide };
}
