import { result, splitLines } from '../utils.js';
import {
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
} from './builtins.js';
import { runAwk } from './awk.js';
import { runDiff } from './diff.js';
import {
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
} from './fs-commands.js';
import { isSupportedCommand } from './registry.js';
import { runSearch } from './search.js';
import { runSed } from './sed.js';
import {
  runCut,
  runHeadTail,
  runNumberLines,
  runSort,
  runTr,
  runUniq,
  runWordCount,
} from './text-filters.js';

export async function dispatchCommand(runner, name, args, stdin) {
  switch (name) {
    case ':':
    case '.':
      return result();
    case 'true':
      return result();
    case 'false':
      return result('', '', 1);
    case 'break':
      return { ...result(), signal: 'break', signalDepth: loopDepth(args[0]) };
    case 'continue':
      return { ...result(), signal: 'continue', signalDepth: loopDepth(args[0]) };
    case 'exit':
      return { ...result('', '', exitCodeArg(args[0])), signal: 'exit' };
    case 'return':
      return { ...result('', '', exitCodeArg(args[0])), signal: 'return' };
    case 'pwd':
      return result(`${runner.workdir}\n`);
    case 'cd':
      return runCd(runner, args);
    case 'eval':
      return runner.run(args.join(' '));
    case 'command':
      return runCommandBuiltin(runner, args, stdin);
    case 'which':
      return runWhich(args);
    case 'env':
      return runEnv(runner, args, stdin);
    case 'printenv':
      return runPrintenv(runner, args);
    case 'export':
      return runExport(runner, args);
    case 'unset':
      return runUnset(runner, args);
    case 'set':
      return runSet(runner, args);
    case 'shift':
      return result();
    case 'read':
      return runRead(runner, args, stdin);
    case 'test':
      return result('', '', await runner.evaluateTestCommand(args) ? 0 : 1);
    case '[':
      if (args[args.length - 1] !== ']') return result('', '[: missing ]\n', 2);
      return result('', '', await runner.evaluateTestCommand(args.slice(0, -1)) ? 0 : 1);
    case 'echo':
      return runEcho(args);
    case 'printf':
      return runPrintf(args);
    case 'cat':
    case 'type':
      return runCat(runner, args, stdin);
    case 'sleep':
      return runSleep(runner, args);
    case 'mkdir':
      return runMkdir(runner, args);
    case 'rm':
      return runRm(runner, args);
    case 'touch':
      return runTouch(runner, args);
    case 'cp':
      return runCp(runner, args);
    case 'mv':
      return runMv(runner, args);
    case 'ls':
      return runLs(runner, args);
    case 'sed':
      return runSed(runner, args, stdin);
    case 'awk':
    case 'gawk':
      return runAwk(runner, args, stdin);
    case 'diff':
      return runDiff(runner, args, stdin);
    case 'grep':
    case 'rg':
      return runSearch(runner, name, args, stdin);
    case 'nl':
      return runNumberLines(runner, args, stdin);
    case 'wc':
      return runWordCount(runner, args, stdin);
    case 'head':
      return runHeadTail(runner, args, stdin, false);
    case 'tail':
      return runHeadTail(runner, args, stdin, true);
    case 'sort':
      return runSort(runner, args, stdin);
    case 'uniq':
      return runUniq(runner, args, stdin);
    case 'cut':
      return runCut(runner, args, stdin);
    case 'tr':
      return runTr(args, stdin);
    case 'basename':
      return runBasename(args);
    case 'dirname':
      return runDirname(args);
    case 'tee':
      return runTee(runner, args, stdin);
    case 'find':
      return runFind(runner, args);
    case 'xargs':
      return runXargs(runner, args, stdin);
    case 'cmd':
    case 'cmd.exe':
      if (args.length >= 2 && args[0].toLowerCase() === '/c' && args[1].toLowerCase() === 'type') {
        return runCat(runner, args.slice(2), stdin);
      }
      return result('', `${name}: command not supported\n`, 127);
    default:
      return result('', `${name}: command not supported\n`, 127);
  }
}

