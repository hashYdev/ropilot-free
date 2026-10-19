import * as shModule from '../../../node_modules/mvdan-sh/index.js';
export { prepareCommand } from './prepare-command.js';

const sh = shModule.default?.syntax ? shModule.default : (shModule.syntax ? shModule : globalThis.sh);
if (!sh?.syntax) {
  throw new Error('Ropilot Harness shell parser failed to load');
}
const syntax = sh.syntax;
const parser = syntax.NewParser(syntax.Variant(syntax.LangBash));

const OPS = {
  AND: 10,
  OR: 11,
  PIPE: 12,
  PIPE_ALL: 13,
  RDR_OUT: 54,
  APP_OUT: 55,
  RDR_IN: 56,
  DPL_OUT: 59,
  HEREDOC: 61,
  HEREDOC_TABS: 62,
  HERE_STRING: 63,
  RDR_ALL: 64,
  APP_ALL: 65,
};

export async function parseScript(command) {
  let file;
  try {
    file = parser.Parse(String(command || '').replace(/\r\n/g, '\n'), 'ropilot-harness.sh');
  } catch (error) {
    const message = error?.message || String(error);
    const wrapped = new Error(message);
    wrapped.exitCode = 2;
    throw wrapped;
  }
  return convertStatements(file.Stmts || []);
}

function convertStatements(stmts) {
  return (stmts || []).map(convertStatement).filter(Boolean);
}

function convertStatement(stmt) {
  if (!stmt) return null;
  let node = convertCommandNode(stmt.Cmd);
  if (!node) return null;

  if (stmt.Negated === true) {
    node = { type: 'not', node };
  }

  const redirects = convertRedirects(stmt.Redirs || []);
  if (redirects.length > 0) {
    if (node.type === 'command') node.redirects.push(...redirects);
    else node = { type: 'redirected', node, redirects };
  }

  if (stmt.Background === true) {
    node = { type: 'background', node };
  }
  return node;
}

function convertCommandNode(cmd) {
  switch (nodeType(cmd)) {
    case 'CallExpr':
      return convertCall(cmd);
    case 'BinaryCmd':
      return convertBinary(cmd);
    case 'Block':
      return { type: 'block', statements: convertStatements(cmd.Stmts || []) };
    case 'Subshell':
      return { type: 'subshell', statements: convertStatements(cmd.Stmts || []) };
    case 'IfClause':
      return convertIf(cmd);
    case 'WhileClause':
      return convertWhile(cmd);
    case 'ForClause':
      return convertFor(cmd);
    case 'CaseClause':
      return convertCase(cmd);
    case 'ArithmCmd':
      return { type: 'arithmcmd', expr: convertArithmeticExpr(cmd.X) };
    case 'LetClause':
      return { type: 'let', exprs: (cmd.Exprs || []).map(convertArithmeticExpr) };
    case 'TestClause':
      return { type: 'testclause', expr: convertTestExpr(cmd.X) };
    case 'DeclClause':
      return convertDecl(cmd);
    case 'FuncDecl':
      return {
        type: 'funcdecl',
        name: cmd.Name?.Value || '',
        body: convertStatement(cmd.Body),
      };
    case '':
      return null;
    default:
      return { type: 'unsupported', shellType: nodeType(cmd) || 'unknown' };
  }
}

function convertCall(call) {
  const command = {
    type: 'command',
    assignments: (call.Assigns || []).map(convertAssign).filter(Boolean),
    args: (call.Args || []).map(convertWord),
    redirects: [],
  };
  normalizeCommandCompatibility(command);
  return command;
}

function convertAssign(assign) {
  if (!assign?.Name?.Value) return null;
  return {
    name: assign.Name.Value,
    append: assign.Append === true,
    naked: assign.Naked === true,
    value: assign.Value ? convertWord(assign.Value) : rawWord(''),
  };
}

function convertBinary(binary) {
  const left = convertStatement(binary.X);
  const right = convertStatement(binary.Y);
  if (!left || !right) return left || right;

  switch (Number(binary.Op)) {
    case OPS.PIPE:
      return mergePipeline(left, right, false);
    case OPS.PIPE_ALL:
      return mergePipeline(left, right, true);
    case OPS.AND:
      return mergeList(left, right, '&&');
    case OPS.OR:
      return mergeList(left, right, '||');
    default:
      return { type: 'unsupported', shellType: `BinaryCmd(${binary.Op})` };
  }
}

function mergePipeline(left, right, pipeAll) {
  const commands = [];
  const push = (node) => {
    if (node.type === 'pipeline' && node.pipeAll === pipeAll) commands.push(...node.commands);
    else commands.push(node);
  };
  push(left);
  push(right);
  return { type: 'pipeline', commands, pipeAll };
}

function mergeList(left, right, op) {
  const items = [];
  const push = (node, itemOp) => {
    if (node.type === 'list') {
      for (const item of node.items) items.push({ ...item, op: items.length === 0 ? itemOp : item.op });
    } else {
      items.push({ op: items.length === 0 ? '' : itemOp, node });
    }
  };
  push(left, '');
  push(right, op);
  return { type: 'list', items };
}

