# -*- coding: utf-8 -*-
"""Find which ways changed between two issues of a PDU sheet.

The companion to way_rows.py: this says WHICH rows to look at, way_rows.py
shows you the two issues of those rows side by side so you can read them.

The labels and ratings are vector outlines, not text, so nothing can be
extracted and compared. But a row that gained or lost a word changes a lot
of ink, and a row that was merely re-plotted changes very little - so each
row is cropped in ITS OWN coordinates (no registration, no overlay),
scaled to one size, blurred to kill the stroke-weight difference, and
compared. Rows well above the sheet's own noise floor are the ones that
changed.

    python tools/way_sweep.py <old.pdf> <new.pdf> [first] [last]

Two things this gets right that cost a wrong answer each when they were
got wrong:

  * The board is drawn as two mirrored halves. The left half carries its
    label to the LEFT of the way number and the right half to the RIGHT.
    Cropping the wrong side reads the other half of the sheet, which once
    flagged PDU-4 Q65 and Q66 - the rows that happen to sit at the same
    height as the two that really changed.

  * A label can run to two lines, "CABIN A-10" with "SPARE" beneath it,
    inside one row's pitch. A strip that only hugs the way-number baseline
    splits that word between two rows and blames the wrong one, which it
    did for PDU-6 Q12.

A re-plot at a different page rotation raises the noise floor a lot - the
whole sheet shifts by a fraction of a pixel - so judge a flagged row
against the median printed below it, not against zero. Sheets re-plotted
the same way sit at a median of 0.00 and anything real stands out
immediately.
"""
import os
import sys

import pymupdf
from PIL import Image, ImageFilter

ZOOM = 3
# A row's content straddles its own conductor line. The rating block
# ("32A DPRCBO / 30mA") is drawn ABOVE the line it belongs to, and a
# two-line label ("CABIN A-10" / "SPARE") hangs BELOW it. So the strip
# has to reach most of a row pitch upwards and about half of one down.
# Getting this wrong hid a rating change once: with UP at 6 pt, PDU-4's
# 16A -> 32A at Q33 scored 0.10 while Q32, the row above, scored 0.22 -
# the change was real and landed almost entirely on its neighbour.
# The strips of adjacent rows now overlap, so one change can show on two
# rows. That is the right way round: read both rather than miss one.
UP = 21          # points above the way-number baseline
DOWN = 13        # ... and below it
SPAN = 300       # how far along the row to read
SIZE = (320, 48)
BLUR = 1.6


def rects(path, first, last):
    """Way number -> its own Q-number rectangle, in rotated page space."""
    page = pymupdf.open(path)[0]
    m = page.rotation_matrix
    seen = {}
    for b in page.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            for s in l['spans']:
                t = s['text'].strip()
                if not (t.isdigit() and t.isascii()):
                    continue
                n = int(t)
                if not (first <= n <= last):
                    continue
                r = pymupdf.Rect(s['bbox']) * m
                if n not in seen or r.x0 < seen[n].x0:
                    seen[n] = r
    return page, seen


def sides(seen):
    """Which way numbers are in the left half and which in the right."""
    xs = sorted(r.x0 for r in seen.values())
    split = (xs[0] + xs[-1]) / 2.0
    return dict((n, 'l' if r.x0 < split else 'r') for n, r in seen.items())


def strip(page, r, side):
    if side == 'l':
        clip = pymupdf.Rect(r.x0 - SPAN, r.y0 - UP, r.x0 - 2, r.y1 + DOWN)
    else:
        clip = pymupdf.Rect(r.x1 + 2, r.y0 - UP, r.x1 + SPAN, r.y1 + DOWN)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(ZOOM, ZOOM), clip=clip)
    img = Image.frombytes('RGB', (pix.width, pix.height), pix.samples).convert('L')
    return img.resize(SIZE).filter(ImageFilter.GaussianBlur(BLUR))


def ink(img):
    px = img.load()
    return [255 - px[x, y] for y in range(img.height) for x in range(img.width)]


def sweep(old, new, first=1, last=78):
    po, ro = rects(old, first, last)
    pn, rn = rects(new, first, last)
    ways = sorted(set(ro) & set(rn))
    odd = sorted(set(ro) ^ set(rn))
    if odd:
        print('  ways found on only one issue: %s' % odd)

    so, sn = sides(ro), sides(rn)
    moved = [n for n in ways if so[n] != sn[n]]
    if moved:
        print('  ways that changed half between issues: %s' % moved)

    scores = []
    for n in ways:
        a = ink(strip(po, ro[n], so[n]))
        b = ink(strip(pn, rn[n], sn[n]))
        scores.append((sum(abs(x - y) for x, y in zip(a, b)) / float(len(a)), n))

    scores.sort(reverse=True)
    med = sorted(d for d, _ in scores)[len(scores) // 2]
    cut = max(1.0, med * 4)
    flagged = [(d, n) for d, n in scores if d > cut]

    print('  %d ways compared, median difference %.2f, threshold %.2f'
          % (len(scores), med, cut))
    if flagged:
        print('  CHANGED: %s' % ', '.join('Q%d (%.2f)' % (n, d) for d, n in flagged))
    else:
        print('  CHANGED: none above the threshold')
    rest = scores[len(flagged):len(flagged) + 5]
    print('  next below: %s' % ', '.join('Q%d (%.2f)' % (n, d) for d, n in rest))
    return [n for _, n in flagged]


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    first = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    last = int(sys.argv[4]) if len(sys.argv) > 4 else 78
    print('%s  ->  %s' % (os.path.basename(sys.argv[1]), os.path.basename(sys.argv[2])))
    sweep(sys.argv[1], sys.argv[2], first, last)


if __name__ == '__main__':
    main()
