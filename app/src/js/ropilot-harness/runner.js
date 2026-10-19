import { dispatchCommand } from './commands/index.js';
import { prepareCommand } from './prepare-command.js';
import {
  byteLength,
  capStringBytes,
  createYieldController,
  expandVariables,
  isDevNull,
  result,
  wordRaw,
} from './utils.js';

let fallbackParserPromise = null;

function loadFallbackParser() {
  if (!fallbackParserPromise) fallbackParserPromise = import('./parser.js');
  return fallbackParserPromise;
}

const PARAM_OP = {
  PLUS: 68,
  COLON_PLUS: 69,
  MINUS: 70,
  COLON_MINUS: 71,
  QUESTION: 72,
  COLON_QUESTION: 73,
  ASSIGN: 74,
  COLON_ASSIGN: 75,
};

const ARITH_OP = {
  AND_AND: 10,
  OR_OR: 11,
  BIT_AND: 9,
  BIT_OR: 12,
  INC: 36,
  DEC: 37,
  MUL: 38,
  POW: 39,
  EQ: 40,
  NE: 41,
  LE: 42,
  GE: 43,
  ADD_ASSIGN: 44,
  SUB_ASSIGN: 45,
  MUL_ASSIGN: 46,
  DIV_ASSIGN: 47,
  REM_ASSIGN: 48,
  AND_ASSIGN: 49,
  OR_ASSIGN: 50,
  XOR_ASSIGN: 51,
  SHL_ASSIGN: 52,
  SHR_ASSIGN: 53,
  GT: 54,
  SHR: 55,
  LT: 56,
  SHL: 61,
  ADD: 68,
  SUB: 70,
  ASSIGN: 74,
  REM: 76,
  BIT_XOR: 80,
  COMMA: 82,
  DIV: 85,
};

const TEST_OP = {
  AND: 10,
  OR: 11,
  NOT: 34,
  MATCH_SHORT: 74,
  MATCH: 40,
  NO_MATCH: 41,
  BEFORE: 56,
  AFTER: 54,
  EXISTS: 88,
  REG_FILE: 89,
  DIRECTORY: 90,
  NON_EMPTY_FILE: 105,
  EMPTY_STRING: 107,
  NON_EMPTY_STRING: 108,
  VAR_SET: 110,
  REGEX_MATCH: 112,
  NUM_EQ: 116,
  NUM_NE: 117,
  NUM_LE: 118,
  NUM_GE: 119,
  NUM_LT: 120,
  NUM_GT: 121,
};

const CASE_OP = {
  BREAK: 30,
  FALLTHROUGH: 31,
  RESUME: 32,
  RESUME_KORN: 33,
};

export class ShellRunner {
  constructor(harness, options) {
    this.harness = harness;
    this.requestId = options.requestId;
    this.workdir = options.workdir;
    this.timeoutMs = options.timeoutMs;
    this.maxOutputBytes = options.maxOutputBytes;
    this.deadlineAt = Date.now() + this.timeoutMs;
    this._yieldToUI = createYieldController();
    this.env = {
      PWD: this.workdir,
      HOME: '',
      TMPDIR: '/tmp',
      TEMP: '/tmp',
      TMP: '/tmp',
      ...(options.env || {}),
    };
    this.functions = {};
  }

  async run(command) {
    const { parseScript } = await this.loadParser();
    const script = await parseScript(prepareCommand(command));
    const output = await this.runSequence(script, '');
    if (output.signal === 'exit' || output.signal === 'return') {
      return this.capResult({ ...output, signal: undefined, signalDepth: undefined });
    }
    return this.capResult(output);
  }

  async loadParser() {
    if (typeof this.harness?.loadParser === 'function') {
      return this.harness.loadParser();
    }
    return loadFallbackParser();
  }

  checkTimeout() {
    if (Date.now() <= this.deadlineAt) return;
    const error = new Error('harness execution timed out');
    error.exitCode = 124;
    error.timedOut = true;
    throw error;
  }

  async yieldToUI() {
    this.checkTimeout();
    await this._yieldToUI();
    this.checkTimeout();
  }

  async runSequence(nodes, stdin = '') {
    let final = result();
    let stdout = '';
    let stderr = '';
    for (const node of nodes || []) {
      this.checkTimeout();
      final = await this.runExecutionNode(node, stdin);
      stdout += final.stdout || '';
      stderr += final.stderr || '';
      stdin = '';
      if (final.timedOut || final.signal) break;
    }
    return this.capResult({ ...final, stdout, stderr });
  }

