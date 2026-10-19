import {
  concatFiles,
  countText,
  nonFlagArgs,
  result,
  splitLines,
} from '../utils.js';

async function runNumberLines(runner, args, stdin) {
  const paths = nonFlagArgs(args);
  const contents = paths.length > 0 ? await concatFiles(paths, (path) => runner.readFile(path)) : (stdin || '');
  const lines = splitLines(contents);
  return result(lines.map((line, index) => `${String(index + 1).padStart(6, ' ')}\t${line}`).join('\n') + (lines.length ? '\n' : ''));
}

async function runWordCount(runner, args, stdin) {
  const flags = new Set();
  const paths = [];
  for (const arg of args) {
    if (arg === '-') { paths.push(arg); continue; }
    if (arg.startsWith('-') && arg.length > 1) {
      for (const flag of arg.slice(1)) flags.add(flag);
      continue;
    }
    paths.push(arg);
  }
  const selected = ['l', 'w', 'c', 'm'].filter((flag) => flags.has(flag));
  const formatCounts = (count, suffix) => {
    const fields = selected.length === 0
      ? [count.lines, count.words, count.bytes]
      : selected.map((flag) => flag === 'l' ? count.lines : flag === 'w' ? count.words : count.bytes);
    return fields.join(' ') + suffix + '\n';
  };
  if (paths.length === 0) {
    return result(formatCounts(countText(stdin || ''), ''));
  }
  let out = '';
  for (const path of paths) {
    const contents = path === '-' ? (stdin || '') : await runner.readFile(path);
    out += formatCounts(countText(contents), ` ${path}`);
  }
  return result(out);
}

async function runHeadTail(runner, args, stdin, tail) {
  let lineCount = 10;
  let fromLine = 0; // tail -n +K: output starting at line K
  let byteCount = 0;
  const paths = [];
  const applyLineSpec = (spec) => {
    if (tail && spec.startsWith('+')) {
      fromLine = Math.max(1, Number.parseInt(spec.slice(1), 10) || 1);
      return;
    }
    lineCount = Math.max(0, Number.parseInt(spec, 10) || 0);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-n' && i + 1 < args.length) {
      applyLineSpec(args[++i]);
    } else if (arg.startsWith('-n') && arg.length > 2) {
      applyLineSpec(arg.slice(2));
    } else if (arg === '-c' && i + 1 < args.length) {
      byteCount = Math.max(0, Number.parseInt(args[++i], 10) || 0);
    } else if (arg.startsWith('-c') && arg.length > 2) {
      byteCount = Math.max(0, Number.parseInt(arg.slice(2), 10) || 0);
    } else if (/^-\d+$/.test(arg)) {
      lineCount = Math.max(0, Number.parseInt(arg.slice(1), 10) || 0);
    } else if (!arg.startsWith('-') || arg === '-') {
      paths.push(arg);
    }
  }
  const contents = paths.length > 0
    ? await concatFiles(paths, (path) => (path === '-' ? Promise.resolve(stdin || '') : runner.readFile(path)))
    : (stdin || '');
  if (byteCount > 0) {
    return result(tail ? contents.slice(-byteCount) : contents.slice(0, byteCount));
  }
  const lines = splitLines(contents);
  const selected = tail
    ? (fromLine > 0 ? lines.slice(fromLine - 1) : lines.slice(-lineCount))
    : lines.slice(0, lineCount);
  return result(selected.join('\n') + (selected.length ? '\n' : ''));
}

async function runSort(runner, args, stdin) {
  const reverse = args.includes('-r') || args.includes('--reverse');
  const unique = args.includes('-u') || args.includes('--unique');
  const numeric = args.includes('-n') || args.includes('--numeric-sort')
    || args.some((arg) => /^-[a-z]*n[a-z]*$/.test(arg) && arg !== '-n');
  const paths = args.filter((arg) => !arg.startsWith('-') || arg === '-');
  const contents = paths.length > 0
    ? await concatFiles(paths, (path) => (path === '-' ? Promise.resolve(stdin || '') : runner.readFile(path)))
    : (stdin || '');
  let lines = splitLines(contents).sort((a, b) => {
    if (numeric) {
      const numA = Number.parseFloat(a) || 0;
      const numB = Number.parseFloat(b) || 0;
      if (numA !== numB) return numA - numB;
    }
    return a.localeCompare(b);
  });
  if (unique) lines = [...new Set(lines)];
  if (reverse) lines.reverse();
  return result(lines.join('\n') + (lines.length ? '\n' : ''));
}

