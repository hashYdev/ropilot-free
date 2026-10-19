// @ts-check
// Shared timing helpers. New code should use these instead of hand-rolled
// setTimeout bookkeeping; existing timers migrate only where the swap is
// trivially equivalent (the rAF scroll coalescing in utils.js and the
// chat-sync-commit debounce keep their tuned implementations).

/**
 * Debounced wrapper for fn. The returned function carries:
 *  - .cancel()  drop any pending invocation
 *  - .flush()   run a pending invocation immediately
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {number} ms
 * @param {{leading?: boolean}} [opts] leading: also fire on the first call
 *   of a burst.
 */
export function debounce(fn, ms, { leading = false } = {}) {
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** @type {any[]|null} */
  let pendingArgs = null;
  /** @type {any} */
  let pendingThis = null;

  function invoke() {
    const args = pendingArgs || [];
    const self = pendingThis;
    pendingArgs = null;
    pendingThis = null;
    fn.apply(self, args);
  }

  /** @this {any} */
  function debounced(...args) {
    const fireNow = leading && timer === null;
    pendingArgs = args;
    pendingThis = this;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (pendingArgs !== null) invoke();
    }, ms);
    if (fireNow) invoke();
  }

  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pendingArgs = null;
    pendingThis = null;
  };

  debounced.flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pendingArgs !== null) invoke();
  };

  return debounced;
}

/**
 * At most one call to fn per ms window; trailing calls collapse into one
 * invocation at the end of the window with the latest arguments.
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {number} ms
 */
export function throttle(fn, ms) {
  let lastRun = 0;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let trailing = null;
  /** @type {any[]} */
  let lastArgs = [];
  /** @type {any} */
  let lastThis = null;

  /** @this {any} */
  return function throttled(...args) {
    lastArgs = args;
    lastThis = this;
    const now = Date.now();
    const elapsed = now - lastRun;
    if (elapsed >= ms) {
      lastRun = now;
      fn.apply(lastThis, lastArgs);
      return;
    }
    if (trailing === null) {
      trailing = setTimeout(() => {
        trailing = null;
        lastRun = Date.now();
        fn.apply(lastThis, lastArgs);
      }, ms - elapsed);
    }
  };
}

/**
 * Collapses any number of calls within one animation frame into a single
 * invocation of fn on the next frame. Falls back to a 16ms timeout outside
 * a browser context (jsdom tests).
 * @param {() => void} fn
 * @returns {() => void} scheduler
 */
export function rafCoalesce(fn) {
  let scheduled = false;
  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (/** @type {() => void} */ cb) => setTimeout(cb, 16);
  return function schedule() {
    if (scheduled) return;
    scheduled = true;
    raf(() => {
      scheduled = false;
      fn();
    });
  };
}
