#!/usr/bin/env python3
"""Eleventh pass: the API key check on the send path.

Ropilot 1.3.2 refuses to send anything without a Ropilot API key. Not for the
hosted route — for every message, including one aimed at a local provider:

    // Check for API key (either global or folder-specific)
    const effectiveKey = this.app.getEffectiveApiKey();
    if (!effectiveKey) {
      this.app.showApiKeyReminder();
      return;
    }

    // Check if API key is validated
    if (!isApiKeyValidated()) {
      this.app.showApiKeyReminder('Your API key is invalid. Please double check.');
      return;
    }

The symptom is the banner across the chat: "Please add your Studio API key in
Settings to start chatting with Ropilot."

The key is a Ropilot account credential. It authenticates the hosted route,
which the earlier passes removed, and it is validated against their server.
A local provider is none of that: Claude Code, Codex and OpenCode are driven
with the user's own login, and the key is not passed to any of them.

So the check only applies to the hosted provider. 'ropilot' is the only
provider that uses a Ropilot key, and in this build that route is unreachable
anyway — but the check stays for it, so if the hosted route is ever turned
back on it still refuses to run without a key.

Two call sites: the normal send path in message-sender.js, and the automatic
prompt path in app.js.
"""
import io
import os
import re
import sys

ROOT = os.environ.get('ROPILOT_APP', os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app')))
applied = []


def patch(rel, pattern, replacement, marker, why):
    path = os.path.join(ROOT, rel)
    src = io.open(path, encoding='utf-8').read()
    if marker in src:
        print('  = %-46s already patched' % rel)
        return
    pat = re.compile(pattern)
    hits = pat.findall(src)
    if len(hits) != 1:
        print('  ! %-46s matched %d times — ABORTING' % (rel, len(hits)))
        sys.exit(1)
    out = pat.sub(replacement, src, count=1)
    io.open(path, 'w', encoding='utf-8', newline='').write(out)
    applied.append(rel)
    print('  + %-46s %s' % (rel, why))


# ── the normal send path ─────────────────────────────────────────────────────
patch(
    'src/js/message-sender.js',
    r'[ \t]*// Check for API key \(either global or folder-specific\)\n'
    r'[ \t]*const effectiveKey = this\.app\.getEffectiveApiKey\(\);\n'
    r'[ \t]*if \(!effectiveKey\) \{\n'
    r'[ \t]*this\.app\.showApiKeyReminder\(\);\n'
    r'[ \t]*return;\n'
    r'[ \t]*\}\n'
    r'\n'
    r'[ \t]*// Check if API key is validated\n'
    r'[ \t]*if \(!isApiKeyValidated\(\)\) \{\n'
    r'[ \t]*this\.app\.showApiKeyReminder\(\'Your API key is invalid\. Please double check\.\'\);\n'
    r'[ \t]*return;\n'
    r'[ \t]*\}\n',
    '    // free build: the Ropilot API key check no longer gates a local\n'
    '    // provider. The key is a Ropilot account credential — it authenticates\n'
    '    // the hosted route, which is gone, and it is validated against their\n'
    '    // server. Claude Code, Codex and OpenCode are driven with the user\'s\n'
    '    // own login and never see it. Only the hosted provider still needs one.\n'
    '    if (this.app.normalizeModelProvider(this.app.modelProvider) === \'ropilot\') {\n'
    '      const effectiveKey = this.app.getEffectiveApiKey();\n'
    '      if (!effectiveKey) {\n'
    '        this.app.showApiKeyReminder();\n'
    '        return;\n'
    '      }\n'
    '      if (!isApiKeyValidated()) {\n'
    '        this.app.showApiKeyReminder(\'Your API key is invalid. Please double check.\');\n'
    '        return;\n'
    '      }\n'
    '    }\n',
    'free build: the Ropilot API key check no longer gates a local',
    'the API key gate removed from the send path')

# ── the automatic prompt path ────────────────────────────────────────────────
patch(
    'src/app.js',
    r'[ \t]*if \(!this\.getEffectiveApiKey\(\)\) \{\n'
    r'[ \t]*this\.showApiKeyReminder\(\);\n'
    r'[ \t]*return false;\n'
    r'[ \t]*\}\n',
    '    // free build: same as the send path — a local provider does not need\n'
    '    // a Ropilot key, because the hosted route it authenticates is gone.\n'
    '    if (this.normalizeModelProvider(this.modelProvider) === \'ropilot\' && !this.getEffectiveApiKey()) {\n'
    '      this.showApiKeyReminder();\n'
    '      return false;\n'
    '    }\n',
    'free build: same as the send path — a local provider does not need',
    'the API key gate removed from the auto-prompt path')

print()
print('%d edit(s) applied' % len(applied))
