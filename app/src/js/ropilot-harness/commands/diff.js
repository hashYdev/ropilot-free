import { result, splitLines } from '../utils.js';

// --- diff ------------------------------------------------------------------
// Unified diff (3 context lines) via LCS; large inputs fall back to a plain
// "files differ" notice instead of an O(N*M) table.

function diffLcsKeep(aLines, bLines) {
  const n = aLines.length;
  const m = bLines.length;
  const table = new Array((n + 1) * (m + 1)).fill(0);
  const at = (i, j) => table[i * (m + 1) + j];
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] = aLines[i] === bLines[j]
        ? at(i + 1, j + 1) + 1
        : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  // Walk the table into an edit script
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) { ops.push({ type: ' ', a: i++, b: j++ }); continue; }
    if (at(i + 1, j) >= at(i, j + 1)) ops.push({ type: '-', a: i++ });
    else ops.push({ type: '+', b: j++ });
  }
  while (i < n) ops.push({ type: '-', a: i++ });
  while (j < m) ops.push({ type: '+', b: j++ });
  return ops;
}

function buildUnifiedDiff(aLines, bLines, aName, bName, context = 3) {
  const ops = diffLcsKeep(aLines, bLines);
  if (!ops.some((op) => op.type !== ' ')) return '';

  const hunks = [];
  let current = null;
  let trailing = 0;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.type === ' ') {
      if (current) {
        current.ops.push(op);
        trailing++;
        if (trailing > context * 2) {
          // close the hunk, keeping only `context` trailing lines
          current.ops.splice(current.ops.length - (trailing - context), trailing - context);
          hunks.push(current);
          current = null;
          trailing = 0;
        }
      }
      continue;
    }
    if (!current) {
      const lead = [];
      for (let back = k - 1; back >= 0 && lead.length < context && ops[back].type === ' '; back--) {
        lead.unshift(ops[back]);
      }
      current = { ops: [...lead] };
    }
    trailing = 0;
    current.ops.push(op);
  }
  if (current) {
    if (trailing > context) current.ops.splice(current.ops.length - (trailing - context), trailing - context);
    hunks.push(current);
  }

  let out = `--- ${aName}\n+++ ${bName}\n`;
  for (const hunk of hunks) {
    const first = hunk.ops[0];
    const aStart = (first.a ?? (first.b !== undefined ? nearestA(hunk.ops) : 0)) + 1;
    const bStart = (first.b ?? (first.a !== undefined ? nearestB(hunk.ops) : 0)) + 1;
    const aCount = hunk.ops.filter((op) => op.type !== '+').length;
    const bCount = hunk.ops.filter((op) => op.type !== '-').length;
    out += `@@ -${aCount === 0 ? aStart - 1 : aStart},${aCount} +${bCount === 0 ? bStart - 1 : bStart},${bCount} @@\n`;
    for (const op of hunk.ops) {
      if (op.type === ' ') out += ` ${aLines[op.a]}\n`;
      else if (op.type === '-') out += `-${aLines[op.a]}\n`;
      else out += `+${bLines[op.b]}\n`;
    }
  }
  return out;

  function nearestA(hunkOps) {
    for (const op of hunkOps) if (op.a !== undefined) return op.a;
    return 0;
  }
  function nearestB(hunkOps) {
    for (const op of hunkOps) if (op.b !== undefined) return op.b;
    return 0;
  }
}

async function runDiff(runner, args, stdin) {
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-U' && i + 1 < args.length) { i++; continue; }
    if (arg === '--') { operands.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('-') && arg.length > 1) continue; // -u/-q/-r etc: unified output regardless
    operands.push(arg);
  }
  if (operands.length !== 2) return result('', 'diff: expected two file operands\n', 2);

  const readOperand = async (path) => (path === '-' ? (stdin || '') : runner.readFile(path));
  const aContent = await readOperand(operands[0]);
  const bContent = await readOperand(operands[1]);
  if (aContent === bContent) return result();

  const aLines = splitLines(aContent);
  const bLines = splitLines(bContent);
  if ((aLines.length + 1) * (bLines.length + 1) > 4_000_000) {
    return result('', `diff: files ${operands[0]} and ${operands[1]} differ (too large for a line diff)\n`, 1);
  }
  const out = buildUnifiedDiff(aLines, bLines, operands[0], operands[1]);
  return result(out, '', out ? 1 : 0);
}

export { buildUnifiedDiff, diffLcsKeep, runDiff };
