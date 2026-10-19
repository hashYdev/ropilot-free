const SUPPORTED_COMMANDS = new Set([
  ':', '.', 'true', 'false', 'break', 'continue', 'exit', 'return',
  'pwd', 'cd', 'eval', 'export', 'unset', 'set', 'shift', 'read',
  'command', 'which', 'env', 'printenv',
  'echo', 'printf', 'cat', 'type', 'sleep', 'mkdir', 'rm', 'touch',
  'cp', 'mv', 'ls', 'sed', 'awk', 'gawk', 'diff', 'grep', 'rg', 'nl', 'wc', 'head', 'tail',
  'sort', 'uniq', 'cut', 'tr', 'basename', 'dirname', 'tee', 'find', 'xargs',
  'test', '[', 'cmd', 'cmd.exe',
]);

function isSupportedCommand(name) {
  const normalized = String(name || '').trim();
  return SUPPORTED_COMMANDS.has(normalized) || SUPPORTED_COMMANDS.has(normalized.toLowerCase());
}

export { SUPPORTED_COMMANDS, isSupportedCommand };