  async runExecutionNode(node, stdin = '') {
    switch (node?.type) {
      case 'command':
        return this.runSimpleCommand(await this.expandCommand(node), stdin);
      case 'pipeline':
        return this.runPipeline(node.commands, stdin, node.pipeAll === true);
      case 'list':
        return this.runList(node.items, stdin);
      case 'block':
        return this.runSequence(node.statements, stdin);
      case 'subshell':
        return this.withSubshell(() => this.runSequence(node.statements, stdin));
      case 'redirected':
        return this.runRedirected(node, stdin);
      case 'if':
        return this.runIf(node, stdin);
      case 'for':
        return this.runFor(node, stdin);
      case 'cfor':
        return this.runCStyleFor(node, stdin);
      case 'while':
        return this.runWhile(node, stdin);
      case 'case':
        return this.runCase(node, stdin);
      case 'arithmcmd':
        return this.runArithmCommand(node);
      case 'let':
        return this.runLet(node);
      case 'testclause':
        return this.runTestClause(node);
      case 'decl':
        return this.runDecl(node);
      case 'funcdecl':
        return this.runFuncDecl(node);
      case 'not': {
        const out = await this.runExecutionNode(node.node, stdin);
        return { ...out, exitCode: out.exitCode === 0 ? 1 : 0 };
      }
      case 'background':
        return this.runExecutionNode(node.node, stdin);
      case 'unsupported':
        return result('', `unsupported shell node: ${node.shellType || 'unknown'}\n`, 2);
      default:
        return result('', `unsupported shell node: ${node?.type || 'unknown'}\n`, 2);
    }
  }

  async runList(items, stdin = '') {
    let final = result();
    let stdout = '';
    let stderr = '';
    for (const item of items || []) {
      if (item.op === '&&' && final.exitCode !== 0) continue;
      if (item.op === '||' && final.exitCode === 0) continue;
      final = await this.runExecutionNode(item.node, stdin);
      stdout += final.stdout || '';
      stderr += final.stderr || '';
      stdin = '';
      if (final.signal || final.timedOut) break;
    }
    return this.capResult({ ...final, stdout, stderr });
  }

  async runPipeline(commands, stdin = '', pipeAll = false) {
    let input = stdin || '';
    let final = result();
    let stderr = '';
    for (const command of commands || []) {
      final = await this.runExecutionNode(command, input);
      input = (final.stdout || '') + (pipeAll ? (final.stderr || '') : '');
      if (!pipeAll) stderr += final.stderr || '';
    }
    return this.capResult({ ...final, stdout: final.stdout || '', stderr: pipeAll ? '' : stderr });
  }

  async runRedirected(node, stdin = '') {
    return this.withRedirects(node.redirects || [], stdin, (input) => this.runExecutionNode(node.node, input));
  }

  async runIf(node, stdin = '') {
    const condition = await this.runSequence(node.condition || [], stdin);
    const branch = condition.exitCode === 0 ? node.thenStatements : node.elseStatements;
    const branchOutput = await this.runSequence(branch || [], '');
    return this.capResult({
      ...branchOutput,
      stdout: (condition.stdout || '') + (branchOutput.stdout || ''),
      stderr: (condition.stderr || '') + (branchOutput.stderr || ''),
    });
  }

  async runFor(node, stdin = '') {
    if (!node.name) return result('', 'for: missing loop variable\n', 2);
    let final = result();
    let stdout = '';
    let stderr = '';
    const items = [];
    for (const word of node.items || []) {
      items.push(...await this.expandWordFields(word));
    }
    for (const value of items) {
      this.env[node.name] = value;
      final = await this.runSequence(node.body || [], stdin);
      stdout += final.stdout || '';
      stderr += final.stderr || '';
      stdin = '';
      const handled = this.handleLoopSignal(final);
      if (handled === 'break') break;
      if (handled === 'continue') continue;
      if (final.signal) return this.capResult({ ...final, stdout, stderr });
    }
    return this.capResult({ ...final, stdout, stderr });
  }

  async runCStyleFor(node, stdin = '') {
    if (node.init) await this.evaluateArithmetic(node.init);
    let final = result();
    let stdout = '';
    let stderr = '';
    while (!node.condition || (await this.evaluateArithmetic(node.condition)) !== 0) {
      this.checkTimeout();
      final = await this.runSequence(node.body || [], stdin);
      stdout += final.stdout || '';
      stderr += final.stderr || '';
      stdin = '';
      const handled = this.handleLoopSignal(final);
      if (handled === 'break') break;
      if (final.signal && handled !== 'continue') return this.capResult({ ...final, stdout, stderr });
      if (node.post) await this.evaluateArithmetic(node.post);
    }
    return this.capResult({ ...final, stdout, stderr, signal: undefined, signalDepth: undefined });
  }

