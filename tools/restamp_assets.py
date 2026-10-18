# -*- coding: utf-8 -*-
"""Re-stamp ?v= on every asset link, from the content of the assets.

One stamp for the whole set, derived from the bytes: change any asset and
every page asks for fresh copies of all of them; change none and the stamp
does not move, so a deploy that touched only HTML keeps a warm cache.

    python tools/restamp_assets.py

Run it after every edit to anything under assets/, before committing.
"""
import glob
import hashlib
import io
import os
import re

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

assets = sorted(glob.glob(os.path.join(BASE, 'assets', 'js', '*.js')) +
                glob.glob(os.path.join(BASE, 'assets', 'css', '*.css')))
h = hashlib.sha1()
for a in assets:
    h.update(os.path.basename(a).encode())
    h.update(io.open(a, 'rb').read())
stamp = h.hexdigest()[:8]

link = re.compile(r'(assets/(?:js|css)/[A-Za-z0-9_.-]+)(\?v=[0-9a-f]+)?')
rewritten = 0
for page in sorted(glob.glob(os.path.join(BASE, '*.html'))):
    s = io.open(page, encoding='utf-8', newline='').read()
    new, n = link.subn(lambda m: m.group(1) + '?v=' + stamp, s)
    if new != s:
        io.open(page, 'w', encoding='utf-8', newline='').write(new)
        rewritten += 1
    print('%-26s %d links' % (os.path.basename(page), n))
print('stamp %s, %d pages rewritten, %d assets hashed' % (stamp, rewritten, len(assets)))
