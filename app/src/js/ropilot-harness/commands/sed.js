import { result, splitLines } from '../utils.js';

// --- sed -------------------------------------------------------------------
// Mini-sed covering what models actually use: -n, -e, -E/-r, -i, addresses
// (NUM, $, /re/), ranges (addr,addr), and the commands p, =, d, q and
// s/re/repl/[gIpN].

const SED_POSIX_CLASSES = {
  '[:alnum:]': 'A-Za-z0-9',
  '[:alpha:]': 'A-Za-z',
  '[:digit:]': '0-9',
  '[:lower:]': 'a-z',
  '[:upper:]': 'A-Z',
  '[:space:]': '\\s',
  '[:blank:]': ' \\t',
  '[:word:]': '\\w',
};

function sedRegexToJs(pattern, extended) {
  let src = pattern;
  for (const [posix, replacement] of Object.entries(SED_POSIX_CLASSES)) {
    src = src.split(posix).join(replacement);
  }

  let out = '';
  let inClass = false;
  let firstInClass = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inClass) {
      if (ch === '\\' && i + 1 < src.length) {
        out += '\\' + src[i + 1];
        i += 2;
        firstInClass = false;
        continue;
      }
      out += ch;
      if (ch === ']' && !firstInClass) inClass = false;
      firstInClass = false;
      i++;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      out += ch;
      i++;
      if (src[i] === '^') {
        out += '^';
        i++;
      }
      firstInClass = true;
      continue;
    }
    if (ch === '\\' && i + 1 < src.length) {
      const next = src[i + 1];
      // BRE: escaped metachars become JS metachars
      if (!extended && '(){}|+?'.includes(next)) {
        out += next;
        i += 2;
        continue;
      }
      out += '\\' + next;
      i += 2;
      continue;
    }
    // BRE: unescaped metachars are literal
    if (!extended && '(){}|+?'.includes(ch)) {
      out += '\\' + ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function sedReplacementToJs(repl) {
  let out = '';
  for (let i = 0; i < repl.length; i++) {
    const ch = repl[i];
    if (ch === '\\' && i + 1 < repl.length) {
      const next = repl[++i];
      if (next >= '1' && next <= '9') out += '$' + next;
      else if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === '&') out += '&';
      else if (next === '$') out += '$$';
      else if (next === '\\') out += '\\';
      else out += next;
      continue;
    }
    if (ch === '&') {
      out += '$&';
      continue;
    }
    if (ch === '$') {
      out += '$$';
      continue;
    }
    out += ch;
  }
  return out;
}