  async runWhile(node, stdin = '') {
    let final = result();
    let stdout = '';
    let stderr = '';
    let ranBody = false;
    while (true) {
      this.checkTimeout();
      const condition = await this.runSequence(node.condition || [], stdin);
      stdout += condition.stdout || '';
      stderr += condition.stderr || '';
      const shouldStop = (condition.exitCode === 0) === (node.until === true);
      if (shouldStop) {
        break;
      }
      final = await this.runSequence(node.body || [], '');
      ranBody = true;
      stdout += final.stdout || '';
      stderr += final.stderr || '';
      const handled = this.handleLoopSignal(final);
      if (handled === 'break') break;
      if (handled === 'continue') continue;
      if (final.signal) return this.capResult({ ...final, stdout, stderr });
    }
    if (!ranBody) final = result();
    return this.capResult({ ...final, stdout, stderr, signal: undefined, signalDepth: undefined });
  }

  async runCase(node, stdin = '') {
    const value = await this.expandWord(node.word);
    let matched = false;
    let final = result();
    let stdout = '';
    let stderr = '';
    for (const item of node.items || []) {
      if (!matched) {
        for (const pattern of item.patterns || []) {
          if (casePatternMatches(await this.expandWord(pattern), value)) {
            matched = true;
            break;
          }
        }
      }
      if (!matched) continue;
      final = await this.runSequence(item.statements || [], stdin);
      stdout += final.stdout || '';
      stderr += final.stderr || '';
      stdin = '';
      if (final.signal || final.timedOut) break;
      if (item.op === CASE_OP.FALLTHROUGH) {
        matched = true;
        continue;
      }
      if (item.op === CASE_OP.RESUME || item.op === CASE_OP.RESUME_KORN) {
        matched = false;
        continue;
      }
      break;
    }
    return this.capResult({ ...final, stdout, stderr });
  }

  async runArithmCommand(node) {
    const value = await this.evaluateArithmetic(node.expr);
    return result('', '', value === 0 ? 1 : 0);
  }

  async runLet(node) {
    let value = 0;
    for (const expr of node.exprs || []) value = await this.evaluateArithmetic(expr);
    return result('', '', value === 0 ? 1 : 0);
  }

  async runTestClause(node) {
    return result('', '', await this.evaluateTestExpr(node.expr) ? 0 : 1);
  }

  async runDecl(node) {
    const variant = String(node.variant || '');
    if (!['declare', 'export', 'local', 'readonly', 'typeset', 'nameref'].includes(variant)) {
      return result('', `${variant}: declaration not supported\n`, 2);
    }
    for (const assignment of node.assignments || []) {
      if (!assignment.name || assignment.name.startsWith('-')) continue;
      if (assignment.naked) {
        if (!Object.prototype.hasOwnProperty.call(this.env, assignment.name)) this.env[assignment.name] = '';
        continue;
      }
      const value = await this.expandWord(assignment.value);
      this.env[assignment.name] = assignment.append ? (this.env[assignment.name] || '') + value : value;
    }
    return result();
  }

  async runFuncDecl(node) {
    if (!node.name || !node.body) return result('', 'function: invalid declaration\n', 2);
    this.functions[node.name] = node.body;
    return result();
  }

  handleLoopSignal(output) {
    if (!output?.signal) return '';
    if (output.signal !== 'break' && output.signal !== 'continue') return '';
    const signal = output.signal;
    const depth = Math.max(1, Number(output.signalDepth || 1)) - 1;
    if (depth > 0) {
      output.signalDepth = depth;
      return '';
    }
    output.signal = undefined;
    output.signalDepth = undefined;
    return signal;
  }

  async withSubshell(fn) {
    const env = { ...this.env };
    const workdir = this.workdir;
    const functions = { ...this.functions };
    try {
      return await fn();
    } finally {
      this.env = env;
      this.workdir = workdir;
      this.functions = functions;
    }
  }

  async expandCommand(command) {
    return {
      assignments: command.assignments,
      args: (await Promise.all((command.args || []).map((arg) => this.expandWordFields(arg)))).flat(),
      redirects: await Promise.all((command.redirects || []).map(async (redirect) => ({
        ...redirect,
        target: await this.expandWord(redirect.target),
      }))),
    };
  }

  async expandWordFields(word) {
    const value = await this.expandWord(word);
    if (value === null) return [];
    if (!word?.quoted && hasGlob(value)) {
      const matches = await this.expandGlob(value);
      if (matches.length > 0) return matches;
    }
    return [value];
  }

  async expandWord(word) {
    if (!word) return '';
    let value = '';
    for (const part of word.parts || []) {
      if (part.type === 'single') value += part.value;
      else if (part.type === 'var') value += await this.expandParam(part);
      else if (part.type === 'cmdsubst') value += await this.expandCommandSubstitution(part);
      else if (part.type === 'arithm') value += String(await this.evaluateArithmetic(part.expr ?? part.value));
      else value += expandVariables(part.value, this.env);
    }
    return value;
  }