function convertIf(clause) {
  const hasCondition = (clause.Cond || []).length > 0;
  if (!hasCondition) {
    return {
      type: 'block',
      statements: convertStatements(clause.Then || []),
    };
  }
  const elseNode = clause.Else ? convertCommandNode(clause.Else) : null;
  return {
    type: 'if',
    condition: convertStatements(clause.Cond || []),
    thenStatements: convertStatements(clause.Then || []),
    elseStatements: elseNode ? [elseNode] : [],
  };
}

function convertWhile(clause) {
  return {
    type: 'while',
    until: clause.Until === true,
    condition: convertStatements(clause.Cond || []),
    body: convertStatements(clause.Do || []),
  };
}

function convertFor(clause) {
  const loop = clause.Loop || {};
  if (nodeType(loop) === 'WordIter') {
    return {
      type: 'for',
      name: loop.Name?.Value || '',
      items: (loop.Items || []).map(convertWord),
      body: convertStatements(clause.Do || []),
    };
  }
  if (nodeType(loop) === 'CStyleLoop') {
    return {
      type: 'cfor',
      init: convertArithmeticExpr(loop.Init),
      condition: convertArithmeticExpr(loop.Cond),
      post: convertArithmeticExpr(loop.Post),
      body: convertStatements(clause.Do || []),
    };
  }
  return { type: 'unsupported', shellType: `ForClause(${nodeType(loop) || 'unknown'})` };
}

function convertCase(clause) {
  return {
    type: 'case',
    word: convertWord(clause.Word),
    items: (clause.Items || []).map((item) => ({
      op: Number(item.Op || 0),
      patterns: (item.Patterns || []).map(convertWord),
      statements: convertStatements(item.Stmts || []),
    })),
  };
}

function convertDecl(clause) {
  return {
    type: 'decl',
    variant: clause.Variant?.Value || '',
    assignments: (clause.Args || []).map(convertAssign).filter(Boolean),
  };
}

function convertRedirects(redirs) {
  return (redirs || []).map(convertRedirect).filter(Boolean);
}

function convertRedirect(redirect) {
  const fd = redirect.N?.Value || '';
  const word = convertWord(redirect.Word);
  const targetText = wordRaw(word);

  switch (Number(redirect.Op)) {
    case OPS.RDR_IN:
      return { kind: '<', fd, target: word };
    case OPS.RDR_OUT:
      return { kind: fd === '2' ? '2>' : '>', fd, target: word };
    case OPS.APP_OUT:
      return { kind: fd === '2' ? '2>>' : '>>', fd, target: word };
    case OPS.DPL_OUT:
      return { kind: fd === '2' ? '2>' : '>', fd, target: rawWord(`&${targetText}`) };
    case OPS.HEREDOC:
    case OPS.HEREDOC_TABS:
      return {
        kind: '<<',
        fd,
        target: word,
        heredocWord: convertWord(redirect.Hdoc),
        heredoc: heredocText(redirect.Hdoc, Number(redirect.Op) === OPS.HEREDOC_TABS),
        expandHeredoc: !isQuotedWord(redirect.Word),
      };
    case OPS.HERE_STRING:
      return { kind: '<<<', fd, target: word };
    case OPS.RDR_ALL:
      return { kind: '&>', fd, target: word };
    case OPS.APP_ALL:
      return { kind: '&>>', fd, target: word };
    default:
      return { kind: `redirect(${redirect.Op})`, fd, target: word };
  }
}

function heredocText(word, stripTabs) {
  const raw = wordRaw(convertWord(word));
  if (!stripTabs) return raw;
  return raw.split('\n').map((line) => line.replace(/^\t+/, '')).join('\n');
}

export function convertWord(word) {
  return {
    kind: 'word',
    quoted: isQuotedWord(word),
    parts: convertWordParts(word?.Parts || []),
  };
}

function convertWordParts(parts) {
  const out = [];
  for (const part of parts || []) {
    switch (nodeType(part)) {
      case 'Lit':
        out.push({ type: 'bare', value: part.Value || '' });
        break;
      case 'SglQuoted':
        out.push({ type: 'single', value: part.Dollar ? ansiCUnescape(part.Value || '') : (part.Value || '') });
        break;
      case 'DblQuoted':
        out.push(...convertDoubleQuoted(part));
        break;
      case 'ParamExp':
        out.push(convertParamExp(part));
        break;
      case 'CmdSubst':
        out.push({ type: 'cmdsubst', statements: convertStatements(part.Stmts || []) });
        break;
      case 'ArithmExp':
        out.push({ type: 'arithm', expr: convertArithmeticExpr(part.X), value: expressionText(part.X) });
        break;
      case 'ProcSubst':
      case 'ExtGlob':
      case 'BraceExp':
        out.push({ type: 'unsupported', value: nodeType(part) });
        break;
      default:
        out.push({ type: 'bare', value: part?.Value || '' });
        break;
    }
  }
  return out;
}

