/* =============================================================
   test_load_study.js

   Several requests at once: the share each one puts on each way, and
   what the survivors carry when a feed is lost. The worked case is
   the real one - two cabinets onto C-09's four ways, PDU-3 Q13/Q14
   and PDU-2 Q13/Q14.

       node apps-script/test_load_study.js
   ============================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.resolve(__dirname, '..', 'assets', 'js');
const sandbox = {
    location: { search: '', pathname: '/', hash: '' },
    history: { replaceState() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    console
};
vm.createContext(sandbox);
for (const f of ['config.js', 'koc-criteria.js', 'system-model.js', 'cabinet-model.js', 'load-study.js']) {
    vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), sandbox, { filename: f });
}
const S = vm.runInContext('DC_LOADSTUDY', sandbox);
const CFG = vm.runInContext('DC_CONFIG', sandbox);

let pass = 0, fail = 0;
function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log('  %s  %s%s', ok ? 'PASS' : 'FAIL', name,
        ok ? '' : '\n        got  ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want));
    ok ? pass++ : fail++;
}
const section = t => console.log('\n' + t);
const r2 = n => Math.round(n * 100) / 100;

const C09 = [{ pdu: 'PDU 3', q: 'Q13' }, { pdu: 'PDU 3', q: 'Q14' },
             { pdu: 'PDU 2', q: 'Q13' }, { pdu: 'PDU 2', q: 'Q14' }];
const cabinet = (id, w) => ({ id, name: 'Cabinet ' + id, size: 1.2, unit: 'kw', pf: 1, phases: '1',
                              type: 'continuous', category: 'critical', point: 'PDU 3', ways: w || C09 });

/* ======================================================== one request over four ways */
section('One 1.2 kW cabinet over C-09\'s four ways');
{
    const r = S.normalise(cabinet('X'));
    check('1.2 kW at unity is 5.01 A in one phase', r2(r.amps), 5.01);
    check('it lands on two feeds', r.feeds.sort(), ['A', 'B']);
    const sh = S.sharesOf(r);
    check('a quarter on each way in normal running',
          Object.keys(sh).map(k => r2(sh[k].normal)), [1.25, 1.25, 1.25, 1.25]);
    check('lose Feed B: the two PDU-3 ways carry half each, PDU-2 nothing',
          [r2(sh['PDU|PDU 3|Q13'].lossB), r2(sh['PDU|PDU 3|Q14'].lossB),
           sh['PDU|PDU 2|Q13'].lossB, sh['PDU|PDU 2|Q14'].lossB], [2.5, 2.5, 0, 0]);
    check('lose Feed A: the mirror image',
          [sh['PDU|PDU 3|Q13'].lossA, r2(sh['PDU|PDU 2|Q13'].lossA)], [0, 2.5]);
    check('nothing is lost in the sharing: each case sums to the whole load',
          ['normal', 'lossA', 'lossB'].map(c => r2(Object.keys(sh).reduce((s, k) => s + sh[k][c], 0))),
          [5.01, 5.01, 5.01]);
    check('dual-fed', S.redundancyOf(r), { onA: 2, onB: 2, dual: true, dark: null });
}

/* ======================================================== two requests together */
section('Two such cabinets on the same four ways');
{
    const reqs = [cabinet('A'), cabinet('B')].map(S.normalise);
    const agg = S.aggregate(reqs);
    check('2.4 kW, 10.02 A in total', [r2(agg.totals.kw), r2(agg.totals.amps)], [2.4, 10.02]);
    check('four ways affected', agg.totals.ways, 4);
    const w13 = agg.byWay['PDU|PDU 3|Q13'];
    check('PDU-3 Q13 takes 2.5 A from the two requests together', r2(w13.normal), 2.5);
    check('  ... and 5.01 A if Feed B is lost', r2(w13.lossB), 5.01);
    check('  ... from both requests, named', w13.items.map(i => [i.req.id, r2(i.normal)]), [['A', 1.25], ['B', 1.25]]);
    check('the point carries the sum of both', [r2(agg.byPoint['PDU 3'].amps), agg.byPoint['PDU 3'].requests.length],
          [10.02, 2]);

    /* the C-09 case worked by hand, from the request sheet's own figures:
       PDU-3 Q13 4.1 A and PDU-2 Q13 4.2 A today                          */
    check('lose Feed B: PDU-3 Q13 carries 4.1 + 4.2 + 5.01 = 13.31 A',
          r2(4.1 + 4.2 + w13.lossB), 13.31);
    check('  ... 52 % of its 25.6 A continuous rating (32 A breaker)',
          Math.round((4.1 + 4.2 + w13.lossB) / (32 * 0.8) * 1000) / 10, 52);
    /* and what the pair of PDU incomers does with it: 120.4 A on R today */
    check('the PDU incomer takes the whole request, not a share: 120.4 + 10.02 = 130.4 A',
          r2(120.4 + agg.totals.amps), 130.42);
}