  async expandParam(part) {
    const name = part.name || '';
    const current = this.env[name] || '';
    const isSet = Object.prototype.hasOwnProperty.call(this.env, name);
    const isNonEmpty = current !== '';
    const value = part.value ? await this.expandWord(part.value) : '';
    if (part.length) return String(current.length);

    switch (Number(part.op || 0)) {
      case PARAM_OP.MINUS:
        return isSet ? current : value;
      case PARAM_OP.COLON_MINUS:
        return isNonEmpty ? current : value;
      case PARAM_OP.PLUS:
        return isSet ? value : '';
      case PARAM_OP.COLON_PLUS:
        return isNonEmpty ? value : '';
      case PARAM_OP.ASSIGN:
        if (!isSet) this.env[name] = value;
        return this.env[name] || '';
      case PARAM_OP.COLON_ASSIGN:
        if (!isNonEmpty) this.env[name] = value;
        return this.env[name] || '';
      case PARAM_OP.QUESTION:
        if (!isSet) throw this.shellError(value || `${name}: parameter null or not set`, 1);
        return current;
      case PARAM_OP.COLON_QUESTION:
        if (!isNonEmpty) throw this.shellError(value || `${name}: parameter null or not set`, 1);
        return current;
      default:
        return current;
    }
  }

  async expandCommandSubstitution(part) {
    const out = await this.withSubshell(() => this.runSequence(part.statements || [], ''));
    return (out.stdout || '').replace(/\n+$/g, '');
  }

  expandArithmetic(text) {
    const substituted = expandVariables(String(text || ''), this.env);
    if (!/^[0-9+\-*/%() <<>>&|^~!?:.]+$/.test(substituted)) return '0';
    try {
      // Arithmetic expansion is deliberately numeric-only after variable expansion.
      return String(Number(Function(`"use strict"; return (${substituted || '0'});`)()) || 0);
    } catch {
      return '0';
    }
  }

  async evaluateArithmetic(expr) {
    if (!expr) return 0;
    if (typeof expr === 'string') return toShellNumber(this.expandArithmetic(expr));

    switch (expr.type) {
      case 'word': {
        const name = this.arithmeticVariableName(expr);
        if (name) return toShellNumber(this.env[name] || '0');
        return toShellNumber(await this.expandWord(expr.word));
      }
      case 'text':
        return toShellNumber(this.expandArithmetic(expr.value));
      case 'paren':
        return this.evaluateArithmetic(expr.expr);
      case 'unary':
        return this.evaluateUnaryArithmetic(expr);
      case 'binary':
        return this.evaluateBinaryArithmetic(expr);
      default:
        return 0;
    }
  }

  async evaluateUnaryArithmetic(expr) {
    const name = this.arithmeticVariableName(expr.expr);
    if (expr.op === ARITH_OP.INC || expr.op === ARITH_OP.DEC) {
      if (!name) return 0;
      const oldValue = toShellNumber(this.env[name] || '0');
      const nextValue = oldValue + (expr.op === ARITH_OP.INC ? 1 : -1);
      this.env[name] = String(nextValue);
      return expr.post ? oldValue : nextValue;
    }

    const value = await this.evaluateArithmetic(expr.expr);
    switch (expr.op) {
      case 34:
        return value === 0 ? 1 : 0;
      case 35:
        return ~value;
      case ARITH_OP.ADD:
        return value;
      case ARITH_OP.SUB:
        return -value;
      default:
        return value;
    }
  }