function convertDoubleQuoted(part) {
  const converted = [];
  for (const nested of part.Parts || []) {
    switch (nodeType(nested)) {
      case 'Lit':
        converted.push({ type: 'double', value: nested.Value || '' });
        break;
      case 'ParamExp':
        converted.push({ ...convertParamExp(nested), quoted: true });
        break;
      case 'CmdSubst':
        converted.push({ type: 'cmdsubst', statements: convertStatements(nested.Stmts || []), quoted: true });
        break;
      case 'ArithmExp':
        converted.push({ type: 'arithm', expr: convertArithmeticExpr(nested.X), value: expressionText(nested.X) });
        break;
      case 'SglQuoted':
        converted.push({ type: 'double', value: nested.Value || '' });
        break;
      default:
        converted.push({ type: 'double', value: nested?.Value || '' });
        break;
    }
  }
  return converted;
}

function convertParamExp(part) {
  return {
    type: 'var',
    name: part.Param?.Value || '',
    length: part.Length === true,
    op: part.Exp?.Op || '',
    value: part.Exp?.Word ? convertWord(part.Exp.Word) : null,
  };
}

function convertArithmeticExpr(expr) {
  switch (nodeType(expr)) {
    case '':
      return null;
    case 'Word':
      return { type: 'word', word: convertWord(expr) };
    case 'BinaryArithm':
      return {
        type: 'binary',
        op: Number(expr.Op || 0),
        left: convertArithmeticExpr(expr.X),
        right: convertArithmeticExpr(expr.Y),
      };
    case 'UnaryArithm':
      return {
        type: 'unary',
        op: Number(expr.Op || 0),
        post: expr.Post === true,
        expr: convertArithmeticExpr(expr.X),
      };
    case 'ParenArithm':
      return { type: 'paren', expr: convertArithmeticExpr(expr.X) };
    default:
      return { type: 'text', value: expressionText(expr) };
  }
}

function convertTestExpr(expr) {
  switch (nodeType(expr)) {
    case '':
      return null;
    case 'Word':
      return { type: 'word', word: convertWord(expr) };
    case 'BinaryTest':
      return {
        type: 'binary',
        op: Number(expr.Op || 0),
        left: convertTestExpr(expr.X),
        right: convertTestExpr(expr.Y),
      };
    case 'UnaryTest':
      return {
        type: 'unary',
        op: Number(expr.Op || 0),
        expr: convertTestExpr(expr.X),
      };
    case 'ParenTest':
      return { type: 'paren', expr: convertTestExpr(expr.X) };
    default:
      return { type: 'word', word: rawWord(expressionText(expr)) };
  }
}

function expressionText(expr) {
  if (!expr) return '';
  if (expr.Value) return expr.Value;
  if (nodeType(expr) === 'Word') return wordRaw(convertWord(expr));
  if (expr.X || expr.Y) return `${expressionText(expr.X)}${arithmeticOp(expr.Op)}${expressionText(expr.Y)}`;
  return '';
}

function arithmeticOp(op) {
  switch (Number(op)) {
    case 9: return '&';
    case 12: return '|';
    case 38: return '*';
    case 55: return '>>';
    case 61: return '<<';
    case 68: return '+';
    case 70: return '-';
    case 76: return '%';
    case 80: return '^';
    case 85: return '/';
    default: return '';
  }
}

function isQuotedWord(word) {
  return (word?.Parts || []).some((part) => ['SglQuoted', 'DblQuoted'].includes(nodeType(part)));
}

function normalizeCommandCompatibility(command) {
  const name = wordRaw(command.args[0]).toLowerCase();
  if (name === 'type' && command.args.length > 1) {
    command.args[0] = rawWord('cat');
  } else if ((name === 'cmd' || name === 'cmd.exe') && command.args.length >= 4) {
    const first = wordRaw(command.args[1]).toLowerCase();
    const second = wordRaw(command.args[2]).toLowerCase();
    if (first === '/c' && second === 'type') {
      command.args = [rawWord('cat'), ...command.args.slice(3)];
    }
  }
}

function nodeType(node) {
  if (!node) return '';
  try {
    return syntax.NodeType(node);
  } catch {
    return '';
  }
}

export function rawWord(value) {
  return { kind: 'word', quoted: false, parts: [{ type: 'bare', value }] };
}

export function wordRaw(word) {
  return (word?.parts || []).map((part) => part.value || '').join('');
}

function ansiCUnescape(value) {
  return String(value || '').replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, token) => {
    switch (token) {
      case 'a': return '\x07';
      case 'b': return '\b';
      case 'e':
      case 'E': return '\x1b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'v': return '\v';
      case '\\': return '\\';
      case "'": return "'";
      case '"': return '"';
      default:
        if (token.startsWith('u')) return String.fromCodePoint(Number.parseInt(token.slice(1), 16));
        if (token.startsWith('x')) return String.fromCharCode(Number.parseInt(token.slice(1), 16));
        if (/^[0-7]/.test(token)) return String.fromCharCode(Number.parseInt(token, 8));
        return token;
    }
  });
}
