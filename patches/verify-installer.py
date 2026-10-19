#!/usr/bin/env python3
"""Prove the installer actually contains the patched app.

Verifying the working tree proves the patches were applied. Verifying the tree
that goes into makensis proves nothing about the compressed artifact that comes
out — an installer is a black box until you open it. So: unpack the installer
with 7z, pull app.asar back out, and compare it byte for byte with the one that
was packed. If a stale installer ever gets published, this is what catches it.

    python3 verify-installer.py
"""
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile

RP = '/tmp/opencode/rp'
EXE = os.path.join(RP, 'Ropilot-Studio-Free-Setup.exe')
BUILT_ASAR = os.path.join(RP, 'win/resources/app.asar')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for block in iter(lambda: fh.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def asar_entries(path):
    with open(path, 'rb') as fh:
        head = fh.read(1 << 22)
    start = head.index(b'{')
    depth = 0
    for i in range(start, len(head)):
        c = head[i:i + 1]
        if c == b'{':
            depth += 1
        elif c == b'}':
            depth -= 1
            if depth == 0:
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
    if not os.path.exists(EXE):
        raise SystemExit('  ! %s not built yet' % EXE)

    size = os.path.getsize(EXE)
    print('installer   %s (%s bytes)' % (os.path.basename(EXE), f'{size:,}'))
    print('sha256      %s' % sha256(EXE))
    print()

    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, 'x')
        proc = subprocess.run(
            ['7z', 'x', '-y', '-o' + out, EXE],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        if proc.returncode != 0:
            print(proc.stdout.decode('utf-8', 'replace'))
            raise SystemExit('  ! 7z could not unpack the installer')

        asar = None
        for root, _dirs, files in os.walk(out):
            for name in files:
                if name in ('app.asar', 'app.asar.unpacked'):
                    pass
                if name == 'app.asar':
                    asar = os.path.join(root, name)
        if not asar:
            raise SystemExit('  ! no app.asar inside the installer')

        rel = os.path.relpath(asar, out)
        inside = sha256(asar)
        expected = sha256(BUILT_ASAR)

        print('app.asar    %s' % rel)
        print('  size      %s bytes' % f'{os.path.getsize(asar):,}')
        print('  inside    %s' % inside)
        print('  built     %s' % expected)
        same = inside == expected
        print('  match     %s' % ('yes — the installer carries the verified build'
                                  if same else 'NO — the installer is stale'))

        names = asar_entries(asar)
        print()
        print('  entries   %d' % len(names))

        # The patch markers, read back out of the packed asar.
        with open(asar, 'rb') as fh:
            blob = fh.read()
        markers = {
            'gates neutralised': b'free build: always bring-your-own',
            'free-plan gate removed': b'free build: the plan no longer gates',
            'wall rewritten': b"Your plan's limit, not a paywall",
            'referral stubbed': b'free build: stub \xe2\x80\x94 the Referral Program widget',
        }
        leaks = {
            'checkout target': b'siteUrl}/pricing',
            'auto top-up': b'/api/auto-refill',
            'balance fetch': b'/api/ai/credits',
            'price string': b'Get 30 credits',
            'buy button': b'btn-buy-credits',
        }
        print()
        ok = same
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
