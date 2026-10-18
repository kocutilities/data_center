# -*- coding: utf-8 -*-
"""Compare two plots of the same drawing and show only what changed.

Kept in the repo because every revision of the PDU single line diagrams is
checked this way, and a tool that lives in a scratch directory is gone by
the next revision.

The issues are re-plotted at different page sizes and scales, so the two
sheets are first registered on each other: a least-squares fit of scale and
offset over the text that appears exactly once on each sheet (the way
numbers and the title block do), x and y separately. A residual of more
than a fraction of a point means the fit is not trustworthy and the result
should not be believed.

The old page is then drawn onto a page the size of the new one, both are
rasterised, and the ink that exists in only one of them is clustered into
regions. Each region is written out OLD over NEW so a label can be read
against what it replaced.

    python tools/drawing_diff.py <old.pdf> <new.pdf> <out-dir>

Labels on these drawings are vector outlines, not text, so nothing can be
extracted - they have to be read. That is what the crops are for.
"""
import os
import sys
from collections import Counter

import numpy as np
import pymupdf
from PIL import Image, ImageDraw
from scipy import ndimage

ZOOM = 3            # render scale; 3 is legible for 2 mm lettering
INK = 140           # below this grey value counts as ink
TOL = 3             # dilation, in rendered pixels, before calling ink "missing"
GAP = 45            # changed pixels closer than this belong to one region
MIN_PIXELS = 12     # ignore specks: anti-aliasing, hairline shifts

# TOL is the one number to be careful with. It absorbs the hairline
# differences between two plots of the same geometry, but every pixel it
# absorbs is a change it can no longer see. At 7 it hid a 32A -> 25A
# rating change on PDU-1 Q28 (16-10-2026): one digit, in the same place,
# inside otherwise identical ink. 3 catches that and still ignores
# re-plotting noise. Raise it only with something specific to compare
# against.


def spans(page):
    """Text positions in DISPLAY space.

    A rotated page (/Rotate 90 or 270 - the 16-10-2026 issues are A3 at 270)
    reports text in unrotated coordinates while it renders rotated, so the
    two have to be brought into the same frame before anything is fitted.
    """
    m = page.rotation_matrix
    out = []
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines', []):
            for s in line['spans']:
                r = pymupdf.Rect(s['bbox']) * m
                out.append((s['text'], r.x0, r.y0))
    return out


def fit(old_spans, new_spans):
    """scale + offset taking the old sheet onto the new one."""
    old_count = Counter(t for t, _, _ in old_spans)
    new_count = Counter(t for t, _, _ in new_spans)
    new_pos = {t: (x, y) for t, x, y in new_spans if new_count[t] == 1}
    pairs = [(x, y) + new_pos[t] for t, x, y in old_spans if old_count[t] == 1 and t in new_pos]
    if len(pairs) < 8:
        raise SystemExit('only %d anchors in common - the sheets are too different to register'
                         % len(pairs))
    p = np.array(pairs)
    sx, tx = np.polyfit(p[:, 0], p[:, 2], 1)
    sy, ty = np.polyfit(p[:, 1], p[:, 3], 1)
    rx = np.abs(p[:, 2] - (sx * p[:, 0] + tx)).max()
    ry = np.abs(p[:, 3] - (sy * p[:, 1] + ty)).max()
    return sx, tx, sy, ty, rx, ry, len(pairs)


def grey(pix):
    return np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)[..., :3].mean(2)


def run(old_path, new_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    old_doc = pymupdf.open(old_path); old = old_doc[0]
    new_doc = pymupdf.open(new_path); new = new_doc[0]

    sx, tx, sy, ty, rx, ry, n = fit(spans(old), spans(new))
    print('fit: scale %.4f / %.4f, offset %.1f / %.1f, max residual %.2f / %.2f pt on %d anchors'
          % (sx, sy, tx, ty, rx, ry, n))
    if max(rx, ry) > 1.0:
        print('WARNING: residual over 1 pt - treat the regions below with suspicion')

    placed = pymupdf.open()
    page = placed.new_page(width=new.rect.width, height=new.rect.height)
    page.show_pdf_page(pymupdf.Rect(tx, ty, tx + sx * old.rect.width, ty + sy * old.rect.height),
                       old_doc, 0, keep_proportion=False)

    g_old = grey(page.get_pixmap(matrix=pymupdf.Matrix(ZOOM, ZOOM), alpha=False))
    g_new = grey(new.get_pixmap(matrix=pymupdf.Matrix(ZOOM, ZOOM), alpha=False))
    ink_old, ink_new = g_old < INK, g_new < INK
    k = np.ones((TOL, TOL), bool)
    only = (ink_old & ~ndimage.binary_dilation(ink_new, k)) | (ink_new & ~ndimage.binary_dilation(ink_old, k))

    labels, _ = ndimage.label(ndimage.binary_dilation(only, np.ones((GAP, GAP), bool)))
    boxes = []
    for sl in ndimage.find_objects(labels):
        y0, y1, x0, x1 = sl[0].start, sl[0].stop, sl[1].start, sl[1].stop
        changed = only[y0:y1, x0:x1].sum()
        if changed >= MIN_PIXELS:
            boxes.append((y0, x0, y1, x1, changed))
    boxes.sort()
    print('%d changed regions' % len(boxes))

    for i, (y0, x0, y1, x1, changed) in enumerate(boxes):
        pad_y, pad_x = 55, 200          # enough context to read the row and its way number
        y0 = max(0, y0 - pad_y); x0 = max(0, x0 - pad_x)
        y1 = min(g_new.shape[0], y1 + pad_y); x1 = min(g_new.shape[1], x1 + pad_x)
        crop_old = Image.fromarray(g_old[y0:y1, x0:x1].astype(np.uint8)).convert('RGB')
        crop_new = Image.fromarray(g_new[y0:y1, x0:x1].astype(np.uint8)).convert('RGB')
        canvas = Image.new('RGB', (crop_old.width, crop_old.height * 2 + 36), 'white')
        d = ImageDraw.Draw(canvas)
        d.text((4, 2), 'OLD', fill=(200, 0, 0)); canvas.paste(crop_old, (0, 16))
        d.text((4, crop_old.height + 20), 'NEW', fill=(0, 140, 0))
        canvas.paste(crop_new, (0, crop_old.height + 36))
        name = 'r%02d_y%d_x%d.png' % (i, y0 // ZOOM, x0 // ZOOM)
        canvas.save(os.path.join(out_dir, name))
        print('  %-22s %6d px  at %d,%d-%d,%d pt'
              % (name, changed, x0 // ZOOM, y0 // ZOOM, x1 // ZOOM, y1 // ZOOM))


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    run(sys.argv[1], sys.argv[2], sys.argv[3])
