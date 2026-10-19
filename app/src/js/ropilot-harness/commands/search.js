import { relativePath, result, splitLines, toSlash } from '../utils.js';
import { matchesSearchGlobs } from './glob.js';

async function runSearch(runner, name, args, stdin) {
  if (name === 'rg' && args.includes('--files')) return runRgFiles(runner, args.filter((arg) => arg !== '--files'));
  const options = {
    commandName: name,
    lineNumbers: name === 'rg',
    lineNumbersExplicit: false,
    ignoreCase: false,
    fixedStrings: false,
    extendedRegex: name === 'rg',
    quiet: false,
    invertMatch: false,
    filesWithMatches: false,
    filesWithoutMatch: false,
    onlyMatching: false,
    recursive: name === 'rg',
    globs: [],
    countOnly: false,
    wordMatch: false,
    beforeContext: 0,
    afterContext: 0,
    maxCount: 0,
    filenameMode: '', // '' auto | 'always' (-H) | 'never' (-h)
  };
  const patterns = [];
  const operands = [];
  let parsingFlags = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (parsingFlags && arg === '--') {
      parsingFlags = false;
      continue;
    }
    if (parsingFlags && (arg === '-e' || arg === '--regexp')) {
      if (i + 1 < args.length) patterns.push(args[++i]);
      continue;
    }
    if (parsingFlags && arg.startsWith('--regexp=')) {
      patterns.push(arg.slice('--regexp='.length));
      continue;
    }
    if (parsingFlags && (arg === '-g' || arg === '--glob')) {
      if (i + 1 < args.length) options.globs.push(args[++i]);
      continue;
    }
    if (parsingFlags && arg.startsWith('--glob=')) {
      options.globs.push(arg.slice('--glob='.length));
      continue;
    }
    if (parsingFlags && name === 'rg' && arg.startsWith('-g') && arg.length > 2) {
      options.globs.push(arg.slice(2));
      continue;
    }
    if (parsingFlags && arg === '-m') {
      if (i + 1 < args.length) options.maxCount = Math.max(0, Number.parseInt(args[++i], 10) || 0);
      continue;
    }
    if (parsingFlags && arg.startsWith('-m') && /^-m\d+$/.test(arg)) {
      options.maxCount = Math.max(0, Number.parseInt(arg.slice(2), 10) || 0);
      continue;
    }
    if (parsingFlags && arg.startsWith('--max-count=')) {
      options.maxCount = Math.max(0, Number.parseInt(arg.slice('--max-count='.length), 10) || 0);
      continue;
    }
    if (parsingFlags && (arg === '-A' || arg === '-B' || arg === '-C')) {
      const value = i + 1 < args.length ? Math.max(0, Number.parseInt(args[++i], 10) || 0) : 0;
      if (arg === '-A' || arg === '-C') options.afterContext = value;
      if (arg === '-B' || arg === '-C') options.beforeContext = value;
      continue;
    }
    if (parsingFlags && /^-[ABC]\d+$/.test(arg)) {
      const value = Math.max(0, Number.parseInt(arg.slice(2), 10) || 0);
      if (arg[1] === 'A' || arg[1] === 'C') options.afterContext = value;
      if (arg[1] === 'B' || arg[1] === 'C') options.beforeContext = value;
      continue;
    }
    if (parsingFlags && (arg.startsWith('--after-context=') || arg.startsWith('--before-context=') || arg.startsWith('--context='))) {
      const value = Math.max(0, Number.parseInt(arg.split('=')[1], 10) || 0);
      if (!arg.startsWith('--before')) options.afterContext = value;
      if (!arg.startsWith('--after')) options.beforeContext = value;
      continue;
    }
    if (parsingFlags && arg.startsWith('-') && arg !== '-') {
      applySearchFlag(options, arg);
      continue;
    }
    operands.push(arg);
  }
  if (patterns.length === 0 && operands.length > 0) patterns.push(operands.shift());
  if (patterns.length === 0) return result('', '', 1);
  const matcher = buildSearchMatcher(name, patterns, options);
  if (matcher.error) return result('', `${name}: ${matcher.error}\n`, 2);
  const hasPipedInput = stdin !== undefined && stdin !== null && stdin !== '';
  const targets = operands.length > 0 ? operands : (hasPipedInput ? [] : ['.']);
  if (targets.length === 0) {
    const res = await searchContent(runner, '<stdin>', stdin || '', matcher, {
      ...options,
      lineNumbers: options.lineNumbersExplicit ? options.lineNumbers : false,
      showPath: false,
    });
    return result(options.quiet ? '' : res.stdout, '', res.matches === 0 ? 1 : 0);
  }
  let out = '';
  let matches = 0;
  for (const path of targets) {
    const res = await searchPath(runner, path, matcher, { ...options, showPathForRootFile: targets.length > 1 });
    if (!options.quiet) out += res.stdout;
    matches += res.matches;
    if (options.quiet && matches > 0) break;
  }
  return result(options.quiet ? '' : out, '', matches === 0 ? 1 : 0);
}

