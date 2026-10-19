#!/usr/bin/env python3
"""Prove the installer actually contains the app that was just built.

Verifying app/ proves the source is patched. It proves nothing about the
compressed artifact that comes out the other end — an installer is a black box
until you open it. So: unpack it with 7z, pull app.asar back out, and compare it
byte for byte against the one build.sh packed. If a stale installer ever gets
published, this is what catches it.

    python3 verify-installer.py [path/to/Setup.exe]
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))
EXE = os.path.join(ROOT, 'Ropilot-Studio-Free-Setup.exe')
BUILT_ASAR = os.path.join(ROOT, 'build/stage/resources/app.asar')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for block in iter(lambda: fh.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def asar_entries(path):
    """Count the files in an asar by parsing its header, so the number is read
    from the archive rather than assumed from the tree that went in."""
    with open(path, 'rb') as fh:
        head = fh.read(1 << 22)
    start = head.index(b'{')
    for i in range(start, len(head)):
        c = head[i:i + 1]
        if c == b'{':
            depth = head[start:i + 1].count(b'{')
        elif c == b'}':
            if head[start:i + 1].count(b'{') == head[start:i + 1].count(b'}'):
                doc = json.loads(head[start:i + 1])
                break
    else:
        raise SystemExit('  ! could not parse the asar header')

    names = []

    def walk(node, prefix=''):
        for name, meta in node.get('files', {}).items():
            full = prefix + '/' + name
            names.append(full)
            if 'files' in meta:
                walk(meta, full)

    walk(doc)
    return names


def main():
    exe = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else EXE
    if not os.path.exists(exe):
        raise SystemExit('  ! %s not built yet — run: bash build.sh --exe' % exe)
    if not os.path.exists(BUILT_ASAR):
        raise SystemExit('  ! %s not staged — run: bash build.sh first' % BUILT_ASAR)

    size = os.path.getsize(exe)
    print('installer   %s (%s bytes)' % (os.path.basename(exe), f'{size:,}'))
    print('sha256      %s' % sha256(exe))
    print()

    ok = True
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, 'x')
        proc = subprocess.run(['7z', 'x', '-y', '-o' + out, exe],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if proc.returncode != 0:
            print(proc.stdout.decode('utf-8', 'replace'))
            raise SystemExit('  ! 7z could not unpack the installer')

        asar = None
        for root, _dirs, files in os.walk(out):
            if 'app.asar' in files:
                asar = os.path.join(root, 'app.asar')
        if not asar:
            raise SystemExit('  ! no app.asar inside the installer')

        inside = sha256(asar)
        expected = sha256(BUILT_ASAR)
        same = inside == expected

        print('app.asar    %s' % os.path.relpath(asar, out))
        print('  size      %s bytes' % f'{os.path.getsize(asar):,}')
        print('  inside    %s' % inside)
        print('  built     %s' % expected)
        print('  match     %s' % ('yes — the installer carries the verified build'
                                  if same else 'NO — the installer is stale'))
        print()
        print('  entries   %d' % len(asar_entries(asar)))
        ok = same

        with open(asar, 'rb') as fh:
            blob = fh.read()

        # Markers the patches left behind, read back out of the compressed
        # archive rather than trusted from the build log.
        markers = {
            'gates neutralised': b'free build: always bring-your-own',
            'free-plan gate removed': b'free build: the plan no longer gates',
            'wall rewritten': b"Your plan's limit, not a paywall",
            'referral stubbed': b'free build: stub \xe2\x80\x94 the Referral Program widget',
        }
        # And the purchase paths that must not be in there.
        leaks = {
            'checkout target': b'siteUrl}/pricing',
            'auto top-up': b'/api/auto-refill',
            'balance fetch': b'/api/ai/credits',
            'price string': b'Get 30 credits',
            'buy button': b'btn-buy-credits',
        }

        print()
        for label, needle in markers.items():
            found = needle in blob
            ok = ok and found
            print('  %-5s %s' % ('PASS' if found else 'FAIL', label))
        for label, needle in leaks.items():
            found = needle in blob
            ok = ok and not found
            print('  %-5s no %s' % ('FAIL' if found else 'PASS', label))

    print()
    print('INSTALLER VERIFIED' if ok else 'INSTALLER FAILED')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
