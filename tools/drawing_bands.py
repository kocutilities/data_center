# -*- coding: utf-8 -*-
"""Full-width strips of a drawing, OLD above NEW, registered the same way
as drawing_diff.py.

drawing_diff.py says WHERE a sheet changed; this says WHICH WAY changed,
because a full-width strip carries the label, the rating, the phase and the
way number on one line.

    python tools/drawing_bands.py <old.pdf> <new.pdf> <out-dir> y0:y1 [y0:y1 ...]

The y values are in the NEW sheet's display coordinates - the ones
drawing_diff.py prints.
"""
import os
import sys

import numpy as np
import pymupdf
from PIL import Image, ImageDraw

from drawing_diff import spans, fit, grey

ZOOM = 2.4


def run(old_path, new_path, out_dir, jobs):
    os.makedirs(out_dir, exist_ok=True)
    old_doc = pymupdf.open(old_path); old = old_doc[0]
    new_doc = pymupdf.open(new_path); new = new_doc[0]
    sx, tx, sy, ty, rx, ry, n = fit(spans(old), spans(new))
    print('fit: max residual %.2f / %.2f pt on %d anchors' % (rx, ry, n))

    placed = pymupdf.open()
    page = placed.new_page(width=new.rect.width, height=new.rect.height)
    page.show_pdf_page(pymupdf.Rect(tx, ty, tx + sx * old.rect.width, ty + sy * old.rect.height),
                       old_doc, 0, keep_proportion=False)

    for job in jobs:
        y0, y1 = [float(v) for v in job.split(':')]
        clip = pymupdf.Rect(0, y0, new.rect.width, y1)
        strips = [Image.fromarray(grey(p.get_pixmap(matrix=pymupdf.Matrix(ZOOM, ZOOM), clip=clip,
                                                    alpha=False)).astype(np.uint8)).convert('RGB')
                  for p in (page, new)]
        canvas = Image.new('RGB', (strips[0].width, sum(s.height for s in strips) + 36), 'white')
        d = ImageDraw.Draw(canvas)
        d.text((4, 2), 'OLD', fill=(200, 0, 0)); canvas.paste(strips[0], (0, 16))
        d.text((4, strips[0].height + 20), 'NEW', fill=(0, 140, 0))
        canvas.paste(strips[1], (0, strips[0].height + 36))
        name = 'band_%d-%d.png' % (y0, y1)
        canvas.save(os.path.join(out_dir, name))
        print('  %s  %dx%d' % (name, canvas.width, canvas.height))


if __name__ == '__main__':
    if len(sys.argv) < 5:
        raise SystemExit(__doc__)
    run(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:])