function applySearchFlag(options, arg) {
  switch (arg) {
    case '-n':
    case '--line-number':
      options.lineNumbers = true;
      options.lineNumbersExplicit = true;
      return;
    case '-N':
    case '--no-line-number':
      options.lineNumbers = false;
      options.lineNumbersExplicit = true;
      return;
    case '-i':
    case '--ignore-case':
      options.ignoreCase = true;
      return;
    case '-E':
    case '--extended-regexp':
      options.extendedRegex = true;
      options.fixedStrings = false;
      return;
    case '-F':
    case '--fixed-strings':
      options.fixedStrings = true;
      return;
    case '-q':
    case '--quiet':
    case '--silent':
      options.quiet = true;
      return;
    case '-v':
    case '--invert-match':
      options.invertMatch = true;
      return;
    case '-l':
    case '--files-with-matches':
      options.filesWithMatches = true;
      options.filesWithoutMatch = false;
      return;
    case '-L':
    case '--files-without-match':
      options.filesWithoutMatch = true;
      options.filesWithMatches = false;
      return;
    case '-o':
    case '--only-matching':
      options.onlyMatching = true;
      return;
    case '-r':
    case '-R':
    case '--recursive':
      options.recursive = true;
      return;
    case '-c':
    case '--count':
      options.countOnly = true;
      return;
    case '-w':
    case '--word-regexp':
      options.wordMatch = true;
      return;
    case '-h':
    case '--no-filename':
      options.filenameMode = 'never';
      return;
    case '-H':
    case '--with-filename':
      options.filenameMode = 'always';
      return;
    case '-s':
    case '--no-messages':
      return;
    default:
      break;
  }
  if (/^-[A-Za-z]+$/.test(arg)) {
    for (const flag of arg.slice(1)) applySearchFlag(options, `-${flag}`);
  }
}

function buildSearchMatcher(name, patterns, options) {
  if (options.wordMatch) {
    // Word matching routes through the regex engine even for -F patterns
    const sources = options.fixedStrings
      ? patterns.map((pattern) => pattern.replace(/[\\^$+?.()|{}[\]*]/g, '\\$&'))
      : patterns.map((pattern) => name === 'grep' && !options.extendedRegex ? basicGrepPatternToRegExp(pattern) : pattern);
    try {
      const regex = new RegExp(sources.map((source) => `\\b(?:${source})\\b`).join('|'), options.ignoreCase ? 'i' : '');
      return {
        fixed: false,
        test(text) {
          regex.lastIndex = 0;
          return regex.test(text);
        },
        match(text) {
          regex.lastIndex = 0;
          return regex.exec(text)?.[0] || '';
        },
      };
    } catch (error) {
      return { error: error?.message || 'invalid regular expression' };
    }
  }
  if (options.fixedStrings) {
    const needles = options.ignoreCase ? patterns.map((pattern) => pattern.toLowerCase()) : patterns;
    return {
      fixed: true,
      test(text) {
        const haystack = options.ignoreCase ? text.toLowerCase() : text;
        return needles.some((needle) => haystack.includes(needle));
      },
      match(text) {
        const haystack = options.ignoreCase ? text.toLowerCase() : text;
        for (let i = 0; i < needles.length; i++) {
          const index = haystack.indexOf(needles[i]);
          if (index !== -1) return text.slice(index, index + patterns[i].length);
        }
        return '';
      },
    };
  }
  const flags = options.ignoreCase ? 'i' : '';
  const sources = patterns.map((pattern) => name === 'grep' && !options.extendedRegex ? basicGrepPatternToRegExp(pattern) : pattern);
  try {
    const regex = new RegExp(sources.length === 1 ? sources[0] : sources.map((source) => `(?:${source})`).join('|'), flags);
    return {
      fixed: false,
      test(text) {
        regex.lastIndex = 0;
        return regex.test(text);
      },
      match(text) {
        regex.lastIndex = 0;
        return regex.exec(text)?.[0] || '';
      },
    };
  } catch (error) {
    return { error: error?.message || 'invalid regular expression' };
  }
}

function basicGrepPatternToRegExp(pattern) {
  return pattern
    .replace(/\\\|/g, '|')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\+/g, '+')
    .replace(/\\\?/g, '?')
    .replace(/\\\{/g, '{')
    .replace(/\\\}/g, '}');
}

async function runRgFiles(runner, args) {
  const { globs, operands } = parseRgPathArgs(args);
  const targets = operands;
  const paths = targets.length > 0 ? targets : ['.'];
  let out = '';
  for (const path of paths) {
    const st = await runner.stat(path);
    if (!st.is_dir) {
      if (matchesSearchGlobs(path, globs, runner.workdir)) out += `${path}\n`;
      continue;
    }
    const files = await walkFiles(runner, path);
    for (const file of files) {
      if (!matchesSearchGlobs(file, globs, runner.workdir)) continue;
      out += `${toSlash(relativePath(runner.workdir, file))}\n`;
    }
  }
  return result(out);
}

