const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function getCodexHomes() {
  const homes = [];
  const override = typeof process.env.CODEX_HOME === 'string' ? process.env.CODEX_HOME.trim() : '';
  if (override) {
    homes.push(override);
  }

  homes.push(path.join(os.homedir(), '.codex'));

  const windowsProfile = typeof process.env.USERPROFILE === 'string' ? process.env.USERPROFILE.trim() : '';
  if (windowsProfile) {
    homes.push(path.join(windowsProfile, '.codex'));
  }

  if (process.platform !== 'win32') {
    const username = (typeof process.env.USER === 'string' && process.env.USER.trim())
      || path.basename(os.homedir());
    homes.push(path.join('/mnt/c/Users', username, '.codex'));
  }

  return Array.from(new Set(homes.filter(Boolean)));
}

function getSessionsRoots() {
  return getCodexHomes().map((codexHome) => path.join(codexHome, 'sessions'));
}

function listRolloutFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function parseJsonLine(line, label) {
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new Error(`Invalid JSONL ${label}: ${err.message}`);
  }
}

function readRolloutLines(rolloutPath) {
  const raw = fs.readFileSync(rolloutPath, 'utf8');
  const hasTrailingNewline = raw.endsWith('\n');
  const lines = raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return { lines, hasTrailingNewline };
}

function findRolloutPathByThreadId(threadId) {
  const trimmedThreadId = typeof threadId === 'string' ? threadId.trim() : '';
  if (!trimmedThreadId) {
    throw new Error('Missing Codex thread id');
  }

  const candidates = getSessionsRoots().flatMap((sessionsRoot) => listRolloutFiles(sessionsRoot));
  const likely = candidates.filter((filePath) => path.basename(filePath).includes(trimmedThreadId));
  const orderedCandidates = likely.length > 0 ? likely.concat(candidates.filter((filePath) => !likely.includes(filePath))) : candidates;

  for (const filePath of orderedCandidates) {
    try {
      const { lines } = readRolloutLines(filePath);
      if (lines.length === 0) continue;
      const first = parseJsonLine(lines[0], 'line 1');
      if (first?.type === 'session_meta' && first?.payload?.id === trimmedThreadId) {
        return filePath;
      }
    } catch (_) {
      continue;
    }
  }

  throw new Error(`Could not find Codex rollout for thread ${trimmedThreadId}`);
}

function findCutoffLineIndex(lines, turnsToKeep) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('Rollout is empty');
  }
  if (!Number.isInteger(turnsToKeep) || turnsToKeep < 1) {
    throw new Error('turnsToKeep must be a positive integer');
  }

  let completedTurns = 0;
  const turnContextIndices = [];

  for (let i = 1; i < lines.length; i++) {
    const entry = parseJsonLine(lines[i], `line ${i + 1}`);
    const entryType = entry?.type;
    if (entryType === 'task_complete') {
      completedTurns++;
      if (completedTurns === turnsToKeep) {
        return i;
      }
    }
    if (entryType === 'turn_context') {
      turnContextIndices.push(i);
    }
  }

  if (completedTurns > 0) {
    throw new Error(`Rollout only contains ${completedTurns} completed turn(s); cannot keep ${turnsToKeep}`);
  }

  if (turnContextIndices.length === 0) {
    throw new Error('Could not determine rewind boundary in rollout');
  }

  if (turnsToKeep > turnContextIndices.length) {
    throw new Error(`Rollout only contains ${turnContextIndices.length} turn(s); cannot keep ${turnsToKeep}`);
  }

  if (turnsToKeep === turnContextIndices.length) {
    return lines.length - 1;
  }

  return turnContextIndices[turnsToKeep] - 1;
}

function rewriteSessionMetaLine(sessionMetaLine, newThreadId) {
  const sessionMeta = parseJsonLine(sessionMetaLine, 'line 1');
  if (sessionMeta?.type !== 'session_meta' || !sessionMeta?.payload || typeof sessionMeta.payload !== 'object') {
    throw new Error('Rollout does not start with session metadata');
  }
  sessionMeta.payload.id = newThreadId;
  return JSON.stringify(sessionMeta);
}

function formatDateParts(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return {
    year,
    month,
    day,
    fileTimestamp: `${year}-${month}-${day}T${hour}-${minute}-${second}`
  };
}

function cloneThreadForRewind({ threadId, turnsToKeep }) {
  const rolloutPath = findRolloutPathByThreadId(threadId);
  const { lines, hasTrailingNewline } = readRolloutLines(rolloutPath);
  const cutoffLineIndex = findCutoffLineIndex(lines, turnsToKeep);
  const newThreadId = crypto.randomUUID();
  const dateParts = formatDateParts(new Date());
  const targetRoot = getSessionsRoots().find((sessionsRoot) => rolloutPath.startsWith(sessionsRoot)) || getSessionsRoots()[0];
  const targetDir = path.join(targetRoot, dateParts.year, dateParts.month, dateParts.day);
  const targetPath = path.join(targetDir, `rollout-${dateParts.fileTimestamp}-${newThreadId}.jsonl`);

  const clonedLines = lines.slice(0, cutoffLineIndex + 1);
  clonedLines[0] = rewriteSessionMetaLine(clonedLines[0], newThreadId);

  fs.mkdirSync(targetDir, { recursive: true });
  const fileContent = clonedLines.join('\n') + (hasTrailingNewline ? '\n' : '');
  fs.writeFileSync(targetPath, fileContent, 'utf8');

  return {
    success: true,
    threadId: newThreadId,
    rolloutPath: targetPath,
    sourceRolloutPath: rolloutPath,
    turnsKept: turnsToKeep
  };
}

function deleteClonedRollout(rolloutPath) {
  const trimmedPath = typeof rolloutPath === 'string' ? rolloutPath.trim() : '';
  if (!trimmedPath) {
    throw new Error('Missing rollout path');
  }
  if (!fs.existsSync(trimmedPath)) {
    return { success: true, notFound: true };
  }
  fs.unlinkSync(trimmedPath);
  return { success: true };
}

module.exports = {
  cloneThreadForRewind,
  deleteClonedRollout,
  __test__: {
    findCutoffLineIndex,
    rewriteSessionMetaLine,
    formatDateParts,
  }
};