  async evaluateBinaryArithmetic(expr) {
    const assignmentName = this.arithmeticVariableName(expr.left);
    if (isArithmeticAssignment(expr.op) && assignmentName) {
      const current = toShellNumber(this.env[assignmentName] || '0');
      const right = await this.evaluateArithmetic(expr.right);
      const value = applyArithmeticAssignment(expr.op, current, right);
      this.env[assignmentName] = String(value);
      return value;
    }

    if (expr.op === ARITH_OP.AND_AND) {
      return (await this.evaluateArithmetic(expr.left)) !== 0 && (await this.evaluateArithmetic(expr.right)) !== 0 ? 1 : 0;
    }
    if (expr.op === ARITH_OP.OR_OR) {
      return (await this.evaluateArithmetic(expr.left)) !== 0 || (await this.evaluateArithmetic(expr.right)) !== 0 ? 1 : 0;
    }
    if (expr.op === ARITH_OP.COMMA) {
      await this.evaluateArithmetic(expr.left);
      return this.evaluateArithmetic(expr.right);
    }

    const left = await this.evaluateArithmetic(expr.left);
    const right = await this.evaluateArithmetic(expr.right);
    switch (expr.op) {
      case ARITH_OP.ADD:
        return left + right;
      case ARITH_OP.SUB:
        return left - right;
      case ARITH_OP.MUL:
        return left * right;
      case ARITH_OP.DIV:
        return right === 0 ? 0 : Math.trunc(left / right);
      case ARITH_OP.REM:
        return right === 0 ? 0 : left % right;
      case ARITH_OP.POW:
        return Math.trunc(left ** right);
      case ARITH_OP.EQ:
        return left === right ? 1 : 0;
      case ARITH_OP.NE:
        return left !== right ? 1 : 0;
      case ARITH_OP.LT:
        return left < right ? 1 : 0;
      case ARITH_OP.GT:
        return left > right ? 1 : 0;
      case ARITH_OP.LE:
        return left <= right ? 1 : 0;
      case ARITH_OP.GE:
        return left >= right ? 1 : 0;
      case ARITH_OP.BIT_AND:
        return left & right;
      case ARITH_OP.BIT_OR:
        return left | right;
      case ARITH_OP.BIT_XOR:
        return left ^ right;
      case ARITH_OP.SHL:
        return left << right;
      case ARITH_OP.SHR:
        return left >> right;
      default:
        return 0;
    }
  }

