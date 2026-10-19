import {
  basename,
  nonFlagArgs,
  relativePath,
  result,
  toSlash,
} from '../utils.js';
import { globPatternMatches } from './glob.js';

async function runCat(runner, args, stdin) {
  if (args.length === 0) return result(stdin || '');
  let out = '';
  for (const path of args) {
    await runner.yieldToUI();
    out += path === '-' ? (stdin || '') : await runner.readFile(path);
  }
  return result(out);
}

async function runMkdir(runner, args) {
  const recursive = args.includes('-p');
  const paths = args.filter((arg) => !arg.startsWith('-'));
  for (const path of paths) await runner.mkdir(path, recursive);
  return result();
}

async function runRm(runner, args) {
  let force = false;
  let recursive = false;
  const paths = [];
  for (const arg of args) {
    if (arg.startsWith('-')) {
      force ||= arg.includes('f');
      recursive ||= arg.includes('r') || arg.includes('R');
    } else {
      paths.push(arg);
    }
  }
  for (const path of paths) {
    try {
      await runner.deletePath(path, recursive);
    } catch (error) {
      if (!force) throw error;
    }
  }
  return result();
}

async function runTouch(runner, args) {
  for (const path of args.filter((arg) => !arg.startsWith('-'))) await runner.touch(path);
  return result();
}

async function runCp(runner, args) {
  const operands = nonFlagArgs(args);
  if (operands.length !== 2) return result('', 'cp: expected source and destination\n', 1);
  const content = await runner.readFile(operands[0]);
  await runner.writeFile(operands[1], content, false);
  return result();
}

async function runMv(runner, args) {
  const operands = nonFlagArgs(args);
  if (operands.length !== 2) return result('', 'mv: expected source and destination\n', 1);
  await runner.rename(operands[0], operands[1]);
  return result();
}

async function runLs(runner, args) {
  const targets = nonFlagArgs(args);
  const paths = targets.length > 0 ? targets : ['.'];
  let out = '';
  for (let i = 0; i < paths.length; i++) {
    await runner.yieldToUI();
    const path = paths[i];
    const st = await runner.stat(path);
    if (paths.length > 1) {
      if (i > 0) out += '\n';
      out += `${path}:\n`;
    }
    if (!st.is_dir) {
      out += `${basename(path)}\n`;
      continue;
    }
    const entries = await runner.listDir(path);
    for (const entry of entries) out += `${entry.name}\n`;
  }
  return result(out);
}

function runBasename(args) {
  if (args.length === 0) return result('', '', 1);
  let base = basename(args[0]);
  if (args[1] && base.endsWith(args[1])) base = base.slice(0, -args[1].length);
  return result(`${base}\n`);
}

function runDirname(args) {
  if (args.length === 0) return result('', '', 1);
  const path = toSlash(args[0]).replace(/\/+$/, '');
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return result(`${idx === 0 ? '/' : '.'}\n`);
  return result(`${path.slice(0, idx)}\n`);
}

async function runTee(runner, args, stdin) {
  const append = args.includes('-a') || args.includes('--append');
  const paths = args.filter((arg) => !arg.startsWith('-'));
  const text = stdin || '';
  for (const path of paths) await runner.writeFile(path, text, append);
  return result(text);
}

async function runFind(runner, args) {
  const parsed = parseFindArgs(args);
  let out = '';
  for (const root of parsed.roots) {
    const entries = [root, ...await walkEntries(runner, root)];
    for (const entry of entries) {
      const relDepth = relativePath(root, entry).split('/').filter(Boolean).length;
      if (parsed.maxDepth !== null && relDepth > parsed.maxDepth) continue;
      if (parsed.minDepth !== null && relDepth < parsed.minDepth) continue;
      const st = await runner.stat(entry);
      if (parsed.type === 'f' && st.is_dir) continue;
      if (parsed.type === 'd' && !st.is_dir) continue;
      if (parsed.name && !globPatternMatches(basename(entry), parsed.name)) continue;
      out += `${entry}\n`;
    }
  }
  return result(out);
}

function parseFindArgs(args) {
  const roots = [];
  let type = '';
  let name = '';
  let maxDepth = null;
  let minDepth = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-type' && i + 1 < args.length) type = args[++i];
    else if (arg === '-name' && i + 1 < args.length) name = args[++i];
    else if (arg === '-maxdepth' && i + 1 < args.length) maxDepth = Number.parseInt(args[++i], 10);
    else if (arg === '-mindepth' && i + 1 < args.length) minDepth = Number.parseInt(args[++i], 10);
    else if (!arg.startsWith('-')) roots.push(arg);
  }
  return {
    roots: roots.length > 0 ? roots : ['.'],
    type,
    name,
    maxDepth: Number.isFinite(maxDepth) ? maxDepth : null,
    minDepth: Number.isFinite(minDepth) ? minDepth : null,
  };
}

async function walkEntries(runner, root) {
  const entries = [];
  const walk = async (path) => {
    const st = await runner.stat(path);
    if (!st.is_dir) return;
    for (const entry of await runner.listDir(path)) {
      entries.push(entry.path);
      if (entry.is_dir) await walk(entry.path);
    }
  };
  await walk(root);
  return entries;
}

export {
  parseFindArgs,
  runBasename,
  runCat,
  runCp,
  runDirname,
  runFind,
  runLs,
  runMkdir,
  runMv,
  runRm,
  runTee,
  runTouch,
  walkEntries,
};
