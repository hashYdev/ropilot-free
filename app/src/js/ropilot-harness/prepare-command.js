export function prepareCommand(command) {
  command = String(command || '');
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < command.length;) {
    const ch = command[i];
    if (inSingle) {
      out += ch;
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inDouble = false;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      i++;
      continue;
    }
    if (isWindowsDrivePathAt(command, i)) {
      let end = i + 3;
      while (end < command.length && !isShellPathTerminator(command[end])) end++;
      out += singleQuote(command.slice(i, end));
      i = end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function isWindowsDrivePathAt(s, i) {
  return i + 2 < s.length && /^[a-zA-Z]$/.test(s[i]) && s[i + 1] === ':' && (s[i + 2] === '\\' || s[i + 2] === '/');
}

function isShellPathTerminator(ch) {
  return [' ', '\t', '\n', '\r', '|', '&', ';', '<', '>', '(', ')'].includes(ch);
}

function singleQuote(s) {
  return `'${s.replaceAll("'", "'\\''")}'`;
}