function sedParseScript(script, extended) {
  const src = script;
  const len = src.length;
  const commands = [];
  let i = 0;

  const parseAddr = () => {
    if (src[i] === '$') {
      i++;
      return { type: 'last' };
    }
    if (/[0-9]/.test(src[i] || '')) {
      let digits = '';
      while (i < len && /[0-9]/.test(src[i])) digits += src[i++];
      return { type: 'num', value: Number(digits) };
    }
    if (src[i] === '/') {
      i++;
      let raw = '';
      while (i < len && src[i] !== '/') {
        if (src[i] === '\\' && i + 1 < len) {
          raw += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        raw += src[i++];
      }
      i++; // closing /
      let flags = '';
      if (src[i] === 'I') {
        flags = 'i';
        i++;
      }
      return { type: 're', regex: new RegExp(sedRegexToJs(raw, extended), flags) };
    }
    return null;
  };

  while (i < len) {
    while (i < len && (src[i] === ';' || src[i] === '\n' || src[i] === ' ' || src[i] === '\t')) i++;
    if (i >= len) break;

    const addr1 = parseAddr();
    let addr2 = null;
    if (src[i] === ',') {
      i++;
      addr2 = parseAddr();
      if (!addr2) throw new Error('unsupported expression: missing range end');
    }
    while (i < len && (src[i] === ' ' || src[i] === '\t')) i++;

    const cmd = src[i++];
    switch (cmd) {
      case 'p':
      case '=':
      case 'd':
      case 'q':
        commands.push({ addr1, addr2, cmd });
        break;
      case 's': {
        const delim = src[i++];
        if (!delim) throw new Error('unterminated s command');
        const readPart = () => {
          let part = '';
          while (i < len && src[i] !== delim) {
            if (src[i] === '\\' && i + 1 < len) {
              // escaped delimiter becomes a literal delimiter
              if (src[i + 1] === delim) {
                part += delim === '/' ? '\\/' : delim;
                i += 2;
                continue;
              }
              part += src[i] + src[i + 1];
              i += 2;
              continue;
            }
            part += src[i++];
          }
          if (i >= len) throw new Error('unterminated s command');
          i++; // delimiter
          return part;
        };
        const pattern = readPart();
        const replacement = readPart();
        let flags = '';
        while (i < len && /[a-zA-Z0-9]/.test(src[i])) flags += src[i++];
        const jsFlags = (flags.includes('g') ? 'g' : '') + (/[iI]/.test(flags) ? 'i' : '');
        const nthMatch = /([0-9]+)/.exec(flags);
        commands.push({
          addr1,
          addr2,
          cmd: 's',
          regex: new RegExp(sedRegexToJs(pattern, extended), jsFlags),
          replacement: sedReplacementToJs(replacement),
          printOnSub: flags.includes('p'),
          global: flags.includes('g'),
          nth: nthMatch ? Number(nthMatch[1]) : 0,
        });
        break;
      }
      default:
        throw new Error(`unsupported command: ${cmd || '(end of script)'}`);
    }
  }
  return commands;
}

function sedSubstitute(line, spec) {
  if (spec.nth > 1 && !spec.global) {
    // Replace only the Nth occurrence
    const globalRe = new RegExp(spec.regex.source, spec.regex.flags.includes('g') ? spec.regex.flags : spec.regex.flags + 'g');
    let count = 0;
    let output = '';
    let last = 0;
    let match;
    while ((match = globalRe.exec(line)) !== null) {
      count++;
      if (count === spec.nth) {
        output += line.slice(last, match.index);
        output += match[0].replace(spec.regex, spec.replacement);
        last = match.index + match[0].length;
        break;
      }
      if (match.index === globalRe.lastIndex) globalRe.lastIndex++;
    }
    if (count < spec.nth) return line;
    return output + line.slice(last);
  }
  return line.replace(spec.regex, spec.replacement);
}

function sedExecute(commands, lines, quiet) {
  const outParts = [];
  const kept = [];
  const rangeActive = commands.map(() => false);
  const total = lines.length;
  let quit = false;

  const matchAddr = (addr, lineNo, line) => {
    if (!addr) return true;
    if (addr.type === 'num') return lineNo === addr.value;
    if (addr.type === 'last') return lineNo === total;
    return addr.regex.test(line);
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    let pattern = lines[idx];
    let deleted = false;

    for (let c = 0; c < commands.length; c++) {
      const spec = commands[c];
      let selected;
      if (spec.addr2) {
        if (rangeActive[c]) {
          selected = true;
          const endsNow = spec.addr2.type === 'num'
            ? lineNo >= spec.addr2.value
            : matchAddr(spec.addr2, lineNo, pattern);
          if (endsNow) rangeActive[c] = false;
        } else if (matchAddr(spec.addr1, lineNo, pattern)) {
          selected = true;
          const endsImmediately = spec.addr2.type === 'num' && spec.addr2.value <= lineNo;
          if (!endsImmediately) rangeActive[c] = true;
        } else {
          selected = false;
        }
      } else {
        selected = matchAddr(spec.addr1, lineNo, pattern);
      }
      if (!selected) continue;

      if (spec.cmd === 'p') {
        outParts.push(pattern + '\n');
      } else if (spec.cmd === '=') {
        outParts.push(lineNo + '\n');
      } else if (spec.cmd === 'd') {
        deleted = true;
      } else if (spec.cmd === 'q') {
        quit = true;
      } else if (spec.cmd === 's') {
        const before = pattern;
        pattern = sedSubstitute(pattern, spec);
        if (pattern !== before && spec.printOnSub) outParts.push(pattern + '\n');
      }
      if (deleted || quit) break;
    }

    if (!deleted) {
      kept.push(pattern);
      if (!quiet) outParts.push(pattern + '\n');
    }
    if (quit) {
      for (let rest = idx + 1; rest < lines.length; rest++) kept.push(lines[rest]);
      break;
    }
  }
  return { output: outParts.join(''), lines: kept };
}

async function runSed(runner, args, stdin) {
  let quiet = false;
  let extended = false;
  let inPlace = false;
  const scripts = [];
  const files = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-n' || arg === '--quiet' || arg === '--silent') { quiet = true; continue; }
    if (arg === '-E' || arg === '-r' || arg === '--regexp-extended') { extended = true; continue; }
    if (arg === '-i' || /^-i(\.[A-Za-z0-9]+)?$/.test(arg) || arg === '--in-place') { inPlace = true; continue; }
    if (arg === '-e' || arg === '--expression') { if (i + 1 < args.length) scripts.push(args[++i]); continue; }
    if (arg.startsWith('--expression=')) { scripts.push(arg.slice('--expression='.length)); continue; }
    if (arg === '-s' || arg === '--separate' || arg === '--posix') continue;
    if (arg === '--') { files.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('-') && arg.length > 1 && /^-[nEri]+$/.test(arg)) {
      if (arg.includes('n')) quiet = true;
      if (arg.includes('E') || arg.includes('r')) extended = true;
      if (arg.includes('i')) inPlace = true;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      return result('', `sed: unsupported option: ${arg}\n`, 1);
    }
    if (scripts.length === 0) { scripts.push(arg); continue; }
    files.push(arg);
  }

  if (scripts.length === 0) return result('', 'sed: missing script\n', 1);

  let commands;
  try {
    commands = sedParseScript(scripts.join('\n'), extended);
  } catch (error) {
    return result('', `sed: ${error?.message || 'invalid script'}\n`, 1);
  }
  if (inPlace && files.length === 0) return result('', 'sed: -i requires a file operand\n', 1);

  if (files.length === 0) {
    const res = sedExecute(commands, splitLines(stdin || ''), quiet);
    return result(res.output);
  }

  let out = '';
  for (const path of files) {
    await runner.yieldToUI();
    const inputLines = path === '-'
      ? splitLines(stdin || '')
      : splitLines(await runner.readFile(path));
    const res = sedExecute(commands, inputLines, quiet);
    if (inPlace && path !== '-') {
      await runner.writeFile(path, res.lines.length ? res.lines.join('\n') + '\n' : '', false);
    } else if (!inPlace) {
      out += res.output;
    }
  }
  return result(inPlace ? '' : out);
}

export { runSed, sedRegexToJs };
