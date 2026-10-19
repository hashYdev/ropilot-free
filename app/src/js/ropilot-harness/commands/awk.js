import { concatFiles, result, splitLines } from '../utils.js';
import { sedRegexToJs } from './sed.js';

// --- awk -------------------------------------------------------------------
// Pragmatic awk subset: rules of the form `pattern { print ... }` where the
// pattern is /re/ or NR/NF comparisons joined with && and ||, and print args
// are juxtaposed/comma-separated $0/$N/NR/NF/"strings"/numbers. Supports -F.
// Anything fancier fails loudly so callers switch tools.

function awkSplitRules(program) {
  const rules = [];
  const src = program;
  const len = src.length;
  let i = 0;

  const skipSeparators = () => {
    while (i < len && (src[i] === ';' || src[i] === '\n' || src[i] === ' ' || src[i] === '\t')) i++;
  };

  while (i < len) {
    skipSeparators();
    if (i >= len) break;

    let pattern = '';
    while (i < len && src[i] !== '{' && src[i] !== '\n' && src[i] !== ';') {
      if (src[i] === '/') {
        pattern += src[i++];
        while (i < len && src[i] !== '/') {
          if (src[i] === '\\' && i + 1 < len) {
            pattern += src[i] + src[i + 1];
            i += 2;
            continue;
          }
          pattern += src[i++];
        }
        if (i < len) pattern += src[i++];
        continue;
      }
      pattern += src[i++];
    }

    let action = null;
    if (src[i] === '{') {
      i++;
      action = '';
      let depth = 1;
      while (i < len && depth > 0) {
        const ch = src[i];
        if (ch === '"') {
          action += ch;
          i++;
          while (i < len && src[i] !== '"') {
            if (src[i] === '\\' && i + 1 < len) {
              action += src[i] + src[i + 1];
              i += 2;
              continue;
            }
            action += src[i++];
          }
          if (i < len) action += src[i++];
          continue;
        }
        if (ch === '{') depth++;
        if (ch === '}') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        action += ch;
        i++;
      }
    }

    pattern = pattern.trim();
    if (pattern || action !== null) rules.push({ pattern, action: action === null ? null : action.trim() });
  }
  return rules;
}

function awkCompilePattern(pattern) {
  const trimmed = pattern.trim();
  if (!trimmed) return () => true;
  if (/^(BEGIN|END)$/.test(trimmed)) throw new Error('BEGIN/END blocks are not supported');

  const orTerms = trimmed.split(/\|\|/).map((term) => term.trim());
  const compiled = orTerms.map((orTerm) => {
    const andTerms = orTerm.split(/&&/).map((term) => term.trim());
    const tests = andTerms.map((term) => {
      const regexMatch = /^\/(.*)\/$/.exec(term);
      if (regexMatch) {
        const regex = new RegExp(sedRegexToJs(regexMatch[1], true));
        return (ctx) => regex.test(ctx.line);
      }
      const nrMatch = /^(NR|NF)\s*(==|!=|>=|<=|>|<)\s*([0-9]+)$/.exec(term);
      if (nrMatch) {
        const value = Number(nrMatch[3]);
        const pick = nrMatch[1];
        const op = nrMatch[2];
        return (ctx) => {
          const actual = pick === 'NR' ? ctx.nr : ctx.nf;
          switch (op) {
            case '==': return actual === value;
            case '!=': return actual !== value;
            case '>=': return actual >= value;
            case '<=': return actual <= value;
            case '>': return actual > value;
            default: return actual < value;
          }
        };
      }
      throw new Error(`unsupported pattern: ${term}`);
    });
    return (ctx) => tests.every((test) => test(ctx));
  });
  return (ctx) => compiled.some((test) => test(ctx));
}

