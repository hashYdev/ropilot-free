import { basename, relativePath } from '../utils.js';

function matchesSearchGlobs(path, globs, workdir) {
  const patterns = (globs || []).map(normalizeGlobPattern).filter(Boolean);
  if (patterns.length === 0) return true;
  const includePatterns = patterns.filter((pattern) => !pattern.negated);
  const excludePatterns = patterns.filter((pattern) => pattern.negated);
  const normalized = normalizeGlobPath(relativePath(workdir, path));
  const absolute = normalizeGlobPath(path);
  const included = includePatterns.length === 0 || includePatterns.some((pattern) => globPatternMatches(normalized, pattern.pattern) || globPatternMatches(absolute, pattern.pattern));
  if (!included) return false;
  return !excludePatterns.some((pattern) => globPatternMatches(normalized, pattern.pattern) || globPatternMatches(absolute, pattern.pattern));
}

function normalizeGlobPattern(raw) {
  let pattern = String(raw || '').trim();
  if (!pattern) return null;
  let negated = false;
  if (pattern.startsWith('!')) {
    negated = true;
    pattern = pattern.slice(1);
  }
  pattern = normalizeGlobPath(pattern);
  return pattern ? { pattern, negated } : null;
}

function normalizeGlobPath(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function globPatternMatches(path, pattern) {
  path = normalizeGlobPath(path);
  pattern = normalizeGlobPath(pattern);
  if (!pattern) return true;
  if (!hasGlobPattern(pattern) && !pattern.includes('/')) {
    const parts = path.split('/');
    return parts.includes(pattern) || parts.some((part) => part === pattern);
  }
  if (!pattern.includes('/')) return globRegex(pattern).test(basename(path));
  return globRegex(pattern).test(path);
}

function hasGlobPattern(value) {
  return /[*?\[]/.test(String(value || ''));
}

function globRegex(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end > i + 1) {
        out += pattern.slice(i, end + 1);
        i = end;
      } else {
        out += '\\[';
      }
    } else {
      out += ch.replace(/[\\^$+?.()|{}]/g, '\\$&');
    }
  }
  out += '$';
  return new RegExp(out);
}

export {
  globPatternMatches,
  globRegex,
  hasGlobPattern,
  matchesSearchGlobs,
  normalizeGlobPath,
  normalizeGlobPattern,
};