function exitCodeArg(value) {
  if (value === undefined || value === '') return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) & 255 : 2;
}

function loopDepth(value) {
  const parsed = Number.parseInt(value || '1', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

async function runCommandBuiltin(runner, args, stdin) {
  if (args.length === 0) return result();
  if (args[0] === '-v' || args[0] === '-V') {
    const names = args.slice(1);
    let out = '';
    let missing = 0;
    for (const name of names) {
      if (isSupportedCommand(name)) out += `${name}\n`;
      else missing++;
    }
    return result(out, '', missing > 0 && out === '' ? 1 : 0);
  }
  if (args[0] === '--') args = args.slice(1);
  if (args.length === 0) return result();
  const target = args[0];
  if (!isSupportedCommand(target) || target === 'command') {
    return result('', `${target}: command not supported\n`, 127);
  }
  return dispatchCommand(runner, target, args.slice(1), stdin);
}

async function runEnv(runner, args, stdin) {
  const assignments = {};
  let commandIndex = -1;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-i' || arg === '--ignore-environment') continue;
    if (arg === 'env') continue;
    const eq = arg.indexOf('=');
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg.slice(0, eq))) {
      assignments[arg.slice(0, eq)] = arg.slice(eq + 1);
      continue;
    }
    commandIndex = i;
    break;
  }
  if (commandIndex !== -1) {
    const previous = {};
    for (const [key, value] of Object.entries(assignments)) {
      previous[key] = runner.env[key];
      runner.env[key] = value;
    }
    try {
      const target = args[commandIndex];
      if (!isSupportedCommand(target) || target === 'env') return result('', `${target}: command not supported\n`, 127);
      return await dispatchCommand(runner, target, args.slice(commandIndex + 1), stdin);
    } finally {
      for (const key of Object.keys(assignments)) {
        if (previous[key] === undefined) delete runner.env[key];
        else runner.env[key] = previous[key];
      }
    }
  }
  const env = { ...runner.env, ...assignments };
  return result(formatEnv(env));
}

async function runXargs(runner, args, stdin) {
  let placeholder = '';
  let nullSeparated = false;
  let commandIndex = -1;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-I' && i + 1 < args.length) { placeholder = args[++i]; continue; }
    if (arg.startsWith('-I') && arg.length > 2) { placeholder = arg.slice(2); continue; }
    if (arg === '-0' || arg === '--null') { nullSeparated = true; continue; }
    if (arg === '-n' && i + 1 < args.length) { i++; continue; } // batching hint — ignored
    if (arg === '-r' || arg === '--no-run-if-empty') continue;
    if (!arg.startsWith('-')) { commandIndex = i; break; }
  }

  const raw = String(stdin || '');
  const tokens = nullSeparated
    ? raw.split('\0').filter(Boolean)
    : (placeholder ? splitLines(raw).map((line) => line.trim()).filter(Boolean) : raw.trim().split(/\s+/).filter(Boolean));
  if (tokens.length === 0) return result();
  if (commandIndex === -1) return result(tokens.join(' ') + '\n');

  const command = args[commandIndex];
  if (!isSupportedCommand(command) || command === 'xargs') return result('', `${command}: command not supported\n`, 127);
  const commandArgs = args.slice(commandIndex + 1);

  if (placeholder) {
    // -I: run the command once per input line with the placeholder replaced
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    for (const token of tokens) {
      const substituted = commandArgs.map((arg) => arg.split(placeholder).join(token));
      const res = await dispatchCommand(runner, command, substituted, '');
      stdout += res.stdout || '';
      stderr += res.stderr || '';
      if (res.exitCode) exitCode = res.exitCode;
    }
    return result(stdout, stderr, exitCode);
  }

  return dispatchCommand(runner, command, [...commandArgs, ...tokens], '');
}
