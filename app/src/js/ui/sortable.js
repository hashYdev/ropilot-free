// @ts-check
// Pointer-driven sortable lists: a vanilla port of the dnd-kit setup Synara
// uses for its sidebar projects and its top-bar tabs (PointerSensor with a
// 6px activation distance, list sorting strategy, axis + scroll-ancestor
// restriction, 200ms `ease` sibling transitions, auto-scroll near the edges).
//
// Behaviour, matching @dnd-kit/sortable 10 without a DragOverlay:
// - A press that travels more than 6px becomes a drag; a still press stays a
//   click (and the click after a real drag is swallowed).
// - The dragged item itself follows the pointer on one axis (no transition),
//   clamped to its first scrollable ancestor; it rides above its siblings.
// - Siblings between the drag origin and the hovered slot slide by the
//   dragged item's size plus the list gap, with `transform 200ms ease`.
// - Dropping on another slot reorders and everything snaps into the new
//   layout at once (dnd-kit disables the transition for that frame).
// - Escape, or a drop after the projected slot moved, animates every item
//   back with the same 200ms ease; a drop that never left its slot snaps.

const ACTIVATION_DISTANCE_PX = 6;
const TRANSITION = 'transform 200ms ease';
const AUTO_SCROLL_THRESHOLD = 0.2; // fraction of the scroll container, as dnd-kit
const AUTO_SCROLL_ACCELERATION = 10; // px per 5ms at the very edge, as dnd-kit

/**
 * @typedef {{ left: number, top: number, width: number, height: number, right: number, bottom: number }} Box
 * @typedef {object} SortableOptions
 * @property {() => HTMLElement[]} items          Current items, in order.
 * @property {(event: PointerEvent) => HTMLElement | null} itemFromEvent
 *           The item a pointerdown should drag (null = not a drag handle).
 * @property {'x' | 'y'} axis
 * @property {'pointerWithin' | 'closestCenter'} collision
 * @property {string} [draggingClass]   Class on the dragged item while dragging.
 * @property {string} [overClass]       Class on the item the pointer is over.
 * @property {(item: HTMLElement) => void} [onDragStart]
 * @property {(item: HTMLElement, fromIndex: number, toIndex: number) => void} [onDrop]
 *           Must reorder the DOM (or re-render) synchronously.
 * @property {() => void} [onDragEnd]
 */

/** @param {DOMRect} r @returns {Box} */
function box(r) {
  return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
}

/** @param {Box} r @param {number} dx @param {number} dy @returns {Box} */
function shift(r, dx, dy) {
  return { left: r.left + dx, top: r.top + dy, width: r.width, height: r.height, right: r.right + dx, bottom: r.bottom + dy };
}

