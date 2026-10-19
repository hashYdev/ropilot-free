import { result, splitLines } from '../utils.js';
import { isSupportedCommand } from './registry.js';

async function runCd(runner, args) {
  if (args[0]) {
    const st = await runner.stat(args[0]);
    if (!st.exists || !st.is_dir) return result('', `cd: ${args[0]}: No such directory\n`, 1);
    runner.workdir = st.path || args[0];
  }
  runner.env.PWD = runner.workdir;
  return result();
}

function runWhich(args) {
  let out = '';
  let missing = 0;
  for (const name of args.filter((arg) => !arg.startsWith('-'))) {
    if (isSupportedCommand(name)) out += `${name}\n`;
    else missing++;
  }
  return result(out, '', missing > 0 && out === '' ? 1 : 0);
}

function runPrintenv(runner, args) {
  const names = args.filter((arg) => !arg.startsWith('-'));
  if (names.length === 0) return result(formatEnv(runner.env));
  let out = '';
  let missing = 0;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(runner.env, name)) out += `${runner.env[name]}\n`;
    else missing++;
  }
  return result(out, '', missing > 0 && out === '' ? 1 : 0);
}

function formatEnv(env) {
  return Object.keys(env)
    .sort()
    .map((key) => `${key}=${env[key] ?? ''}`)
    .join('\n') + '\n';
}

async function runExport(runner, args) {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) {
      if (!Object.prototype.hasOwnProperty.call(runner.env, arg)) runner.env[arg] = '';
      continue;
    }
    runner.env[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return result();
}

function runSet(runner, args) {
  if (args.length === 0) return result(formatEnv(runner.env));
  for (const arg of args) {
    if (arg === '-e' || arg === '+e' || arg === '-u' || arg === '+u' || arg === '-o' || arg === '+o') continue;
    if (arg.includes('=')) {
      const eq = arg.indexOf('=');
      const key = arg.slice(0, eq);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) runner.env[key] = arg.slice(eq + 1);
    }
  }
  return result();
}

function runRead(runner, args, stdin) {
  const names = args.filter((arg) => !arg.startsWith('-'));
  if (names.length === 0) return result('', '', 1);
  const line = splitLines(stdin || '')[0] || '';
  const parts = line.split(/\s+/);
  for (let i = 0; i < names.length; i++) {
    if (i === names.length - 1) runner.env[names[i]] = parts.slice(i).join(' ');
    else runner.env[names[i]] = parts[i] || '';
  }
  return result();
}

function runUnset(runner, args) {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    delete runner.env[arg];
    delete runner.functions[arg];
  }
  return result();
}

function runEcho(args) {
  let newline = true;
  let interpretEscapes = false;
  let index = 0;
  while (index < args.length && /^-[neE]+$/.test(args[index])) {
    if (args[index].includes('n')) newline = false;
    if (args[index].includes('e')) interpretEscapes = true;
    if (args[index].includes('E')) interpretEscapes = false;
    index++;
  }
  let text = args.slice(index).join(' ');
  if (interpretEscapes) {
    text = text.replace(/\\(\\|n|t|r|0)/g, (_, ch) => (
      ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch === '0' ? '\0' : '\\'
    ));
  }
  return result(text + (newline ? '\n' : ''));
}

function runPrintf(args) {
  if (args.length === 0) return result();
  let index = 1;
  const out = args[0].replace(/%s|%d|%i|%f|%%|\\n|\\t|\\r/g, (token) => {
    if (token === '%%') return '%';
    if (token === '\\n') return '\n';
    if (token === '\\t') return '\t';
    if (token === '\\r') return '\r';
    return args[index++] || '';
  });
  return result(out);
}

async function runSleep(runner, args) {
  const seconds = Number(args[0] || '0');
  if (!Number.isFinite(seconds) || seconds < 0) return result('', '', 1);
  const ms = Math.min(runner.timeoutMs, Math.round(seconds * 1000));
  await new Promise((resolve) => setTimeout(resolve, ms));
  return result('', '', ms >= runner.timeoutMs ? 124 : 0, '', ms >= runner.timeoutMs);
}

export {
  formatEnv,
  runCd,
  runEcho,
  runExport,
  runPrintenv,
  runPrintf,
  runRead,
  runSet,
  runSleep,
  runUnset,
  runWhich,
};
