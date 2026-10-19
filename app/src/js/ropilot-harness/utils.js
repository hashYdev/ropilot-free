export const DEFAULT_TIMEOUT_MS = 30000;
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export function result(stdout = '', stderr = '', exitCode = 0, error = '', timedOut = false) {
  return { stdout, stderr, exitCode, error, timedOut, truncated: false };
}

export function normalizeWorkdir(value) {
  return String(value || '').trim() || '/tmp';
}

export function normalizeTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(120000, Math.floor(n)));
}

export function normalizeMaxOutput(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1024 * 1024;
  return Math.max(1, Math.min(MAX_OUTPUT_BYTES, Math.floor(n)));
}

export function nonFlagArgs(args) {
  return args.filter((arg) => !arg.startsWith('-'));
}

export function splitLines(text) {
  if (!text) return [];
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function countText(text) {
  const lines = splitLines(text);
  return {
    lines: lines.length,
    words: lines.reduce((n, line) => n + line.trim().split(/\s+/).filter(Boolean).length, 0),
    bytes: new TextEncoder().encode(text || '').length,
  };
}

export async function concatFiles(paths, read) {
  let out = '';
  for (const path of paths) {
    out += await read(path);
  }
  return out;
}

export function basename(path) {
  return String(path || '').replaceAll('\\', '/').split('/').filter(Boolean).pop() || path;
}

export function toSlash(path) {
  return String(path || '').replaceAll('\\', '/');
}

export function relativePath(base, target) {
  const normalizedBase = toSlash(base).replace(/\/+$/, '');
  const normalizedTarget = toSlash(target);
  if (normalizedTarget.startsWith(normalizedBase + '/')) {
    return normalizedTarget.slice(normalizedBase.length + 1);
  }
  return normalizedTarget;
}

export function byteLength(text) {
  return new TextEncoder().encode(text || '').length;
}

export function capStringBytes(text, maxBytes) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(text || '');
  if (bytes.length <= maxBytes) return text || '';
  return decoder.decode(bytes.slice(0, maxBytes));
}

export function expandVariables(text, env) {
  return String(text || '').replace(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([^}]+)\}/g, (_, a, b) => env[a || b] ?? '');
}

export function rawWord(value) {
  return { kind: 'word', parts: [{ type: 'bare', value }] };
}

export function wordRaw(word) {
  return (word?.parts || []).map((part) => part.value || '').join('');
}

export function isAssignmentToken(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(wordRaw(token));
}

export function isDevNull(path) {
  const value = String(path || '').replaceAll('\\', '/').toLowerCase();
  return value === '/dev/null' || value === 'nul';
}

export function createYieldController(interval = 75) {
  let count = 0;
  return async () => {
    count++;
    if (count % interval !== 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
}
