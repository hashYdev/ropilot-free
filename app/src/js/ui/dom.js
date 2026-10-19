// @ts-check
// Minimal DOM-building helpers for new and extracted modules. This is not a
// component framework: no lifecycle, no virtual DOM — just safe element
// construction so hand-built innerHTML string concatenation (an XSS
// footgun) stops spreading. Existing hot paths (message-renderer) keep
// their tuned innerHTML rendering.

import { escapeHtml } from '../utils.js';

/**
 * Build an element: el('div', {class: 'row', onclick: fn}, 'text', child).
 * String/number children become text nodes (inherently escaped); attrs
 * starting with `on` and holding a function are event listeners; `class`
 * sets className; other attrs go through setAttribute; null/false attrs and
 * children are skipped.
 * @param {string} tag
 * @param {Object<string, any>|null} [attrs]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs = null, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (name.startsWith('on') && typeof value === 'function') {
        node.addEventListener(name.slice(2).toLowerCase(), value);
      } else if (name === 'class') {
        node.className = value;
      } else if (name === 'dataset' && typeof value === 'object') {
        Object.assign(node.dataset, value);
      } else {
        node.setAttribute(name, value === true ? '' : String(value));
      }
    }
  }
  appendChildren(node, children);
  return node;
}

/**
 * Tagged template producing an HTML string with every interpolation
 * escaped: htmlEscaped`<b>${userText}</b>`. Wrap trusted markup in
 * unsafe(...) to pass it through verbatim.
 * @param {TemplateStringsArray} strings
 * @param {...any} values
 * @returns {string}
 */
export function htmlEscaped(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    out += value instanceof UnsafeHtml ? value.html : escapeHtml(String(value ?? ''));
    out += strings[i + 1];
  }
  return out;
}

/**
 * Mark a string as trusted markup for htmlEscaped interpolation. Only use
 * on markup you built yourself, never on user or model output.
 * @param {string} html
 */
export function unsafe(html) {
  return new UnsafeHtml(html);
}

class UnsafeHtml {
  /** @param {string} html */
  constructor(html) {
    this.html = html;
  }
}

/**
 * @param {Node} node
 */
export function clearChildren(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(node, child);
    } else if (child instanceof Node) {
      node.appendChild(child);
    } else {
      node.appendChild(document.createTextNode(String(child)));
    }
  }
}
