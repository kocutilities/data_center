# -*- coding: utf-8 -*-
"""Bring the PDU breaker field form back in step with config.js.

The form is filled in by hand on the floor, so it is never regenerated -
only the parts the schedules decide are rewritten: what each way serves,
its breaker and phase, the spare styling, and the counts in the tab
headers, the summary and the instructions. Everything else, including the
yellow phase cells people write into, is left exactly as it is.

    python tools/sync_forms.py [--check]

--check reports what would change and writes nothing, which is what to run
before a reading round to see whether the printed form is still current.
"""
import io
import json
import os
import re
import subprocess
import sys

import openpyxl
from openpyxl.styles import Font

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# BASE is the web app folder; the field forms sit beside it
FORM = os.path.join(os.path.dirname(BASE), 'Field forms',
                    'KOC Data Center - PDU Breaker Load Reading.xlsx')

SPARE_FONT = Font(italic=True, color='FF808080')
LIVE_FONT = Font()
COL = {'circuit': 1, 'serves': 2, 'breaker': 3, 'phase': 4}
FIRST_ROW = 8


def schedules():
    out = subprocess.run(['node', '-e', """
const fs=require('fs'),vm=require('vm');
const ctx={location:{search:'',hash:''},history:{replaceState(){}},
  localStorage:{getItem(){return null},setItem(){},removeItem(){}},
  atob:s=>Buffer.from(s,'base64').toString('binary'),console};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('assets/js/config.js','utf8'),ctx,{filename:'config.js'});
process.stdout.write(JSON.stringify(vm.runInContext('DC_CONFIG.pduCircuits',ctx)));
"""], cwd=BASE, capture_output=True, text=True)
    if out.returncode:
        raise SystemExit('could not read config.js:\n' + out.stderr)
    return json.loads(out.stdout)


def phase_text(ph):
    # the form's own wording, which is not this file's to restyle
    return '3 phase' if str(ph) == '3' else str(ph) + ' phase'


def main():
    check_only = '--check' in sys.argv
    pdu = schedules()
    is_spare = lambda r: bool(re.search('spare', r or '', re.I))
    wb = openpyxl.load_workbook(FORM)
    changes = []
    totals = {'ways': 0, 'live': 0}

    for name, ways in pdu.items():
        ws = wb[name]
        live = sum(0 if is_spare(w['rack']) else 1 for w in ways)
        totals['ways'] += len(ways); totals['live'] += live
        header = re.sub(r'\d+ ways, \d+ in service, \d+ spare',
                        '%d ways, %d in service, %d spare' % (len(ways), live, len(ways) - live),
                        ws.cell(2, 1).value)
        if header != ws.cell(2, 1).value:
            changes.append('%s header -> %s' % (name, header))
            ws.cell(2, 1).value = header
        for i, w in enumerate(ways):
            row = FIRST_ROW + i
            assert ws.cell(row, COL['circuit']).value == w['c'], \
                ('%s row %d is %s, expected %s' % (name, row, ws.cell(row, COL['circuit']).value, w['c']))
            for key, value in (('serves', w['rack']), ('breaker', w['breaker']),
                               ('phase', phase_text(w['ph']))):
                cell = ws.cell(row, COL[key])
                if cell.value != value:
                    changes.append('%s %s %s: %r -> %r' % (name, w['c'], key, cell.value, value))
                    cell.value = value
            ws.cell(row, COL['serves']).font = SPARE_FONT if is_spare(w['rack']) else LIVE_FONT

    summary = wb['Summary']
    for r in range(5, 13):
        ways = pdu[summary.cell(r, 1).value]
        live = sum(0 if is_spare(w['rack']) else 1 for w in ways)
        summary.cell(r, 3).value = len(ways)
        summary.cell(r, 4).value = live
        summary.cell(r, 5).value = len(ways) - live

    ins = wb['Instructions']
    ins.cell(5, 1).value = re.sub(
        r'\d+ ways, \d+ in service and \d+ spare',
        '%d ways, %d in service and %d spare' % (totals['ways'], totals['live'],
                                                 totals['ways'] - totals['live']),
        ins.cell(5, 1).value)

    print('%d differences' % len(changes))
    for c in changes:
        print('  ', c)
    if check_only:
        print('(--check: nothing written)')
        return
    wb.save(FORM)
    print('written: %s' % FORM)
    print('totals: %d ways, %d in service, %d spare'
          % (totals['ways'], totals['live'], totals['ways'] - totals['live']))


main()