function awkCompileAction(action) {
  const trimmed = (action || '').trim();
  if (!trimmed) return () => null;
  const printMatch = /^print\b\s*(.*)$/s.exec(trimmed);
  if (!printMatch) throw new Error(`unsupported action: ${trimmed.split(/\s/)[0] || trimmed}`);
  const argsText = printMatch[1].trim();
  if (!argsText) return (ctx) => ctx.line;

  // Tokenize: strings, field refs, NR/NF, numbers, commas
  const tokens = [];
  let i = 0;
  while (i < argsText.length) {
    const ch = argsText[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === ',') { tokens.push({ type: 'comma' }); i++; continue; }
    if (ch === '"') {
      i++;
      let value = '';
      while (i < argsText.length && argsText[i] !== '"') {
        if (argsText[i] === '\\' && i + 1 < argsText.length) {
          const next = argsText[i + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
          continue;
        }
        value += argsText[i++];
      }
      i++;
      tokens.push({ type: 'str', value });
      continue;
    }
    if (ch === '$') {
      i++;
      let digits = '';
      while (i < argsText.length && /[0-9]/.test(argsText[i])) digits += argsText[i++];
      if (!digits) throw new Error('unsupported field reference');
      tokens.push({ type: 'field', value: Number(digits) });
      continue;
    }
    const word = /^(NR|NF)/.exec(argsText.slice(i));
    if (word) {
      tokens.push({ type: word[1] === 'NR' ? 'nr' : 'nf' });
      i += word[1].length;
      continue;
    }
    const num = /^[0-9]+(\.[0-9]+)?/.exec(argsText.slice(i));
    if (num) {
      tokens.push({ type: 'str', value: num[0] });
      i += num[0].length;
      continue;
    }
    throw new Error(`unsupported print argument near: ${argsText.slice(i, i + 12)}`);
  }

  return (ctx) => {
    const parts = [''];
    for (const token of tokens) {
      if (token.type === 'comma') { parts.push(''); continue; }
      let value = '';
      if (token.type === 'str') value = token.value;
      else if (token.type === 'nr') value = String(ctx.nr);
      else if (token.type === 'nf') value = String(ctx.nf);
      else if (token.type === 'field') value = token.value === 0 ? ctx.line : (ctx.fields[token.value - 1] ?? '');
      parts[parts.length - 1] += value;
    }
    return parts.join(' ');
  };
}

async function runAwk(runner, args, stdin) {
  let fieldSep = null;
  let program = null;
  const files = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-F' && i + 1 < args.length) { fieldSep = args[++i]; continue; }
    if (arg.startsWith('-F') && arg.length > 2) { fieldSep = arg.slice(2); continue; }
    if (arg === '-v' || arg === '--assign') return result('', 'awk: -v variables are not supported\n', 2);
    if (arg === '-f' || arg === '--file') return result('', 'awk: -f program files are not supported\n', 2);
    if (arg === '--') { files.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('-') && arg.length > 1) continue;
    if (program === null) { program = arg; continue; }
    files.push(arg);
  }
  if (program === null) return result('', 'awk: missing program\n', 2);

  let rules;
  try {
    rules = awkSplitRules(program).map((rule) => ({
      test: awkCompilePattern(rule.pattern),
      run: rule.action === null ? (ctx) => ctx.line : awkCompileAction(rule.action),
    }));
  } catch (error) {
    return result('', `awk: ${error?.message || 'unsupported program'}\n`, 2);
  }
  if (rules.length === 0) return result();

  const splitFields = (line) => {
    if (fieldSep === null) return line.trim() === '' ? [] : line.trim().split(/[ \t]+/);
    if (fieldSep.length <= 1) return line.split(fieldSep || ' ');
    return line.split(new RegExp(fieldSep));
  };

  const contents = files.length > 0
    ? await concatFiles(files, (path) => (path === '-' ? Promise.resolve(stdin || '') : runner.readFile(path)))
    : (stdin || '');
  const lines = splitLines(contents);
  let out = '';
  for (let idx = 0; idx < lines.length; idx++) {
    if (idx % 1000 === 0) await runner.yieldToUI();
    const line = lines[idx];
    const fields = splitFields(line);
    const ctx = { line, nr: idx + 1, nf: fields.length, fields };
    for (const rule of rules) {
      if (!rule.test(ctx)) continue;
      const printed = rule.run(ctx);
      if (printed !== null) out += printed + '\n';
    }
  }
  return result(out);
}

export { awkCompileAction, awkCompilePattern, awkSplitRules, runAwk };