/* ======================================================== diversity, phases, category */
section('Mixed requests at one point');
{
    const a = S.normalise(cabinet('A'));
    const b = S.normalise(Object.assign(cabinet('B'), { size: 3, unit: 'kw', pf: 0.9, phases: '3',
        type: 'standby', category: 'essential', ways: [{ pdu: 'PDU 3', q: 'Q30' }] }));
    const agg = S.aggregate([a, b]);
    const p = agg.byPoint['PDU 3'];
    check('standby diversity is applied to its own request only',
          [r2(a.demandAmps / a.amps), r2(b.demandAmps / b.amps)], [1, KOC_STANDBY(sandbox)]);
    check('the strictest category governs the point', p.category, 'critical');
    check('any single-phase request makes the point single-phase for the worst case', p.phases, '1');
    check('the power factor is weighted by kVA', r2(p.pf), r2((a.kva * 1 + b.kva * 0.9) / (a.kva + b.kva)));
    check('five ways in all', agg.totals.ways, 5);
}
function KOC_STANDBY(sb) { return vm.runInContext('KOC.diversity.standby', sb); }

/* ======================================================== a request with no second feed */
section('A request with every way on one feed');
{
    const r = S.normalise(cabinet('S', [{ pdu: 'PDU 3', q: 'Q13' }, { pdu: 'PDU 3', q: 'Q14' }]));
    check('no redundancy, and the feed it dies with is named', S.redundancyOf(r), { onA: 2, onB: 0, dual: false, dark: 'B' });
    const sh = S.sharesOf(r);
    check('lose Feed A and it carries nothing anywhere - it is dark',
          Object.keys(sh).map(k => sh[k].lossA), [0, 0]);
    check('lose Feed B and it is unaffected', Object.keys(sh).map(k => r2(sh[k].lossB)), [2.5, 2.5]);
}

/* ======================================================== pairing, for the B2 rule */
section('Pairs, so redundancy is reported once per pair');
{
    const reqs = [cabinet('A')].map(S.normalise);
    const agg = S.aggregate(reqs);
    const partnerFn = w => ({ way: { pdu: w.pdu === 'PDU 3' ? 'PDU 2' : 'PDU 3', q: w.q } });
    const pairs = S.pairsOf(agg, partnerFn);
    check('four ways make two pairs', pairs.length, 2);
    check('  ... Q13 with Q13 and Q14 with Q14',
          pairs.map(p => [p.key, p.otherKey]),
          [['PDU|PDU 3|Q13', 'PDU|PDU 2|Q13'], ['PDU|PDU 3|Q14', 'PDU|PDU 2|Q14']]);
}

/* ======================================================== the schedules agree */
section('The four ways are C-09\'s own, as the schedules have them');
{
    check('all four serve Cabin C-09, 32 A, R and Y',
          C09.map(w => { const c = CFG.pduCircuits[w.pdu].find(x => x.c === w.q); return [c.rack, c.breaker, c.ph]; }),
          [['Cabin C-09', '32A', 'R'], ['Cabin C-09', '32A', 'Y'],
           ['Cabin C-09', '32A', 'R'], ['Cabin C-09', '32A', 'Y']]);
}

console.log('\n%d passed, %d failed\n', pass, fail);
process.exit(fail ? 1 : 0);
