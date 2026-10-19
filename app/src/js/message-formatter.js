// Message Formatter - converts markdown to HTML
import { escapeHtml } from './utils.js';

export function formatMessage(content) {
  try {
    if (typeof marked !== 'undefined') {
      marked.setOptions({
        breaks: true,
        gfm: true,
        highlight: function(code, lang) {
          if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
            try {
              return hljs.highlight(code, { language: lang }).value;
            } catch (e) {}
          }
          return code;
        }
      });
      return marked.parse(content);
    }
    return escapeHtml(content).replace(/\n/g, '<br>');
  } catch (e) {
    console.error('Markdown parsing error:', e);
    return escapeHtml(content).replace(/\n/g, '<br>');
  }
}