async function searchPath(runner, path, pattern, options) {
  const st = await runner.stat(path);
  if (!st.is_dir) {
    if (!matchesSearchGlobs(st.path || path, options.globs || [], runner.workdir)) return { stdout: '', matches: 0 };
    return searchFile(runner, path, pattern, { ...options, showPath: options.showPathForRootFile });
  }
  let out = '';
  let matches = 0;
  const files = await walkFiles(runner, path);
  for (const file of files) {
    if (!matchesSearchGlobs(file, options.globs || [], runner.workdir)) continue;
    await runner.yieldToUI();
    const res = await searchFile(runner, file, pattern, { ...options, showPath: true });
    out += res.stdout;
    matches += res.matches;
  }
  return { stdout: out, matches };
}

function parseRgPathArgs(args) {
  const globs = [];
  const operands = [];
  let parsingFlags = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (parsingFlags && arg === '--') {
      parsingFlags = false;
      continue;
    }
    if (parsingFlags && (arg === '-g' || arg === '--glob')) {
      if (i + 1 < args.length) globs.push(args[++i]);
      continue;
    }
    if (parsingFlags && arg.startsWith('--glob=')) {
      globs.push(arg.slice('--glob='.length));
      continue;
    }
    if (parsingFlags && arg.startsWith('-g') && arg.length > 2) {
      globs.push(arg.slice(2));
      continue;
    }
    if (parsingFlags && arg.startsWith('-')) continue;
    operands.push(arg);
  }
  return { globs, operands };
}

async function searchFile(runner, path, pattern, options) {
  const content = await runner.readFile(path);
  return searchContent(runner, path, content, pattern, options);
}

async function searchContent(runner, path, content, matcher, options) {
  const lines = splitLines(content);
  const showPath = options.filenameMode === 'always'
    ? true
    : options.filenameMode === 'never' ? false : options.showPath;

  const matchedIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (i % 1000 === 0) await runner.yieldToUI();
    const matched = matcher.test(lines[i]);
    if (options.invertMatch ? matched : !matched) continue;
    matchedIdx.push(i);
    if (options.filesWithMatches) return { stdout: `${path}\n`, matches: 1 };
    if (options.maxCount > 0 && matchedIdx.length >= options.maxCount) break;
  }
  const matches = matchedIdx.length;
  if (options.filesWithoutMatch) {
    return matches === 0 ? { stdout: `${path}\n`, matches: 1 } : { stdout: '', matches: 0 };
  }
  if (options.countOnly) {
    return { stdout: showPath ? `${path}:${matches}\n` : `${matches}\n`, matches };
  }
  if (matches === 0) return { stdout: '', matches: 0 };

  const prefix = (lineIdx, sep) =>
    (showPath ? `${path}${sep}` : '') + (options.lineNumbers ? `${lineIdx + 1}${sep}` : '');

  let out = '';
  if (options.onlyMatching && !options.invertMatch) {
    for (const i of matchedIdx) {
      const matchedText = matcher.match(lines[i]);
      if (matchedText === '') continue;
      out += `${prefix(i, ':')}${matchedText}\n`;
    }
    return { stdout: out, matches };
  }

  const before = options.beforeContext || 0;
  const after = options.afterContext || 0;
  if (before === 0 && after === 0) {
    for (const i of matchedIdx) out += `${prefix(i, ':')}${lines[i]}\n`;
    return { stdout: out, matches };
  }

  // Context mode: merge overlapping ranges; context lines use '-' separators
  const isMatch = new Set(matchedIdx);
  const ranges = [];
  for (const i of matchedIdx) {
    const start = Math.max(0, i - before);
    const end = Math.min(lines.length - 1, i + after);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  for (let r = 0; r < ranges.length; r++) {
    if (r > 0) out += '--\n';
    for (let i = ranges[r].start; i <= ranges[r].end; i++) {
      out += `${prefix(i, isMatch.has(i) ? ':' : '-')}${lines[i]}\n`;
    }
  }
  return { stdout: out, matches };
}

async function walkFiles(runner, root) {
  const files = [];
  const walk = async (path) => {
    await runner.yieldToUI();
    const entries = await runner.listDir(path);
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (entry.is_dir) await walk(entry.path);
      else files.push(entry.path);
    }
  };
  await walk(root);
  return files;
}

export {
  applySearchFlag,
  basicGrepPatternToRegExp,
  buildSearchMatcher,
  parseRgPathArgs,
  runRgFiles,
  runSearch,
  searchContent,
  searchFile,
  searchPath,
  walkFiles,
};