  arithmeticVariableName(expr) {
    if (expr?.type !== 'word') return '';
    const raw = wordRaw(expr.word);
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) ? raw : '';
  }

  async evaluateTestExpr(expr) {
    if (!expr) return false;
    switch (expr.type) {
      case 'word':
        return (await this.expandWord(expr.word)) !== '';
      case 'paren':
        return this.evaluateTestExpr(expr.expr);
      case 'unary':
        if (expr.op === TEST_OP.NOT) return !(await this.evaluateTestExpr(expr.expr));
        return this.evaluateUnaryTest(expr.op, await this.testExprWord(expr.expr));
      case 'binary':
        if (expr.op === TEST_OP.AND) return (await this.evaluateTestExpr(expr.left)) && (await this.evaluateTestExpr(expr.right));
        if (expr.op === TEST_OP.OR) return (await this.evaluateTestExpr(expr.left)) || (await this.evaluateTestExpr(expr.right));
        return this.evaluateBinaryTest(expr.op, await this.testExprWord(expr.left), await this.testExprWord(expr.right));
      default:
        return false;
    }
  }

  async testExprWord(expr) {
    if (expr?.type === 'word') return this.expandWord(expr.word);
    return (await this.evaluateTestExpr(expr)) ? '1' : '';
  }

  async evaluateTestCommand(args) {
    return this.evaluateTestArgs(args || []);
  }

  async evaluateTestArgs(args) {
    if (args.length === 0) return false;
    if (args[0] === '!') return !(await this.evaluateTestArgs(args.slice(1)));

    const orIndex = args.indexOf('-o');
    if (orIndex > 0) return (await this.evaluateTestArgs(args.slice(0, orIndex))) || (await this.evaluateTestArgs(args.slice(orIndex + 1)));
    const andIndex = args.indexOf('-a');
    if (andIndex > 0) return (await this.evaluateTestArgs(args.slice(0, andIndex))) && (await this.evaluateTestArgs(args.slice(andIndex + 1)));

    if (args.length === 1) return args[0] !== '';
    if (args.length === 2 && isUnaryTestToken(args[0])) return this.evaluateUnaryTestToken(args[0], args[1]);
    if (args.length === 3) return this.evaluateBinaryTestToken(args[1], args[0], args[2]);
    return false;
  }

  async evaluateUnaryTest(op, value) {
    switch (op) {
      case TEST_OP.EXISTS:
        return (await this.stat(value).catch(() => ({ exists: false }))).exists === true;
      case TEST_OP.REG_FILE: {
        const st = await this.stat(value).catch(() => ({ exists: false, is_dir: false }));
        return st.exists === true && st.is_dir !== true;
      }
      case TEST_OP.DIRECTORY:
        return (await this.stat(value).catch(() => ({ exists: false, is_dir: false }))).is_dir === true;
      case TEST_OP.NON_EMPTY_FILE: {
        const st = await this.stat(value).catch(() => ({ exists: false, size: 0 }));
        return st.exists === true && Number(st.size || 0) > 0;
      }
      case TEST_OP.EMPTY_STRING:
        return value === '';
      case TEST_OP.NON_EMPTY_STRING:
        return value !== '';
      case TEST_OP.VAR_SET:
        return Object.prototype.hasOwnProperty.call(this.env, value);
      default:
        return this.evaluateUnaryTestToken(testUnaryToken(op), value);
    }
  }

  async evaluateBinaryTest(op, left, right) {
    switch (op) {
      case TEST_OP.MATCH:
      case TEST_OP.MATCH_SHORT:
        return casePatternMatches(right, left);
      case TEST_OP.NO_MATCH:
        return !casePatternMatches(right, left);
      case TEST_OP.BEFORE:
        return left < right;
      case TEST_OP.AFTER:
        return left > right;
      case TEST_OP.REGEX_MATCH:
        try {
          return new RegExp(right).test(left);
        } catch {
          return false;
        }
      case TEST_OP.NUM_EQ:
        return toShellNumber(left) === toShellNumber(right);
      case TEST_OP.NUM_NE:
        return toShellNumber(left) !== toShellNumber(right);
      case TEST_OP.NUM_LE:
        return toShellNumber(left) <= toShellNumber(right);
      case TEST_OP.NUM_GE:
        return toShellNumber(left) >= toShellNumber(right);
      case TEST_OP.NUM_LT:
        return toShellNumber(left) < toShellNumber(right);
      case TEST_OP.NUM_GT:
        return toShellNumber(left) > toShellNumber(right);
      default:
        return this.evaluateBinaryTestToken(testBinaryToken(op), left, right);
    }
  }

  async evaluateUnaryTestToken(op, value) {
    switch (op) {
      case '-e':
        return (await this.stat(value).catch(() => ({ exists: false }))).exists === true;
      case '-f': {
        const st = await this.stat(value).catch(() => ({ exists: false, is_dir: false }));
        return st.exists === true && st.is_dir !== true;
      }
      case '-d':
        return (await this.stat(value).catch(() => ({ exists: false, is_dir: false }))).is_dir === true;
      case '-s': {
        const st = await this.stat(value).catch(() => ({ exists: false, size: 0 }));
        return st.exists === true && Number(st.size || 0) > 0;
      }
      case '-z':
        return value === '';
      case '-n':
        return value !== '';
      case '-v':
        return Object.prototype.hasOwnProperty.call(this.env, value);
      case '-r':
      case '-w':
      case '-x':
      case '-L':
        return (await this.stat(value).catch(() => ({ exists: false }))).exists === true;
      default:
        return false;
    }
  }

  async evaluateBinaryTestToken(op, left, right) {
    switch (op) {
      case '=':
      case '==':
        return left === right;
      case '!=':
        return left !== right;
      case '<':
        return left < right;
      case '>':
        return left > right;
      case '-eq':
        return toShellNumber(left) === toShellNumber(right);
      case '-ne':
        return toShellNumber(left) !== toShellNumber(right);
      case '-le':
        return toShellNumber(left) <= toShellNumber(right);
      case '-ge':
        return toShellNumber(left) >= toShellNumber(right);
      case '-lt':
        return toShellNumber(left) < toShellNumber(right);
      case '-gt':
        return toShellNumber(left) > toShellNumber(right);
      case '=~':
        try {
          return new RegExp(right).test(left);
        } catch {
          return false;
        }
      default:
        return false;
    }
  }

  shellError(message, code = 1) {
    const error = new Error(message);
    error.exitCode = code;
    return error;
  }

  async runSimpleCommand(command, stdin) {
    return this.withRedirects(command.redirects || [], stdin, async (input) => {
      if (command.assignments.length > 0 && command.args.length === 0) {
        for (const assignment of command.assignments) {
          const value = await this.expandWord(assignment.value);
          this.env[assignment.name] = assignment.append ? (this.env[assignment.name] || '') + value : value;
        }
        return result();
      }

      if (command.args.length === 0) return result();
      const previous = {};
      for (const assignment of command.assignments || []) {
        previous[assignment.name] = this.env[assignment.name];
        const value = await this.expandWord(assignment.value);
        this.env[assignment.name] = assignment.append ? (this.env[assignment.name] || '') + value : value;
      }
      try {
        if (this.functions[command.args[0]]) {
          const output = await this.runExecutionNode(this.functions[command.args[0]], input);
          if (output.signal === 'return') return { ...output, signal: undefined, signalDepth: undefined };
          return output;
        }
        return await dispatchCommand(this, command.args[0], command.args.slice(1), input);
      } finally {
        for (const assignment of command.assignments || []) {
          if (previous[assignment.name] === undefined) delete this.env[assignment.name];
          else this.env[assignment.name] = previous[assignment.name];
        }
      }
    });
  }

  async withRedirects(redirects, stdin, execute) {
    let input = stdin || '';
    let stdoutRedirect = null;
    let stderrRedirect = null;

    for (const redirect of redirects || []) {
      switch (redirect.kind) {
        case '<':
          input = isDevNull(redirect.target) ? '' : await this.readFile(redirect.target);
          break;
        case '<<':
          input = redirect.expandHeredoc ? await this.expandWord(redirect.heredocWord) : (redirect.heredoc || '');
          break;
        case '<<<':
          input = `${redirect.target || ''}\n`;
          break;
        case '>':
        case '>>':
          stdoutRedirect = redirect;
          break;
        case '&>':
        case '&>>':
          stdoutRedirect = redirect;
          stderrRedirect = redirect;
          break;
        case '2>':
        case '2>>':
          stderrRedirect = redirect;
          break;
        default:
          return result('', `unsupported redirect: ${redirect.kind}\n`, 2);
      }
    }

    let output = await execute(input);
    const stdoutToStderr = stdoutRedirect && stdoutRedirect.target === '&2';
    const stderrToStdout = stderrRedirect && stderrRedirect.target === '&1';

    if (stdoutToStderr) {
      output = { ...output, stderr: (output.stderr || '') + (output.stdout || ''), stdout: '' };
    } else if (stdoutRedirect) {
      if (!isDevNull(stdoutRedirect.target)) {
        const content = (output.stdout || '') + (stderrToStdout ? (output.stderr || '') : '');
        await this.writeFile(stdoutRedirect.target, content, stdoutRedirect.kind === '>>' || stdoutRedirect.kind === '&>>');
      }
      output = { ...output, stdout: '', stderr: stderrToStdout ? '' : output.stderr };
    }

    if (stderrToStdout && !stdoutRedirect) {
      output = { ...output, stdout: (output.stdout || '') + (output.stderr || ''), stderr: '' };
    } else if (stderrRedirect && !stdoutToStderr) {
      if (!isDevNull(stderrRedirect.target) && stderrRedirect.target !== '&1') {
        await this.writeFile(stderrRedirect.target, output.stderr || '', stderrRedirect.kind === '2>>' || stderrRedirect.kind === '&>>');
      }
      output = { ...output, stderr: '' };
    }

    if ((stdoutRedirect || stderrRedirect) && output.exitCode === 0 && output.stdout === '' && output.stderr === '') {
      return this.capResult(output);
    }
    return this.capResult(output);
  }

  async expandGlob(pattern) {
    const normalized = String(pattern || '').replaceAll('\\', '/');
    const segments = normalized.split('/');
    const absolute = normalized.startsWith('/');
    const seed = absolute ? '/' : '.';
    const matches = await this.globSegments(seed, segments.filter((segment, index) => !(index === 0 && segment === '')));
    return matches.map((match) => absolute ? match : stripDotSlash(match)).sort();
  }

  async globSegments(base, segments) {
    if (segments.length === 0) return [base];
    const [segment, ...rest] = segments;
    if (!hasGlob(segment)) {
      return this.globSegments(joinSlash(base, segment), rest);
    }
    const st = await this.stat(base).catch(() => ({ exists: false, is_dir: false }));
    if (!st.exists || !st.is_dir) return [];
    const entries = await this.listDir(base);
    const re = globRegex(segment);
    const out = [];
    for (const entry of entries) {
      if (!re.test(entry.name)) continue;
      out.push(...await this.globSegments(joinSlash(base, entry.name), rest));
    }
    return out;
  }

  async readFile(path) {
    this.checkTimeout();
    const resp = await this.harness.requestFS(this.requestId, 'read_file', { workdir: this.workdir, path });
    this.checkTimeout();
    return resp.content || '';
  }

  async writeFile(path, content, append = false) {
    this.checkTimeout();
    await this.harness.requestFS(this.requestId, 'write_file', { workdir: this.workdir, path, content, append });
    this.checkTimeout();
  }

  async listDir(path) {
    this.checkTimeout();
    const resp = await this.harness.requestFS(this.requestId, 'list_dir', { workdir: this.workdir, path });
    this.checkTimeout();
    return resp.entries || [];
  }

  async stat(path) {
    this.checkTimeout();
    const resp = await this.harness.requestFS(this.requestId, 'stat', { workdir: this.workdir, path });
    this.checkTimeout();
    return resp;
  }

  async mkdir(path, recursive) {
    this.checkTimeout();
    await this.harness.requestFS(this.requestId, 'mkdir', { workdir: this.workdir, path, recursive });
    this.checkTimeout();
  }

  async deletePath(path, recursive) {
    this.checkTimeout();
    await this.harness.requestFS(this.requestId, 'delete_path', { workdir: this.workdir, path, recursive });
    this.checkTimeout();
  }

  async rename(path, targetPath) {
    this.checkTimeout();
    await this.harness.requestFS(this.requestId, 'rename', { workdir: this.workdir, path, target_path: targetPath });
    this.checkTimeout();
  }

  async touch(path) {
    this.checkTimeout();
    await this.harness.requestFS(this.requestId, 'touch', { workdir: this.workdir, path });
    this.checkTimeout();
  }

  capResult(output) {
    const stdout = output.stdout || '';
    const stderr = output.stderr || '';
    let truncated = output.truncated === true;
    let cappedStdout = stdout;
    let cappedStderr = stderr;
    if (byteLength(cappedStdout) > this.maxOutputBytes) {
      cappedStdout = capStringBytes(cappedStdout, this.maxOutputBytes);
      truncated = true;
    }
    if (byteLength(cappedStderr) > this.maxOutputBytes) {
      cappedStderr = capStringBytes(cappedStderr, this.maxOutputBytes);
      truncated = true;
    }
    return { ...output, stdout: cappedStdout, stderr: cappedStderr, truncated };
  }
}