async function runUniq(runner, args, stdin) {
  const count = args.includes('-c') || args.includes('--count');
  const dupesOnly = args.includes('-d') || args.includes('--repeated');
  const uniqueOnly = args.includes('-u') || args.includes('--unique');
  const paths = args.filter((arg) => !arg.startsWith('-'));
  const contents = paths.length > 0 ? await concatFiles(paths, (path) => runner.readFile(path)) : (stdin || '');
  const lines = splitLines(contents);
  let out = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (last && last.value === line) last.count++;
    else out.push({ value: line, count: 1 });
  }
  if (dupesOnly) out = out.filter((item) => item.count > 1);
  if (uniqueOnly) out = out.filter((item) => item.count === 1);
  return result(out.map((item) => count ? `${String(item.count).padStart(7, ' ')} ${item.value}` : item.value).join('\n') + (out.length ? '\n' : ''));
}

async function runCut(runner, args, stdin) {
  let delimiter = '\t';
  let fields = '';
  let chars = '';
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-d' && i + 1 < args.length) delimiter = args[++i];
    else if (arg.startsWith('-d') && arg.length > 2) delimiter = arg.slice(2);
    else if (arg === '-f' && i + 1 < args.length) fields = args[++i];
    else if (arg.startsWith('-f') && arg.length > 2) fields = arg.slice(2);
    else if (arg === '-c' && i + 1 < args.length) chars = args[++i];
    else if (arg.startsWith('-c') && arg.length > 2) chars = arg.slice(2);
    else if (!arg.startsWith('-') || arg === '-') paths.push(arg);
  }
  const contents = paths.length > 0
    ? await concatFiles(paths, (path) => (path === '-' ? Promise.resolve(stdin || '') : runner.readFile(path)))
    : (stdin || '');
  const lines = splitLines(contents);
  if (fields) {
    const ranges = parseRanges(fields);
    return result(lines.map((line) => {
      const parts = line.split(delimiter);
      return ranges.map((index) => parts[index - 1] ?? '').join(delimiter);
    }).join('\n') + (lines.length ? '\n' : ''));
  }
  if (chars) {
    const ranges = parseRanges(chars);
    return result(lines.map((line) => ranges.map((index) => line[index - 1] ?? '').join('')).join('\n') + (lines.length ? '\n' : ''));
  }
  return result(contents);
}

function parseRanges(value) {
  const out = [];
  for (const part of String(value || '').split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    for (let i = start; i <= end; i++) out.push(i);
  }
  return out;
}

function runTr(args, stdin) {
  let deleteMode = false;
  let squeeze = false;
  const operands = [];
  for (const arg of args) {
    if (arg === '-d') deleteMode = true;
    else if (arg === '-s') squeeze = true;
    else if (/^-[ds]+$/.test(arg)) {
      deleteMode ||= arg.includes('d');
      squeeze ||= arg.includes('s');
    } else operands.push(shellUnescape(arg));
  }
  let text = stdin || '';
  if (deleteMode) {
    const chars = new Set([...expandTrSet(operands[0] || '')]);
    text = [...text].filter((ch) => !chars.has(ch)).join('');
    if (squeeze && operands[1]) text = squeezeChars(text, new Set([...expandTrSet(operands[1])]));
    return result(text);
  }
  if (operands.length >= 2) {
    const from = [...expandTrSet(operands[0])];
    const to = [...expandTrSet(operands[1])];
    const map = new Map();
    for (let i = 0; i < from.length; i++) map.set(from[i], to[Math.min(i, to.length - 1)] || '');
    text = [...text].map((ch) => map.has(ch) ? map.get(ch) : ch).join('');
    if (squeeze) text = squeezeChars(text, new Set(to));
    return result(text);
  }
  if (squeeze && operands[0]) {
    return result(squeezeChars(text, new Set([...expandTrSet(operands[0])])));
  }
  return result(text);
}

function squeezeChars(text, chars) {
  let out = '';
  let previous = null;
  for (const ch of text) {
    if (chars.has(ch) && ch === previous) continue;
    out += ch;
    previous = ch;
  }
  return out;
}

function shellUnescape(value) {
  return String(value || '')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\');
}

function expandTrSet(value) {
  value = shellUnescape(value)
    .replace(/\[:alnum:\]/g, 'a-zA-Z0-9')
    .replace(/\[:alpha:\]/g, 'a-zA-Z')
    .replace(/\[:digit:\]/g, '0-9')
    .replace(/\[:lower:\]/g, 'a-z')
    .replace(/\[:upper:\]/g, 'A-Z')
    .replace(/\[:space:\]/g, ' \t\n\r')
    .replace(/\[:blank:\]/g, ' \t');
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i + 1] === '-' && i + 2 < value.length) {
      const start = value.charCodeAt(i);
      const end = value.charCodeAt(i + 2);
      if (end >= start) {
        for (let code = start; code <= end; code++) out += String.fromCharCode(code);
        i += 2;
        continue;
      }
    }
    out += value[i];
  }
  return out;
}

export {
  expandTrSet,
  parseRanges,
  runCut,
  runHeadTail,
  runNumberLines,
  runSort,
  runTr,
  runUniq,
  runWordCount,
  shellUnescape,
  squeezeChars,
};
