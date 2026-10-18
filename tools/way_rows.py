# -*- coding: utf-8 -*-
"""Read the same ways on two issues of a PDU sheet, side by side.

The ratings on these drawings are vector outlines, not text, so they
cannot be extracted - they have to be read. Comparing them by pixels or by
path geometry both fail: the issues are re-plotted with different line
weights and different curve tessellation, so everything differs a little
and nothing differs usefully.

What works is cropping the same rows out of each sheet in ITS OWN
coordinates - no registration, no overlay - and reading them. This finds
each way number (the only text on the sheet) and crops the row beside it.

    python tools/way_rows.py <old.pdf> <new.pdf> <out.png> <first-way> <last-way>
"""
import sys

import pymupdf
from PIL import Image, ImageDraw

ZOOM = 4
SPAN = 330      # points from the way number to the far end of its row:
                # rating, symbol, phase, cable size and the load name
RIGHT = 26


def rows(path, first, last):
    page = pymupdf.open(path)[0]
    m = page.rotation_matrix
    every, hits = [], []
    for b in page.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            for s in l['spans']:
                t = s['text'].strip()
                if not t.isdigit() or not t.isascii():
                    continue
                r = pymupdf.Rect(s['bbox']) * m
                every.append(r.x0)
                if first <= int(t) <= last:
                    hits.append((int(t), r))
    if not hits:
        raise SystemExit('no way numbers %d-%d found in %s' % (first, last, path))
    # The way numbers sit in two adjacent columns near the middle of the
    # sheet, one for each mirrored half, and which half a way is in decides
    # which side of its number the rating and label are drawn on. Compare
    # against EVERY way number on the sheet - the wanted ones are usually all
    # in one column, which on its own says nothing.
    lo, hi = min(every), max(every)
    col = min(r.x0 for _, r in hits)
    right_half = (col - lo) > (hi - lo) / 2
    hits = [(q, r) for q, r in hits if r.x0 < col + 12]
    hits.sort(key=lambda h: h[1].y0)
    scale = (hits[-1][1].y0 - hits[0][1].y0) / max(1, (hits[-1][0] - hits[0][0]))
    top = hits[0][1].y0 - 1.1 * scale
    bot = hits[-1][1].y1 + 0.4 * scale
    # The sheet is drawn as two mirrored halves: the left column carries its
    # rating and label to the LEFT of the way number, the right column to the
    # RIGHT of it. Crop the side the labels are actually on.
    unit = page.rect.width / 842.0
    if right_half:
        clip = pymupdf.Rect(col - RIGHT * unit, top, col + SPAN * unit, bot)
    else:
        clip = pymupdf.Rect(col - SPAN * unit, top, col + RIGHT * unit, bot)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(ZOOM, ZOOM), clip=clip)
    return Image.frombytes('RGB', (pix.width, pix.height), pix.samples)


def main():
    old_path, new_path, out, first, last = sys.argv[1:6]
    ims = [(t, rows(p, int(first), int(last)))
           for t, p in (('OLD', old_path), ('NEW', new_path))]
    h = max(i.height for _, i in ims)
    ims = [(t, i.resize((int(i.width * h / i.height), h), Image.LANCZOS)) for t, i in ims]
    canvas = Image.new('RGB', (sum(i.width + 16 for _, i in ims), h + 20), 'white')
    d = ImageDraw.Draw(canvas)
    x = 0
    for tag, im in ims:
        d.text((x + 4, 3), tag, fill=(200, 0, 0) if tag == 'OLD' else (0, 140, 0))
        canvas.paste(im, (x, 18)); x += im.width + 16
    canvas.save(out)
    print('%s  %dx%d' % (out, canvas.width, canvas.height))


main()