function hasGlob(value) {
  return /[*?\[]/.test(String(value || ''));
}

function globRegex(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if (ch === '[') {
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

function joinSlash(base, child) {
  if (!base || base === '.') return child || '.';
  if (base === '/') return '/' + child;
  return `${String(base).replace(/\/+$/, '')}/${child}`;
}

function stripDotSlash(path) {
  return String(path || '').replace(/^\.\//, '');
}

function toShellNumber(value) {
  const text = String(value ?? '').trim();
  if (text === '') return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function isArithmeticAssignment(op) {
  return [
    ARITH_OP.ASSIGN,
    ARITH_OP.ADD_ASSIGN,
    ARITH_OP.SUB_ASSIGN,
    ARITH_OP.MUL_ASSIGN,
    ARITH_OP.DIV_ASSIGN,
    ARITH_OP.REM_ASSIGN,
    ARITH_OP.AND_ASSIGN,
    ARITH_OP.OR_ASSIGN,
    ARITH_OP.XOR_ASSIGN,
    ARITH_OP.SHL_ASSIGN,
    ARITH_OP.SHR_ASSIGN,
  ].includes(op);
}

function applyArithmeticAssignment(op, current, right) {
  switch (op) {
    case ARITH_OP.ASSIGN:
      return right;
    case ARITH_OP.ADD_ASSIGN:
      return current + right;
    case ARITH_OP.SUB_ASSIGN:
      return current - right;
    case ARITH_OP.MUL_ASSIGN:
      return current * right;
    case ARITH_OP.DIV_ASSIGN:
      return right === 0 ? 0 : Math.trunc(current / right);
    case ARITH_OP.REM_ASSIGN:
      return right === 0 ? 0 : current % right;
    case ARITH_OP.AND_ASSIGN:
      return current & right;
    case ARITH_OP.OR_ASSIGN:
      return current | right;
    case ARITH_OP.XOR_ASSIGN:
      return current ^ right;
    case ARITH_OP.SHL_ASSIGN:
      return current << right;
    case ARITH_OP.SHR_ASSIGN:
      return current >> right;
    default:
      return right;
  }
}

function isUnaryTestToken(value) {
  return ['-e', '-f', '-d', '-s', '-z', '-n', '-v', '-r', '-w', '-x', '-L'].includes(value);
}

function testUnaryToken(op) {
  switch (op) {
    case TEST_OP.EXISTS:
      return '-e';
    case TEST_OP.REG_FILE:
      return '-f';
    case TEST_OP.DIRECTORY:
      return '-d';
    case TEST_OP.NON_EMPTY_FILE:
      return '-s';
    case TEST_OP.EMPTY_STRING:
      return '-z';
    case TEST_OP.NON_EMPTY_STRING:
      return '-n';
    case TEST_OP.VAR_SET:
      return '-v';
    default:
      return '';
  }
}

function testBinaryToken(op) {
  switch (op) {
    case TEST_OP.MATCH_SHORT:
      return '=';
    case TEST_OP.MATCH:
      return '==';
    case TEST_OP.NO_MATCH:
      return '!=';
    case TEST_OP.BEFORE:
      return '<';
    case TEST_OP.AFTER:
      return '>';
    case TEST_OP.REGEX_MATCH:
      return '=~';
    case TEST_OP.NUM_EQ:
      return '-eq';
    case TEST_OP.NUM_NE:
      return '-ne';
    case TEST_OP.NUM_LE:
      return '-le';
    case TEST_OP.NUM_GE:
      return '-ge';
    case TEST_OP.NUM_LT:
      return '-lt';
    case TEST_OP.NUM_GT:
      return '-gt';
    default:
      return '';
  }
}

function casePatternMatches(pattern, value) {
  return caseGlobRegex(String(pattern || '')).test(String(value || ''));
}

function caseGlobRegex(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else if (ch === '[') {
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
  return new RegExp(out + '$');
}