/** @param {HTMLElement} el @param {'x'|'y'} axis */
function firstScrollableAncestor(el, axis) {
  let node = el.parentElement;
  while (node && node !== document.body) {
    const cs = getComputedStyle(node);
    const overflow = axis === 'y' ? cs.overflowY : cs.overflowX;
    if (/(auto|scroll|overlay)/.test(overflow)) return node;
    node = node.parentElement;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : document.body;
}

/** dnd-kit's getItemGap for list strategies. @param {Box[]} rects */
function itemGap(rects, index, activeIndex, axis) {
  const current = rects[index];
  const previous = rects[index - 1];
  const next = rects[index + 1];
  if (!current) return 0;
  const start = axis === 'y' ? 'top' : 'left';
  const size = axis === 'y' ? 'height' : 'width';
  if (axis === 'x' && !previous && !next) return 0;
  if (activeIndex < index) {
    if (previous) return current[start] - (previous[start] + previous[size]);
    return next ? next[start] - (current[start] + current[size]) : 0;
  }
  if (next) return next[start] - (current[start] + current[size]);
  return previous ? current[start] - (previous[start] + previous[size]) : 0;
}

/** dnd-kit's vertical/horizontalListSortingStrategy for a non-active item. */
function strategyOffset(rects, activeIndex, overIndex, index, axis) {
  const active = rects[activeIndex];
  if (!active || index === activeIndex) return 0;
  const size = axis === 'y' ? active.height : active.width;
  const gap = itemGap(rects, index, activeIndex, axis);
  if (index > activeIndex && index <= overIndex) return -size - gap;
  if (index < activeIndex && index >= overIndex) return size + gap;
  return 0;
}

const cornersOf = (r) => [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * @param {HTMLElement} container
 * @param {SortableOptions} options
 */
export function bindPointerSortable(container, options) {
  const axis = options.axis;
  /** @type {null | {
   *   item: HTMLElement, pointerId: number, startX: number, startY: number,
   *   lastX: number, lastY: number, active: boolean, items: HTMLElement[],
   *   rects: Box[], activeIndex: number, overIndex: number, projectedIndex: number,
   *   scroller: HTMLElement, scrollStart: number, raf: number, lastTick: number,
   *   intentForward: boolean, intentBackward: boolean
   * }} */
  let drag = null;
  let settleTimer = 0;

  const scrollPos = (scroller) => (axis === 'y' ? scroller.scrollTop : scroller.scrollLeft);

  const clearSettle = () => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = 0;
  };

  const onPointerDown = (/** @type {PointerEvent} */ event) => {
    if (drag || event.button !== 0 || !event.isPrimary || event.ctrlKey || event.metaKey) return;
    const item = options.itemFromEvent(event);
    if (!item) return;
    clearSettle();
    drag = {
      item,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false,
      items: [],
      rects: [],
      activeIndex: -1,
      overIndex: -1,
      projectedIndex: -1,
      scroller: container,
      scrollStart: 0,
      raf: 0,
      lastTick: 0,
      intentForward: false,
      intentBackward: false,
    };
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
    window.addEventListener('keydown', onKeyDown, true);
  };

  const activate = () => {
    if (!drag) return;
    const items = options.items();
    const activeIndex = items.indexOf(drag.item);
    if (activeIndex < 0) {
      teardown();
      return;
    }
    // Measure untransformed layout boxes, as dnd-kit does at drag start.
    items.forEach((el) => {
      el.style.transition = 'none';
      el.style.transform = '';
    });
    drag.items = items;
    drag.rects = items.map((el) => box(el.getBoundingClientRect()));
    drag.activeIndex = activeIndex;
    drag.overIndex = activeIndex;
    drag.projectedIndex = activeIndex;
    drag.scroller = firstScrollableAncestor(drag.item, axis);
    drag.scrollStart = scrollPos(drag.scroller);
    drag.active = true;
    items.forEach((el, i) => {
      el.style.transition = i === activeIndex ? '' : TRANSITION;
    });
    if (options.draggingClass) drag.item.classList.add(options.draggingClass);
    container.classList.add('is-sorting');
    document.body.classList.add('is-sortable-dragging');
    window.getSelection?.()?.removeAllRanges();
    window.addEventListener('dragstart', preventDefault, true);
    window.addEventListener('selectstart', preventDefault, true);
    options.onDragStart?.(drag.item);
    update();
    drag.lastTick = performance.now();
    drag.raf = requestAnimationFrame(autoScrollTick);
  };

  const update = () => {
    if (!drag || !drag.active) return;
    const { rects, activeIndex, scroller } = drag;
    const scrollDelta = scrollPos(scroller) - drag.scrollStart;
    const pointerDelta = axis === 'y' ? drag.lastY - drag.startY : drag.lastX - drag.startX;
    const origin = rects[activeIndex];
    // restrictToFirstScrollableAncestor: keep the dragged box inside the scroller.
    const bounds = scroller.getBoundingClientRect();
    const startEdge = axis === 'y' ? origin.top : origin.left;
    const size = axis === 'y' ? origin.height : origin.width;
    const boundStart = axis === 'y' ? bounds.top : bounds.left;
    const boundSize = axis === 'y' ? bounds.height : bounds.width;
    let visual = startEdge + pointerDelta;
    if (visual <= boundStart) visual = boundStart;
    else if (visual + size >= boundStart + boundSize) visual = boundStart + boundSize - size;
    const visualDelta = visual - startEdge;
    // The item's layout box moved with the scroll; the transform makes up for it.
    const transform = visualDelta + scrollDelta;
    drag.item.style.transform = axis === 'y' ? `translate3d(0, ${transform}px, 0)` : `translate3d(${transform}px, 0, 0)`;

    // Collision detection against the drag-start boxes, shifted by the scroll.
    const live = rects.map((r) => (axis === 'y' ? shift(r, 0, -scrollDelta) : shift(r, -scrollDelta, 0)));
    const dragged = axis === 'y' ? shift(origin, 0, visualDelta) : shift(origin, visualDelta, 0);
    let over = -1;
    if (options.collision === 'pointerWithin') {
      over = live.findIndex((r) => drag && drag.lastX >= r.left && drag.lastX <= r.right && drag.lastY >= r.top && drag.lastY <= r.bottom);
      if (over < 0) {
        // closestCorners fallback
        const dc = cornersOf(dragged);
        let best = Infinity;
        live.forEach((r, i) => {
          const rc = cornersOf(r);
          const d = dc.reduce((sum, c, k) => sum + dist(c, rc[k]), 0);
          if (d < best) { best = d; over = i; }
        });
      }
    } else {
      const center = [dragged.left + dragged.width / 2, dragged.top + dragged.height / 2];
      let best = Infinity;
      live.forEach((r, i) => {
        const d = dist(center, [r.left + r.width / 2, r.top + r.height / 2]);
        if (d < best) { best = d; over = i; }
      });
    }
    if (over < 0) over = activeIndex;
    if (over !== drag.overIndex && options.overClass) {
      drag.items[drag.overIndex]?.classList.remove(options.overClass);
      if (over !== activeIndex) drag.items[over]?.classList.add(options.overClass);
    }
    drag.overIndex = over;
    drag.projectedIndex = over;
    drag.items.forEach((el, i) => {
      if (i === activeIndex) return;
      const offset = strategyOffset(rects, activeIndex, over, i, axis);
      el.style.transform = offset ? (axis === 'y' ? `translate3d(0, ${offset}px, 0)` : `translate3d(${offset}px, 0, 0)`) : '';
    });
  };

  // dnd-kit's auto-scroller (AutoScrollActivator.Pointer): once the pointer
  // is within 20% of an edge of the scroll container, scroll towards that
  // edge, faster the closer it gets — but only in a direction the pointer has
  // actually moved during this drag (useScrollIntent).
  const autoScrollTick = (now) => {
    if (!drag || !drag.active) return;
    const dt = Math.min(50, now - drag.lastTick);
    drag.lastTick = now;
    const { scroller } = drag;
    const bounds = scroller.getBoundingClientRect();
    const size = axis === 'y' ? bounds.height : bounds.width;
    const threshold = size * AUTO_SCROLL_THRESHOLD;
    const start = axis === 'y' ? bounds.top : bounds.left;
    const end = start + size;
    const pointer = axis === 'y' ? drag.lastY : drag.lastX;
    const max = axis === 'y' ? scroller.scrollHeight - scroller.clientHeight : scroller.scrollWidth - scroller.clientWidth;
    const pos = scrollPos(scroller);
    let speed = 0;
    if (pos > 0 && drag.intentBackward && pointer <= start + threshold) speed = -AUTO_SCROLL_ACCELERATION * Math.abs((start + threshold - pointer) / threshold);
    else if (pos < max && drag.intentForward && pointer >= end - threshold) speed = AUTO_SCROLL_ACCELERATION * Math.abs((end - threshold - pointer) / threshold);
    if (speed) {
      const step = speed * (dt / 5);
      if (axis === 'y') scroller.scrollTop = Math.max(0, Math.min(max, pos + step));
      else scroller.scrollLeft = Math.max(0, Math.min(max, pos + step));
      update();
    }
    drag.raf = requestAnimationFrame(autoScrollTick);
  };

  const onPointerMove = (/** @type {PointerEvent} */ event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const step = axis === 'y' ? event.clientY - drag.lastY : event.clientX - drag.lastX;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (drag.active && step > 0) drag.intentForward = true;
    if (drag.active && step < 0) drag.intentBackward = true;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > ACTIVATION_DISTANCE_PX) activate();
      return;
    }
    event.preventDefault();
    update();
  };

  const onPointerUp = (/** @type {PointerEvent} */ event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    finish(true);
  };

  const onPointerCancel = (/** @type {PointerEvent} */ event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    finish(false);
  };

  const onKeyDown = (/** @type {KeyboardEvent} */ event) => {
    if (!drag || event.key !== 'Escape') return;
    if (drag.active) {
      event.preventDefault();
      event.stopPropagation();
    }
    finish(false, true);
  };

  /** @param {Event} event */
  function preventDefault(event) {
    event.preventDefault();
  }

  const teardown = () => {
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerCancel, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('dragstart', preventDefault, true);
    window.removeEventListener('selectstart', preventDefault, true);
    if (drag?.raf) cancelAnimationFrame(drag.raf);
    drag = null;
  };

  /** @param {boolean} dropped @param {boolean} [buttonStillDown] */
  const finish = (dropped, buttonStillDown = false) => {
    const state = drag;
    teardown();
    if (!state || !state.active) return;
    const { items, item, activeIndex, overIndex, projectedIndex } = state;

    // Swallow the click the browser fires after a drag release (after an
    // Escape, the one that follows the eventual release).
    const swallow = (/** @type {Event} */ e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('click', swallow, true);
    const release = () => setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    if (buttonStillDown) window.addEventListener('pointerup', release, { capture: true, once: true });
    else release();

    if (options.draggingClass) item.classList.remove(options.draggingClass);
    if (options.overClass) items.forEach((el) => el.classList.remove(/** @type {string} */ (options.overClass)));
    container.classList.remove('is-sorting');
    document.body.classList.remove('is-sortable-dragging');

    const reorder = dropped && overIndex !== activeIndex && overIndex >= 0;
    if (reorder) {
      // Snap: reorder first, then drop every transform with transitions off.
      items.forEach((el) => {
        el.style.transition = 'none';
        el.style.transform = '';
      });
      options.onDrop?.(item, activeIndex, overIndex);
      void container.offsetWidth;
      items.forEach((el) => { el.style.transition = ''; });
    } else if (projectedIndex !== activeIndex) {
      // The projected slot moved during the drag: everything eases home.
      items.forEach((el) => {
        el.style.transition = TRANSITION;
        el.style.transform = '';
      });
      clearSettle();
      settleTimer = window.setTimeout(() => {
        settleTimer = 0;
        items.forEach((el) => { el.style.transition = ''; });
      }, 240);
    } else {
      items.forEach((el) => {
        el.style.transition = 'none';
        el.style.transform = '';
      });
      void container.offsetWidth;
      items.forEach((el) => { el.style.transition = ''; });
    }
    options.onDragEnd?.();
  };

  container.addEventListener('pointerdown', onPointerDown);

  return {
    get isDragging() {
      return Boolean(drag && drag.active);
    },
    get isPressed() {
      return Boolean(drag);
    },
    get isSettling() {
      return Boolean(settleTimer);
    },
  };
}
