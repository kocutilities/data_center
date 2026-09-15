/* =============================================================
   KOC Data Center - Additional Load Study
   additional-load.js

   Takes a proposed load and runs it through the KOC assessment sequence
   from the standards study, against the currents actually recorded.

   The same three principles as the assessment page. The one that matters
   most here: a clean "Accept" is almost never available from current
   readings alone, because cable capacity, voltage drop, discrimination and
   fault level all need inputs the reading sheet does not hold. The honest
   verdict is "Accept subject to", with the outstanding items named.
   ============================================================= */

(function () {
    'use strict';

    var ENDPOINT_KEY = 'koc-dc-endpoint';
    var THEME_KEY = 'koc-dc-theme';
    var DERATE_KEY = 'koc-dc-feeder-plate';

    var $ = function (id) { return document.getElementById(id); };
    var readings = {};        /* single-day basis */
    var hist = null;          /* historical basis: {stats, demand, cover, years} */
    var histError = null;     /* set when the history request itself fails */
    var basis = 'today';      /* 'today' | '1' | '2' | '3' | '4' | '5' (years) */
    var plateBasis = 'frame';

    var V = DC_SYSTEM.systemVoltage;
    var SQRT3 = Math.sqrt(3);
    var V_PH = V / SQRT3;                  /* 239.6 V, phase to neutral */

    /* a connection point that is a PDU, and so has breakers to choose from */
    function isPdu(point) { return !!(DC_CONFIG.pduCircuits && DC_CONFIG.pduCircuits[point]); }

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }
    /* One resolver for the whole app - see the note at the end of config.js.
       Five copies of this used to disagree: only the Load Reading page fell
       back to DC_CONFIG.endpoint, so filling that in left the other four
       still saying "no sheet connected". */
    function endpointUrl() {
        return (typeof DC_ENDPOINT === 'function') ? DC_ENDPOINT() : '';
    }
    function fmt(n, dp) {
        if (n === null || n === undefined || !isFinite(n)) return '—';
        return n.toFixed(dp === undefined ? 0 : dp);
    }
    function maxPhase(key) {
        var r = readings[key];
        if (!r) return null;
        return Math.max(Number(r.r) || 0, Number(r.y) || 0, Number(r.b) || 0);
    }

    /* The value a rule is judged against under the active basis.

       On the historical basis this is the WORST condition actually recorded
       in the period, not the average. A new load has to fit on the day the
       system was busiest, not on a typical day - an average would sail past
       the summer peak and approve a load that fails every August. */
    function basisValue(key) {
        if (basis === 'today') return maxPhase(key);
        if (!hist || !hist.stats || !hist.stats[key]) return null;
        return hist.stats[key].max;
    }

    function basisStats(key) {
        if (basis === 'today' || !hist || !hist.stats) return null;
        return hist.stats[key] || null;
    }

    /* Site demand under the active basis. On history this is the worst
       COINCIDENT total - both incomers on the same date - computed by the
       server, never max(A) + max(B) from different dates. */
    function basisDemand() {
        if (basis === 'today') {
            var a = maxPhase('Main|Incomer A|'), b = maxPhase('Main|Incomer B|');
            if (a === null || b === null) return null;
            return { value: a + b, label: 'recorded on ' + $('date').value, when: $('date').value };
        }
        if (!hist || !hist.demand) return null;
        return { value: hist.demand.max, label: 'worst coincident demand in the period',
                 when: hist.demand.maxDate, stats: hist.demand };
    }

    /* How well the requested period is actually covered by data. This is the
       part that must not be glossed over: a five year button pressed against
       two days of records has to say so, and must stop the page reporting a
       confident pass. */
    function coverage() {
        if (basis === 'today') return { quality: 'today' };
        if (!hist) return { quality: 'none', dates: 0 };
        var c = hist.cover || { dates: 0 };
        var years = Number(basis);
        var wantDays = Math.round(years * 365.25);
        var spanDays = 0;
        if (c.first && c.last) {
            spanDays = Math.round((new Date(c.last) - new Date(c.first)) / 86400000) + 1;
        }
        var q;
        if (!c.dates) q = 'none';
        else if (c.dates < 12 || spanDays < wantDays * 0.25) q = 'thin';
        else if (spanDays < wantDays * 0.8) q = 'partial';
        else q = 'good';
        return { quality: q, dates: c.dates, first: c.first, last: c.last,
                 spanDays: spanDays, wantDays: wantDays, rows: c.rows,
                 demandDates: hist.demand ? hist.demand.n : 0 };
    }
    /* Why a historical figure is missing. "The sheet holds nothing for this
       item" and "we never got an answer from the sheet" are different
       claims, and only the first says anything about the site. Reporting a
       failed request as an absence of readings would be a statement the
       page is in no position to make. */
    function histGap(what) {
        if (basis === 'today') {
            return what + ' was not recorded on ' + $('date').value + '.';
        }
        if (histError) {
            return 'the history was never retrieved \u2014 the sheet returned "' + histError
                 + '". Nothing is implied about ' + what + '; those readings may well exist.';
        }
        return what + ' has no reading in the ' + basis + ' year'
             + (basis === '1' ? '' : 's') + ' to ' + $('date').value + '.';
    }

    function ratingOf(name) {
        var hit = DC_CONFIG.equipment.filter(function (e) { return e.name === name; })[0];
        return hit ? hit.rated : null;
    }
    /* Where the rating came from, e.g. "ATS-002 way L6" - so a rating in the
       table can be traced back to a device on the drawing. */
    function sourceOf(name) {
        var hit = DC_CONFIG.equipment.filter(function (e) { return e.name === name; })[0];
        return hit && hit.source ? hit.source : '';
    }
    /* The cable the feeder actually runs on, off the single line diagrams.
       The page does NOT rate it: ampacity needs the installation method,
       grouping and route, none of which are on the drawings. Showing the
       size lets the reader see which circuits are worth checking first. */
    function cableOf(name) {
        var hit = DC_CONFIG.equipment.filter(function (e) { return e.name === name; })[0];
        return hit && hit.cable ? hit.cable : '';
    }
    function continuousOf(name) {
        var p = ratingOf(name);
        if (!p) return null;
        return plateBasis === 'frame' ? p * KOC.deratingFactor.value : p;
    }
    function ampsFromKva(kva) { return kva * 1000 / (SQRT3 * V); }
    function kvaFromAmps(a) { return SQRT3 * V * a / 1000; }

    /* ---------------------------------------------------------
       the proposal
       --------------------------------------------------------- */

    function proposal() {
        var mode = $('unit').value;
        var val = parseFloat($('size').value);
        var pf = parseFloat($('pf').value);
        if (!isFinite(val) || val <= 0) return null;
        if (!isFinite(pf) || pf <= 0 || pf > 1) pf = 0.9;

        /* The current is the current in the phase conductor the load actually
           sits on. A three-phase load of S kVA draws S / (1.732 x 415 V) in each
           phase. A single-phase load draws S / 239.6 V - all of it in ONE phase,
           three times the balanced figure. Every rule here judges the worst
           phase, so using the balanced figure for a single-phase load would
           understate what it does to a breaker by a factor of three. */
        var single = $('phases').value === '1';
        var perPhase = function (k) { return single ? k * 1000 / V_PH : ampsFromKva(k); };

        var kva, kw, amps;
        if (mode === 'kw') { kw = val; kva = kw / pf; amps = perPhase(kva); }
        else if (mode === 'kva') { kva = val; kw = kva * pf; amps = perPhase(kva); }
        else { amps = val; kva = single ? V_PH * amps / 1000 : kvaFromAmps(amps); kw = kva * pf; }

        var typeKey = $('loadType').value;                 /* continuous|intermittent|standby */
        var df = KOC.diversity[typeKey];
        var point = $('point').value;
        return {
            kw: kw, kva: kva, amps: amps, pf: pf,
            type: typeKey, df: df,
            demandAmps: amps * df,                          /* contribution to Maximum Demand */
            category: $('category').value,                  /* critical|essential|non-essential */
            point: point,
            phases: $('phases').value,
            way: isPdu(point) ? $('way').value : '',        /* '' = board level, no breaker chosen */
            cords: $('cords').value                         /* dual | single */
        };
    }

    /* ---------------------------------------------------------
       the rules
       --------------------------------------------------------- */

    var out = [];
    function push(o) { out.push(o); return o; }

    /* The incomer that ultimately carries a load connected at this point.
       The upstream path is built nearest-first and always terminates at an
       incomer, so the last matching entry is the one. */
    function incomerFor(point) {
        var path = DC_SYSTEM.upstream[point] || [];
        for (var i = path.length - 1; i >= 0; i--) {
            var n = path[i].split('|')[1];
            if (n === 'Incomer A' || n === 'Incomer B') return n;
        }
        return null;
    }

    /* A1 - the incomer test.

       This is deliberately self-sufficient. It needs nothing but the
       incomer's own recorded maximum, so it still returns a real answer on a
       site where the incomers are the only equipment with a history. */
    function ruleIncomer(p) {
        var name = incomerFor(p.point);
        var sp = KOC.spareCapacity;
        var base = {
            id: 'A1', title: 'Incomer capacity against the recorded maximum',
            clause: 'KOC-E-003 Pt 1 Rev 4 cl. ' + sp.clause + '; cl. 11.2.2',
            rule: 'Incomer current after the addition ≤ its continuous rating, '
                + 'retaining ' + Math.round(sp.value * 100) + ' % spare'
        };
        if (!name) {
            return push(Object.assign({}, base, { verdict: 'unknown',
                detail: 'Cannot assess — no upstream path is recorded for ' + p.point + '.' }));
        }

        var key = 'Main|' + name + '|';
        var now = basisValue(key);
        var st = basisStats(key);
        if (now === null) {
            return push(Object.assign({}, base, { verdict: 'unknown',
                detail: 'Cannot assess — ' + histGap(name) }));
        }

        /* A feeder carries the real current, not the diversified demand
           figure: diversity describes a group of loads, not a conductor. */
        var after = now + p.amps;

        /* The capability here is the transformer full load current, 2133 A at
           433 V, which is what the rest of the page judges the incomers
           against. It is NOT passed through continuousOf(): that applies the
           0.8 ambient derating meant for cables and switchgear frame sizes,
           and a transformer specified for the site ambient must not be
           derated a second time. The ACB frame rating, which could be lower,
           is not on record - it is listed as an outstanding check. */
        var tr = DC_SYSTEM.transformers.filter(function (t) {
            return t.incomer === key;
        })[0];
        var cont = tr ? tr.ratedA : (ratingOf(name) || 2133);
        var planning = cont / (1 + sp.value);    /* the level that keeps 15 % spare */
        var spareToRating = cont - after;
        var spareToPlanning = planning - after;

        var state = after > cont ? 'fail' : after > planning ? 'watch' : 'pass';
        var maxAdd = Math.max(0, planning - now);

        var reason;
        if (state === 'fail') {
            reason = 'Not acceptable — ' + name + ' would reach ' + fmt(after, 1) + ' A against a '
                   + 'continuous rating of ' + fmt(cont) + ' A, an overload of '
                   + fmt(after - cont, 1) + ' A. The rating is a thermal limit, not a target, '
                   + 'so no part of this load can be added at this point without reinforcement.';
        } else if (state === 'watch') {
            reason = 'Acceptable on rating, but not on spare capacity — ' + name + ' would reach '
                   + fmt(after, 1) + ' A. That is inside the ' + fmt(cont) + ' A rating, but above '
                   + 'the ' + fmt(planning) + ' A level that keeps the ' + Math.round(sp.value * 100)
                   + ' % spare required by cl. ' + sp.clause + '. Adding it consumes the margin the '
                   + 'standard reserves for future growth. The most that can be added while keeping '
                   + 'that margin is ' + fmt(maxAdd, 1) + ' A.';
        } else {
            reason = 'Acceptable — ' + name + ' would reach ' + fmt(after, 1) + ' A, leaving '
                   + fmt(spareToRating, 1) + ' A to the ' + fmt(cont) + ' A rating and '
                   + fmt(spareToPlanning, 1) + ' A still in hand above the '
                   + Math.round(sp.value * 100) + ' % spare level.';
        }

        var figures = [
            ['Incomer carrying the load', name],
            ['Basis', basis === 'today'
                ? 'reading of ' + $('date').value
                : 'highest recorded in ' + basis + ' year' + (basis === '1' ? '' : 's')],
            ['Highest recorded current', fmt(now, 1) + ' A'
                + (st ? '  on ' + st.maxDate + (st.maxPhase ? ', ' + st.maxPhase + ' phase' : '') : '')],
            ['Proposed load', '+' + fmt(p.amps, 1) + ' A'],
            ['Current after addition', fmt(after, 1) + ' A'],
            ['Continuous capability', fmt(cont) + ' A   (transformer FLC at 433 V)'],
            ['Utilisation after', fmt(after / cont * 100, 1) + ' %'],
            ['Spare to rating', fmt(spareToRating, 1) + ' A'],
            ['Spare to the ' + Math.round(sp.value * 100) + ' % level', fmt(spareToPlanning, 1) + ' A'],
            ['Status', state === 'fail' ? 'NOT ACCEPTABLE' : 'ACCEPTABLE']
        ];
        if (st) {
            figures.push(['Recorded range in period',
                fmt(st.min, 1) + ' – ' + fmt(st.max, 1) + ' A   mean ' + fmt(st.avg, 1)
                + '   median ' + fmt(st.med, 1) + '   from ' + st.n + ' readings']);
        }

        return push(Object.assign({}, base, {
            verdict: state, binding: true, figures: figures, detail: reason,
            headroomAfter: spareToPlanning
        }));
    }

    function ruleTransformer(p) {
        var c = KOC.transformer.doubleRadialFactor;
        var d = basisDemand();
        if (!d) {
            return push({ id: 'A2', title: 'Transformer capacity, contingency case',
                verdict: 'unknown', clause: 'KOC-E-003 Pt 1 Rev 4 cl. ' + c.clause,
                rule: 'Each transformer alone ≥ 1.15 × total Maximum Demand',
                detail: histError
                    ? 'Cannot assess — ' + histGap('the incomers')
                    : basis === 'today'
                        ? 'Cannot assess — both incomer readings are needed and at least one is missing.'
                        : 'Cannot assess — no date in the ' + basis + ' year'
                          + (basis === '1' ? '' : 's') + ' to ' + $('date').value + ' has both '
                          + 'incomers recorded, so no coincident site demand can be established.' });
        }
        var mdNow = d.value;
        var mdNew = mdNow + p.demandAmps;
        var cap = DC_SYSTEM.transformers[0].ratedA;
        var required = c.value * mdNew;
        var ceiling = cap / c.value;
        var pass = cap >= required;

        return push({
            id: 'A2', title: 'Transformer capacity, contingency case',
            verdict: pass ? 'pass' : 'fail',
            clause: 'KOC-E-003 Pt 1 Rev 4 cl. ' + c.clause,
            rule: 'Each transformer alone ≥ 1.15 × total Maximum Demand',
            binding: true,
            figures: [
                ['Maximum Demand basis', basis === 'today'
                    ? 'reading of ' + d.when
                    : 'worst in ' + basis + ' year' + (basis === '1' ? '' : 's') + ', on ' + d.when],
                ['Maximum Demand now', fmt(mdNow) + ' A'],
                ['Proposed contribution', '+' + fmt(p.demandAmps, 1) + ' A'],
                ['Maximum Demand after', fmt(mdNew) + ' A  (' + fmt(kvaFromAmps(mdNew)) + ' kVA)'],
                ['Required per transformer', fmt(required) + ' A'],
                ['Capability per transformer', fmt(cap) + ' A'],
                ['Utilisation after', fmt(required / cap * 100) + ' %'],
                ['Demand ceiling', fmt(ceiling) + ' A']
            ],
            detail: pass
                ? 'One transformer alone still carries the whole demand with the 15 % margin. '
                  + fmt(ceiling - mdNew) + ' A would remain.'
                : 'Rejected — exceeds the contingency limit by ' + fmt(mdNew - ceiling) + ' A. '
                  + 'The most that can be added at this demand is ' + fmt(Math.max(0, ceiling - mdNow))
                  + ' A.',
            headroomAfter: ceiling - mdNew
        });
    }

    function ruleGenerator(p) {
        if (p.category === 'non-essential') {
            return push({ id: 'A3', title: 'Generator capacity',
                verdict: 'na', clause: 'KOC-E-003 Pt 1 Rev 4 cl. 9.1.4',
                rule: 'Non-essential loads are not backed by a generator',
                detail: 'Not applicable — a non-essential load normally has a single source '
                      + 'and no generator backing. If it is in fact to be backed, reclassify it.' });
        }
        var genId = DC_SYSTEM.backedBy[p.point];
        if (!genId) {
            return push({ id: 'A3', title: 'Generator capacity',
                verdict: 'fail', clause: 'KOC-E-003 Pt 1 Rev 4 cl. 9.1.2 / 9.1.3',
                rule: p.category === 'critical'
                    ? 'Critical loads shall be on no-break supply backed by emergency generator'
                    : 'Essential loads shall be backed by a standby generator',
                detail: 'Rejected — ' + p.point + ' is a utility-only supply with no generator '
                      + 'behind it, so a ' + p.category + ' load connected here would be lost on '
                      + 'an incomer failure. Choose a generator-backed connection point.' });
        }
        var g = DC_SYSTEM.generators.filter(function (x) { return x.id === genId; })[0];
        var backed = 0, missing = [];
        g.backs.keys.forEach(function (k) {
            var m = basisValue(k);
            if (m === null) missing.push(k.split('|')[1]); else backed += m;
        });
        if (missing.length) {
            return push({ id: 'A3', title: g.id + ' capacity',
                verdict: 'unknown', clause: 'KOC-E-003 Pt 1 Rev 4 cl. 13.2.3 / 13.3.2',
                rule: 'Continuously rated for Maximum Demand + 15 %',
                detail: 'Cannot assess — ' + histGap(missing.join(', ')) });
        }
        var after = backed + p.demandAmps;
        var required = 1.15 * after;
        var pass = g.ratedA >= required;
        return push({
            id: 'A3', title: g.id + ' capacity',
            verdict: pass ? 'pass' : 'fail',
            clause: 'KOC-E-003 Pt 1 Rev 4 cl. 13.2.3 / 13.3.2',
            rule: 'Continuously rated for Maximum Demand + 15 %',
            figures: [
                ['Backed load now', fmt(backed) + ' A'],
                ['After the addition', fmt(after) + ' A'],
                ['Required rating', fmt(required) + ' A'],
                [g.id + ' rating', fmt(g.ratedA) + ' A'],
                ['Utilisation after', fmt(required / g.ratedA * 100) + ' %']
            ],
            detail: pass
                ? g.id + ' still carries its section with the 15 % margin.'
                : 'Rejected — ' + g.id + ' would be short by ' + fmt(required - g.ratedA) + ' A. '
                  + 'The 10 % / 1 hour overload in KOC-E-007 cl. 11.1.6 is a contingency '
                  + 'allowance and cannot be used to justify planned load.'
        });
    }

    /* every metered point on the path from the connection point upward */
    function ruleUpstream(p) {
        var path = DC_SYSTEM.upstream[p.point] || [];
        var rows = [], anyFail = false, anyUnknown = false;

        path.forEach(function (key) {
            var name = key.split('|')[1];
            var now = basisValue(key);
            var st = basisStats(key);
            /* the incomers are judged by A2, not here */
            if (name === 'Incomer A' || name === 'Incomer B') return;
            if (now === null) {
                rows.push({ name: name, state: 'unknown' }); anyUnknown = true; return;
            }
            var cont = continuousOf(name);
            var after = now + p.amps;      /* a feeder carries the actual current, not the
                                              diversified demand figure */
            var pct = cont ? after / cont * 100 : null;
            var state = pct === null ? 'norating' : pct > 100 ? 'fail' : pct > 87 ? 'watch' : 'pass';
            if (state === 'fail') anyFail = true;
            if (state === 'norating') anyUnknown = true;
            rows.push({ name: name, now: now, after: after, cont: cont, pct: pct,
                        state: state, st: st,
                        plate: ratingOf(name), src: sourceOf(name),
                        cable: cableOf(name),
                        /* cl. 8.3.5 bounds the cable from below by its
                           protection, so a current inside the device rating
                           needs no separate cable check - but one beyond it
                           has left what the cable was ever shown to carry. */
                        cableAtRisk: !!(ratingOf(name) && after > ratingOf(name)) });
        });

        return push({
            id: 'A4', title: 'Feeders on the supply path',
            verdict: anyFail ? 'fail' : anyUnknown ? 'unknown' : 'pass',
            clause: 'KOC-E-009 Rev 3 cl. 6.3; KOC-E-003 Pt 1 cl. 11.2.2',
            rule: 'Every feeder carrying the load ≤ its continuous rating',
            rows: rows,
            detail: anyFail
                ? 'Rejected — ' + rows.filter(function (r) { return r.state === 'fail'; })
                    .map(function (r) { return r.name + ' would reach ' + fmt(r.pct) + ' %'; }).join(', ')
                    + '.'
                : 'The full ' + fmt(p.amps, 1) + ' A is applied at every level, with no diversity '
                  + 'between the load and its feeders.',
            note: DC_SYSTEM.unmeteredOnPath[p.point]
                ? 'Not testable on this path: ' + DC_SYSTEM.unmeteredOnPath[p.point].join(' and ')
                  + ' carry no meter. Their loading is inferred by A5 where possible.'
                : ''
        });
    }

    /* UPS chain, computed from the PDUs it feeds */
    function ruleUps(p) {
        var chain = DC_SYSTEM.ups.filter(function (u) {
            return u.feeds.indexOf('Main|' + p.point + '|') > -1;
        })[0];
        if (!chain) {
            /* Reported rather than omitted, so the sequence always reads A1
               to A7 and the reader can see the check was considered. That a
               load is NOT on a UPS is itself worth stating, especially for
               one declared critical. */
            return push({ id: 'A5', title: 'UPS backing', verdict: 'na',
                clause: 'KOC-E-011 Rev 2 cl. 8.7, 19.1.1',
                rule: 'UPS continuous output, with 15 % spare for future load',
                detail: 'Not applicable — no UPS supplies ' + p.point + ', so there is no UPS '
                      + 'capacity to test.'
                      + (p.category === 'critical'
                          ? ' Note that the load is declared critical yet would sit on the raw '
                            + 'supply at this point, held up only by the generator through the '
                            + 'ATS. Whether that is acceptable is a design question for the '
                            + 'load, not something these readings can settle.'
                          : '') });
        }

        var loads = DC_SYSTEM.ups.map(function (u) {
            var sum = 0, miss = false;
            u.feeds.forEach(function (k) {
                var m = basisValue(k);
                if (m === null) miss = true; else sum += m;
            });
            return { id: u.id, kva: u.kva, ratedA: ampsFromKva(u.kva), amps: sum, missing: miss };
        });
        var mine = loads.filter(function (l) { return l.id === chain.id; })[0];
        if (mine.missing) {
            return push({ id: 'A5', title: chain.id + ' capacity',
                verdict: 'unknown', clause: 'KOC-E-011 Rev 2 cl. 8.7, 19.1.1',
                rule: 'UPS continuous output, with 15 % spare for future load',
                detail: 'Cannot assess — a PDU reading on this chain is missing.' });
        }

        var after = mine.amps + p.amps;
        var required = 1.15 * after;
        var pass = mine.ratedA >= required;

        /* the 2N intent: either UPS alone carrying every PDU */
        var total = loads.reduce(function (s, l) { return s + l.amps; }, 0) + p.amps;
        var soloOk = mine.ratedA >= total;

        return push({
            id: 'A5', title: chain.id + ' capacity  (' + chain.kva + ' kVA)',
            verdict: pass ? (soloOk ? 'pass' : 'watch') : 'fail',
            clause: 'KOC-E-011 Rev 2 cl. 8.7, 19.1.1; cl. 8.2 for redundancy',
            rule: 'Continuous output with 15 % spare; and either UPS alone carrying the room',
            figures: [
                [chain.id + ' load now', fmt(mine.amps) + ' A  (' + fmt(kvaFromAmps(mine.amps)) + ' kVA)'],
                ['After the addition', fmt(after) + ' A'],
                ['Required with 15 %', fmt(required) + ' A'],
                [chain.id + ' rating', fmt(mine.ratedA) + ' A  (' + chain.kva + ' kVA)'],
                ['Both chains after', fmt(total) + ' A  (' + fmt(kvaFromAmps(total)) + ' kVA)'],
                ['One UPS alone carrying all', soloOk ? 'yes' : 'NO']
            ],
            detail: !pass
                ? 'Rejected — ' + chain.id + ' would be short by ' + fmt(required - mine.ratedA) + ' A.'
                : soloOk
                    ? chain.id + ' has capacity, and either UPS alone could still carry the whole room.'
                    : 'The chain itself has capacity, but after this addition ONE UPS could no longer '
                      + 'carry the whole room (' + fmt(total) + ' A against ' + fmt(mine.ratedA)
                      + ' A). The dual-corded arrangement would stop being N+1.',
            note: 'UPS output is not metered — loading is the sum of the PDUs on the chain. '
                + 'The "either UPS alone" test is the design intent recorded on the block '
                + 'diagram; KOC-E-011 cl. 8.2 requires a dual redundant UPS in standard form.'
        });
    }

    function rulePowerFactor(p) {
        var c = KOC.powerQuality.powerFactor;
        var pass = p.pf >= c.min;
        return push({
            id: 'A6', title: 'Power factor of the new load',
            verdict: pass ? 'pass' : 'watch',
            clause: 'KOC-E-003 Pt 1 cl. 9.5.3; KOC-E-006 cl. 9.4.2 (MEWRE Rule 5)',
            rule: 'System power factor ≥ 0.95 lagging',
            detail: pass
                ? 'At ' + p.pf.toFixed(2) + ' the new load does not pull the system below 0.95.'
                : 'The new load is stated at ' + p.pf.toFixed(2) + ', below the 0.95 the system '
                  + 'must maintain. It does not by itself breach the limit — that depends on the '
                  + 'whole system — but correction may be needed. System power factor is not '
                  + 'measured, so this cannot be confirmed from the readings.'
        });
    }

    function ruleUpstreamMew(p) {
        var c = KOC.upstream.mewFeederLimit;
        var d = basisDemand();
        if (!d) return null;
        /* site demand at the stated PF, plus the load's own diversified kW -
           taken from kW, not from its phase current, so a single-phase load
           is not counted three times over */
        var mw = (kvaFromAmps(d.value) * p.pf + p.kw * p.df) / 1000;
        var pass = mw <= c.value;
        return push({
            id: 'A7', title: 'Upstream MEW feeder',
            verdict: pass ? 'pass' : 'fail',
            clause: 'KOC-E-003 Pt 1 Rev 4 cl. ' + c.clause,
            rule: 'Maximum power per MEW 11 kV feeder ≤ 5 MW',
            figures: [['Estimated demand after', fmt(mw, 2) + ' MW at PF ' + p.pf.toFixed(2)],
                      ['Limit', c.value + ' MW']],
            detail: pass ? 'Well within the MEW feeder limit.'
                         : 'Rejected — would exceed the 5 MW MEW feeder limit.',
            note: 'Estimated from the LV currents and the stated power factor; the true 11 kV '
                + 'demand is not metered here.'
        });
    }

    /* ---------------------------------------------------------
       render
       --------------------------------------------------------- */

    /* ---------------------------------------------------------
       PDU breakers - where a load on a PDU actually connects

       A PDU is not one connection point but up to 78, each behind its own
       RCBO. Choosing the breaker tests the load where it lands: the breaker
       itself first (B1), then - because the IT load in this room is
       dual-corded - the breaker on the other feed that must carry everything
       if one feed is lost (B2). The board-level rules A1-A7 still run, on the
       PDU the breaker sits in, with the whole load applied: that is the state
       after a feed is lost, which is the one that has to be survivable.

       Limits - the same as the Power System Assessment and Cabinet Load pages:
         continuous rating = 0.8 x breaker plate      KOC-E-003 Pt 1 cl. 11.2.2
         planning level    = 87 % of continuous       the 15 % spare, cl. 9.4.1(a)
         trip              = the plate itself
       --------------------------------------------------------- */

    var PAIR = { 'PDU 1': 'PDU 6', 'PDU 6': 'PDU 1', 'PDU 3': 'PDU 2', 'PDU 2': 'PDU 3',
                 'PDU 5': 'PDU 4', 'PDU 4': 'PDU 5', 'PDU 7': 'PDU 8', 'PDU 8': 'PDU 7' };
    var PLAN = 0.87;

    function isSpareRack(r) { return /SPARE/i.test(r || ''); }

    function plateOfBreaker(b) {
        var m = String(b || '').match(/(\d+(?:\.\d+)?)/);
        return m ? parseFloat(m[1]) : null;
    }

    function wayOf(pdu, q) {
        var c = ((DC_CONFIG.pduCircuits || {})[pdu] || []).filter(function (x) { return x.c === q; })[0];
        if (!c) return null;
        var plate = plateOfBreaker(c.breaker);
        return {
            pdu: pdu, q: q, rack: c.rack, spare: isSpareRack(c.rack),
            plate: plate, cont: plate === null ? null : plate * KOC.deratingFactor.value,
            ph: c.ph, phases: c.ph === '3' ? ['R', 'Y', 'B'] : [c.ph],
            feed: DC_PDU_FEED[pdu], key: 'PDU|' + pdu + '|' + q
        };
    }

    function polesText(w) {
        return w.ph === '3' ? 'four-pole RCBO, three phase' : 'two-pole RCBO, ' + w.ph + ' phase and neutral';
    }
    function servesText(w) {
        if (!w.spare) return w.rack;
        var rest = String(w.rack).replace(/^SPARE\s*/i, '');
        return rest ? 'Spare (' + rest + ')' : 'Spare';
    }
    function upsOf(feed) { return feed === 'A' ? 'UPS-1' : 'UPS-2'; }

    /* What a breaker carries now, phase by phase, under the active basis.

       A reading that was not taken is not zero - with one stated exception:
       a spare way that nobody read is taken as empty, which is its design
       state, and the report says so rather than assuming it silently.

       On a historical basis the server keeps one figure per way, the worst
       phase, so that figure is applied to every phase of a four-pole way.
       It can only overstate, never hide a peak. */
    function wayNow(w) {
        var o = { I: {}, read: false, assumed: false, worstOnly: false, when: '' };
        if (basis === 'today') {
            var r = readings[w.key];
            var ok = r && w.phases.every(function (ph) {
                var v = r[ph.toLowerCase()];
                return v !== '' && v !== null && v !== undefined && isFinite(Number(v));
            });
            if (ok) {
                w.phases.forEach(function (ph) { o.I[ph] = Number(r[ph.toLowerCase()]); });
                o.read = true;
                o.when = 'reading of ' + $('date').value;
            }
        } else if (hist && hist.stats && hist.stats[w.key]) {
            var st = hist.stats[w.key];
            w.phases.forEach(function (ph) { o.I[ph] = st.max; });
            o.read = true;
            o.worstOnly = w.phases.length > 1;
            o.when = 'highest in ' + basis + ' year' + (basis === '1' ? '' : 's') + ', on ' + st.maxDate;
        }
        if (!o.read) {
            if (!w.spare) return null;
            w.phases.forEach(function (ph) { o.I[ph] = 0; });
            o.assumed = true;
            o.when = 'no reading — taken as 0 A because the way is spare';
        }
        o.peak = Math.max.apply(null, w.phases.map(function (ph) { return o.I[ph]; }));
        o.peakPh = w.phases.filter(function (ph) { return o.I[ph] === o.peak; })[0];
        return o;
    }

    function phaseList(w, I) {
        return w.phases.map(function (ph) { return ph + ' ' + fmt(I[ph], 1); }).join('  ·  ') + ' A';
    }

    /* The breaker the load's second cord would use: the same way number on
       the partner PDU. Same number means same rack position and same phase
       (the layout marks racks "P1 Q74 / P6 Q74"), so it is a true pair only
       when both serve the same cabinet, or both are spare. */
    function partnerOf(w) {
        var otherPdu = PAIR[w.pdu];
        var o = wayOf(otherPdu, w.q);
        if (!o) return { way: null, why: otherPdu + ' has no way ' + w.q };
        if (o.ph !== w.ph) return { way: null, other: o, why: otherPdu + ' ' + w.q + ' is on a different phase' };
        if (w.spare && o.spare) return { way: o, kind: 'spare' };
        if (!w.spare && !o.spare && o.rack === w.rack) return { way: o, kind: 'cabinet' };
        return { way: null, other: o,
                 why: otherPdu + ' ' + w.q + (o.spare ? ' is spare, while this way serves ' + w.rack
                                                      : ' serves ' + o.rack) };
    }

    /* kW that a current represents on this kind of way at the stated PF:
       three phase on a four-pole way, single phase on a two-pole way. */
    /* headroom in words: never a negative "room left" */
    function roomText(a) {
        return a >= 0 ? fmt(a, 1) + ' A' : 'none — ' + fmt(-a, 1) + ' A beyond it';
    }

    function kwOn(w, amps, pf) {
        return (w.ph === '3' ? SQRT3 * V : V_PH) * amps * pf / 1000;
    }

    /* Everything the capacity table and the two rules need about one way. */
    function capacityOf(w) {
        var c = { way: w, now: wayNow(w) };
        if (!c.now || w.cont === null) return c;
        c.lim = w.cont * PLAN;
        c.pct = c.now.peak / w.cont * 100;
        c.state = c.now.peak > w.cont ? 'fail' : c.now.peak > c.lim ? 'watch' : 'pass';
        c.free1 = c.lim - c.now.peak;                           /* one cord, A per phase */
        c.pair = partnerOf(w);
        if (c.pair.way) {
            var pn = wayNow(c.pair.way);
            c.pairNow = pn;
            if (pn && c.pair.way.cont !== null) {
                c.limS = Math.min(c.lim, c.pair.way.cont * PLAN);
                c.free2 = Math.min.apply(null, w.phases.map(function (ph) {
                    return c.limS - (c.now.I[ph] + pn.I[ph]);
                }));
            }
        }
        return c;
    }

    /* Which phases of the way a load puts current into. A three-phase load
       uses all three. A single-phase load on a four-pole way lands on one
       phase that the proposal does not name, so the busiest is taken. */
    function loadedPhases(w, p, now) {
        if (w.ph !== '3') return [w.ph];
        if (p.phases === '3') return ['R', 'Y', 'B'];
        return [now.peakPh];
    }

    function ruleBreaker(p) {
        var w = wayOf(p.point, p.way);
        var dual = p.cords === 'dual';
        var sp = KOC.spareCapacity;
        var base = {
            id: 'B1', title: w.pdu + ' ' + w.q + ' — the breaker the load connects to',
            clause: 'KOC-E-003 Pt 1 Rev 4 cl. 11.2.2 (0.8 derating), cl. ' + sp.clause
                  + ' (15 % spare); KOC-E-009 Rev 3 cl. 6.3',
            rule: 'Current in the breaker after the addition ≤ 87 % of its continuous rating '
                + '(0.8 × plate), and never above it'
        };

        if (p.phases === '3' && w.ph !== '3') {
            return push(Object.assign({}, base, { verdict: 'fail', binding: true,
                figures: [['Breaker', w.pdu + ' ' + w.q + '  ·  ' + w.plate + ' A ' + polesText(w)],
                          ['Proposed load', 'three phase']],
                detail: 'Not possible — a three-phase load cannot be connected to ' + w.pdu + ' ' + w.q
                      + '. It is a two-pole RCBO: it supplies ' + w.ph + ' phase and neutral only. Choose a '
                      + 'four-pole way, or, if the load is in fact single phase, set Connection to single '
                      + 'phase.' }));
        }

        var c = capacityOf(w);
        if (!c.now) {
            return push(Object.assign({}, base, { verdict: 'unknown',
                figures: [['Breaker', w.pdu + ' ' + w.q + '  ·  ' + w.plate + ' A ' + polesText(w)],
                          ['Serves', w.rack]],
                detail: 'Cannot assess — ' + w.pdu + ' ' + w.q + ' serves ' + w.rack + ' but has no reading '
                      + (basis === 'today' ? 'on ' + $('date').value : 'in this period')
                      + '. A breaker that was not read is not taken as 0 A: the cabinet behind it may be '
                      + 'drawing current. Record it, or choose a date when it was read.' }));
        }

        var share = dual ? 0.5 : 1;
        var add = p.amps * share;
        var on = loadedPhases(w, p, c.now);
        var after = {};
        w.phases.forEach(function (ph) { after[ph] = c.now.I[ph] + (on.indexOf(ph) >= 0 ? add : 0); });
        var peakPh = w.phases.reduce(function (m, ph) { return after[ph] > after[m] ? ph : m; }, w.phases[0]);
        var peak = after[peakPh];
        var pct = peak / w.cont * 100;
        var state = peak > w.cont ? 'fail' : peak > c.lim ? 'watch' : 'pass';

        /* the largest load this breaker alone would accept, keeping the 15 % */
        var busiest = Math.max.apply(null, on.map(function (ph) { return c.now.I[ph]; }));
        var maxA = Math.max(0, (c.lim - busiest) / share);
        var loadKw = function (a) {
            return (p.phases === '3' ? SQRT3 * V : V_PH) * a * p.pf / 1000;
        };

        var figures = [
            ['Breaker', w.pdu + ' ' + w.q + '  ·  ' + w.plate + ' A ' + polesText(w)],
            ['Supplied from', 'Feed ' + w.feed + ' — ' + upsOf(w.feed)],
            ['Serves now', servesText(w)],
            ['Continuous rating', fmt(w.cont, 1) + ' A   (0.8 × ' + w.plate + ' A)'],
            ['15 % spare level', fmt(c.lim, 1) + ' A   (87 % of continuous)'],
            ['Carrying now', phaseList(w, c.now.I)],
            ['Basis', c.now.when],
            ['Proposed load current', fmt(p.amps, 1) + ' A '
                + (p.phases === '3' ? 'in each phase' : 'in one phase (single phase, ' + fmt(p.kva, 2)
                                                         + ' kVA ÷ ' + fmt(V_PH, 1) + ' V)')],
            ['Taken by this breaker', dual
                ? fmt(add, 1) + ' A — half; the other cord takes the other half'
                : fmt(add, 1) + ' A — all of it, single-corded'],
            ['After the addition', phaseList(w, after)],
            ['Busiest phase after', fmt(peak, 1) + ' A on ' + peakPh + ' — ' + fmt(pct, 1) + ' % of continuous'],
            ['Room left to the 15 % level', roomText(c.lim - peak)],
            ['Largest load this breaker accepts', fmt(loadKw(maxA), 2) + ' kW   (' + fmt(maxA, 1) + ' A'
                + (dual ? ' total, half on each cord' : '') + ')']
        ];

        var detail;
        var pre = busiest > c.lim
            ? 'Before any addition this breaker already carries ' + fmt(busiest, 1) + ' A, above its '
              + fmt(c.lim, 1) + ' A planning level, so it has no spare to offer. '
            : '';
        if (peak > w.plate) {
            detail = pre + 'Not acceptable — ' + w.pdu + ' ' + w.q + ' would carry ' + fmt(peak, 1) + ' A on '
                   + peakPh + ' phase, above its ' + w.plate + ' A plate. The breaker would trip in normal '
                   + 'running.';
        } else if (state === 'fail') {
            detail = pre + 'Not acceptable — ' + w.pdu + ' ' + w.q + ' would carry ' + fmt(peak, 1) + ' A on '
                   + peakPh + ' phase, ' + fmt(pct, 1) + ' % of its ' + fmt(w.cont, 1) + ' A continuous '
                   + 'rating. It may hold for a while, but a breaker run above its continuous rating is '
                   + 'not a planned condition.';
        } else if (state === 'watch') {
            detail = pre + 'Acceptable on rating, not on spare — ' + w.pdu + ' ' + w.q + ' would reach '
                   + fmt(peak, 1) + ' A (' + fmt(pct, 1) + ' % of continuous). That is inside the rating but '
                   + 'above the ' + fmt(c.lim, 1) + ' A level that keeps 15 % spare. The most this breaker '
                   + 'takes with the margin kept is ' + fmt(loadKw(maxA), 2) + ' kW.';
        } else {
            detail = 'Acceptable — ' + w.pdu + ' ' + w.q + ' would reach ' + fmt(peak, 1) + ' A on '
                   + peakPh + ' phase, ' + fmt(pct, 1) + ' % of its continuous rating, with '
                   + fmt(c.lim - peak, 1) + ' A still in hand above the 15 % level.';
        }
        if (w.spare && !c.now.assumed && c.now.peak > 0) {
            detail += ' Note that this spare way already shows ' + fmt(c.now.peak, 1) + ' A — something '
                    + 'is connected to it that the schedule does not name.';
        }

        var notes = [];
        if (c.now.assumed) notes.push('No reading is recorded for this spare way, so it is taken as empty. '
            + 'Confirm with a clamp reading before connecting — several spare ways in this room have been '
            + 'found carrying load.');
        if (c.now.worstOnly) notes.push('On a historical basis the sheet keeps one figure per way, its worst '
            + 'phase, so that figure is applied to all three phases. This can only overstate the loading.');
        if (p.phases === '1' && w.ph === '3') notes.push('A single-phase load on a four-pole way lands on one '
            + 'phase; which one is not stated, so the busiest phase (' + on[0] + ') is assumed.');
        notes.push('Final circuit cable: by KOC-E-008 cl. 8.3.5 the breaker is set no higher than its cable '
            + 'can carry, so a load within the breaker rating needs no separate cable check, provided the '
            + 'installed conditions are unchanged. Advisory, not a KOC rule: IT power supplies leak current '
            + 'to earth, and on a 30 mA RCBO the total should stay within 30 % of the trip level (BS 7671 '
            + 'Reg. 531.3.2) to avoid nuisance tripping.');

        return push(Object.assign({}, base, {
            verdict: state, binding: true, figures: figures, detail: detail, note: notes.join(' ')
        }));
    }

    function ruleRedundancy(p) {
        var w = wayOf(p.point, p.way);
        var other = PAIR[w.pdu];
        var base = {
            id: 'B2', title: 'If a feed is lost — can one breaker carry the whole load?',
            clause: 'KOC-E-003 Pt 1 Rev 4 cl. 11.2.2; A/B redundancy is the room’s design intent '
                  + '(every rack dual-fed), KOC-E-011 cl. 8.2 for the UPS',
            rule: 'After a PDU, UPS or EMSB failure, the surviving breaker carries both cords’ load '
                + 'and the whole new load, ≤ 87 % of its continuous rating'
        };

        if (p.cords !== 'dual') {
            var detail = 'Single-corded — the load has one supply, ' + w.pdu + ' ' + w.q + ' on Feed '
                + w.feed + '. It goes dark if that breaker, ' + w.pdu + ', ' + upsOf(w.feed) + ' or EMSB-'
                + (w.feed === 'A' ? '1' : '2') + ' fails: the A/B redundancy every cabinet in the room has '
                + 'does not reach it.';
            return push(Object.assign({}, base, {
                verdict: p.category === 'critical' ? 'watch' : 'na',
                detail: detail + (p.category === 'critical'
                    ? ' For a critical load that is a design decision to take knowingly. It is not a '
                      + 'breach of a KOC clause, which is why this is a caution and not a failure.'
                    : '')
            }));
        }

        if (p.phases === '3' && w.ph !== '3') {
            return push(Object.assign({}, base, { verdict: 'na',
                detail: 'Not assessed — the load cannot be connected to this way at all (see B1).' }));
        }

        var c = capacityOf(w);
        if (!c.now) {
            return push(Object.assign({}, base, { verdict: 'unknown',
                detail: 'Cannot assess — ' + w.pdu + ' ' + w.q + ' has no reading, so what the surviving '
                      + 'breaker would carry is unknown.' }));
        }
        if (!c.pair.way) {
            return push(Object.assign({}, base, { verdict: 'unknown',
                detail: 'Cannot assess — the breaker for the second cord is not identifiable: '
                      + c.pair.why + '. The second cord needs a breaker of its own on ' + other
                      + ', and that breaker has to carry the whole load if Feed ' + w.feed + ' is lost. '
                      + 'Name it and check it before connecting, or choose a way whose partner on ' + other
                      + ' is free.' }));
        }
        var pw = c.pair.way, pn = c.pairNow;
        if (!pn) {
            return push(Object.assign({}, base, { verdict: 'unknown',
                detail: 'Cannot assess — the other cord’s breaker, ' + pw.pdu + ' ' + pw.q
                      + ', serves ' + pw.rack + ' and has no reading. A breaker that was not read is not '
                      + 'taken as 0 A.' }));
        }

        var on = loadedPhases(w, p, c.now);
        var loadKw = function (a) { return (p.phases === '3' ? SQRT3 * V : V_PH) * a * p.pf / 1000; };

        /* Each direction on its own. Losing this breaker's feed puts the whole
           cabinet on the partner; losing the partner's feed puts it on this one.
           The current is the same either way - both cords plus the new load -
           but the breaker that must carry it is not, so with unequal breakers
           the answers differ: G-10 survives losing one feed and trips on the
           other. Both are worked and both are reported. */
        var survive = function (lost, surv) {
            var t = {};
            w.phases.forEach(function (ph) {
                t[ph] = c.now.I[ph] + pn.I[ph] + (on.indexOf(ph) >= 0 ? p.amps : 0);
            });
            var pk = w.phases.reduce(function (m, ph) { return t[ph] > t[m] ? ph : m; }, w.phases[0]);
            var I = t[pk], lim = surv.cont * PLAN;
            return { lost: lost, surv: surv, total: t, peak: I, peakPh: pk, lim: lim,
                     pct: I / surv.cont * 100,
                     state: I > surv.plate ? 'trips' : I > surv.cont ? 'fail' : I > lim ? 'watch' : 'pass' };
        };
        var dirs = [survive(w, pw), survive(pw, w)];
        var RANK = { pass: 0, watch: 1, fail: 2, trips: 3 };
        var worst = RANK[dirs[1].state] > RANK[dirs[0].state] ? dirs[1] : dirs[0];
        var otherDir = worst === dirs[0] ? dirs[1] : dirs[0];
        var state = worst.state === 'trips' ? 'fail' : worst.state;

        var both = Math.max.apply(null, on.map(function (ph) { return c.now.I[ph] + pn.I[ph]; }));
        var limS = Math.min(w.cont, pw.cont) * PLAN;
        var maxA = Math.max(0, limS - both);

        var WORD = { pass: 'holds, with the 15 % margin intact',
                     watch: 'holds, inside its rating but above the 15 % level',
                     fail: 'above its continuous rating — holds for a while, not indefinitely',
                     trips: 'over its plate — it trips' };
        var feedLost = function (d) {
            return 'Feed ' + d.lost.feed + ' is lost (' + d.lost.pdu + ', ' + upsOf(d.lost.feed) + ' or EMSB-'
                 + (d.lost.feed === 'A' ? '1' : '2') + ')';
        };
        var dirText = function (d) {
            return fmt(d.peak, 1) + ' A on ' + d.surv.pdu + ' ' + d.surv.q + ' (' + d.surv.plate + ' A), '
                 + fmt(d.pct, 1) + ' % of ' + fmt(d.surv.cont, 1) + ' A continuous — ' + WORD[d.state];
        };

        var figures = [
            ['Other cord’s breaker', pw.pdu + ' ' + pw.q + '  ·  ' + pw.plate + ' A  ·  Feed ' + pw.feed
                + ' — ' + upsOf(pw.feed)],
            ['Why these two pair', c.pair.kind === 'cabinet'
                ? 'same cabinet (' + w.rack + '), same way number and phase'
                : 'both spare, same way number and phase — a free pair'],
            ['Carrying now', w.pdu + ' ' + w.q + ': ' + phaseList(w, c.now.I) + '   |   '
                + pw.pdu + ' ' + pw.q + ': ' + phaseList(pw, pn.I)],
            ['New load, whole', fmt(p.amps, 1) + ' A ' + (p.phases === '3' ? 'per phase' : 'in one phase')],
            ['If ' + feedLost(dirs[0]), dirText(dirs[0])],
            ['If ' + feedLost(dirs[1]), dirText(dirs[1])],
            ['Room left to the 15 % level, weaker direction', roomText(worst.lim - worst.peak)],
            ['Largest dual-corded load the pair accepts', fmt(loadKw(maxA), 2) + ' kW   (' + fmt(maxA, 1) + ' A)'
                + (w.plate !== pw.plate ? ' — set by the ' + Math.min(w.plate, pw.plate) + ' A breaker' : '')]
        ];

        /* The pair may be past its limit before anything is added - G-10 is.
           Say so first, direction by direction: the new load is then not the
           cause, and no size of it fits until the existing load is dealt with. */
        var before = '';
        if (both > limS) {
            var preState = function (d) {
                return both > d.surv.plate ? 'trips' : both > d.surv.cont ? 'fail' : both > d.lim ? 'watch' : 'pass';
            };
            var VERB = { trips: 'would trip', fail: 'would run above its continuous rating',
                         watch: 'would run above its 15 % level' };
            var bad = dirs.filter(function (d) { return preState(d) !== 'pass'; });
            before = 'Before any addition, the pair already carries ' + fmt(both, 1) + ' A between its two cords. '
                   + bad.map(function (d) {
                         return 'If Feed ' + d.lost.feed + ' is lost, ' + d.surv.pdu + ' ' + d.surv.q + ' ('
                              + d.surv.plate + ' A) ' + VERB[preState(d)] + '.';
                     }).join(' ')
                   + (bad.length === 1
                       ? ' Losing Feed ' + (bad[0] === dirs[0] ? dirs[1] : dirs[0]).lost.feed + ' instead is '
                         + 'survivable, so today the cabinet is protected against one feed only.'
                       : ' Neither direction is covered today.')
                   + ' No new load fits on this pair until that is resolved. ';
        }

        var detail;
        if (worst.state === 'trips') {
            detail = before + 'Not acceptable — if ' + feedLost(worst) + ', ' + worst.surv.pdu + ' '
                   + worst.surv.q + ' would carry ' + fmt(worst.peak, 1) + ' A on ' + worst.peakPh
                   + ' phase, above its ' + worst.surv.plate + ' A plate. It trips, and the cabinet goes dark '
                   + 'on a single failure — the event the second cord exists for.';
        } else if (worst.state === 'fail') {
            detail = before + 'Not acceptable — if ' + feedLost(worst) + ', ' + worst.surv.pdu + ' '
                   + worst.surv.q + ' would carry ' + fmt(worst.peak, 1) + ' A, ' + fmt(worst.pct, 1)
                   + ' % of its continuous rating. It would hold for a while but not indefinitely, and a '
                   + 'failure is exactly when it has to hold until repair.';
        } else if (worst.state === 'watch') {
            detail = before + 'Acceptable on rating, not on spare — if ' + feedLost(worst) + ', '
                   + worst.surv.pdu + ' ' + worst.surv.q + ' would carry ' + fmt(worst.peak, 1) + ' A ('
                   + fmt(worst.pct, 1) + ' % of continuous), inside the rating but above the 15 % level. The '
                   + 'largest dual-corded load that keeps the margin both ways is ' + fmt(loadKw(maxA), 2) + ' kW.';
        } else {
            var carries = function (d) {
                return d.surv.pdu + ' ' + d.surv.q + ' (' + d.surv.plate + ' A) carries ' + fmt(d.peak, 1)
                     + ' A, ' + fmt(d.pct, 1) + ' % of its continuous rating';
            };
            detail = 'Acceptable — redundancy holds whichever feed is lost. If Feed ' + dirs[0].lost.feed
                   + ' goes, ' + carries(dirs[0]) + '; if Feed ' + dirs[1].lost.feed + ' goes, ' + carries(dirs[1])
                   + '. The 15 % margin is intact both ways.';
        }
        if (worst.state !== 'pass' && otherDir.state !== worst.state) {
            detail += ' If Feed ' + otherDir.lost.feed + ' is lost instead, ' + otherDir.surv.pdu + ' '
                    + otherDir.surv.q + ' carries it at ' + fmt(otherDir.pct, 1) + ' % of continuous — '
                    + WORD[otherDir.state] + '.';
        }

        var notes = ['In normal running each cord carries about half. The case tested here is the one that '
            + 'matters: one feed lost — a PDU, ' + upsOf(w.feed) + ' or its EMSB — and the other '
            + 'cord taking everything. It is the same failover the Cabinet Load page works out.'];
        if (basis !== 'today') notes.push('On a historical basis the two breakers’ worst readings may '
            + 'come from different dates, so adding them can only overstate the load.');
        if (c.now.assumed || pn.assumed) notes.push('A spare way with no reading is taken as empty; confirm '
            + 'both with a clamp reading.');

        return push(Object.assign({}, base, {
            verdict: state, binding: true, figures: figures, detail: detail, note: notes.join(' ')
        }));
    }

    var CHIP = { pass: ['ok', 'Passes'], fail: ['bad', 'Fails'],
                 unknown: ['warn', 'Cannot assess'], watch: ['warn', 'Caution'],
                 na: ['muted', 'Not applicable'] };

    function card(r) {
        var c = el('div', 'rule ' + r.verdict);
        var h = el('div', 'rule-head');
        h.appendChild(el('span', 'rule-id', r.id));
        h.appendChild(el('span', 'rule-title', r.title));
        var m = CHIP[r.verdict] || CHIP.unknown;
        h.appendChild(el('span', 'chip ' + m[0], m[1]));
        c.appendChild(h);
        c.appendChild(el('div', 'rule-rule', r.rule));
        c.appendChild(el('div', 'rule-clause', r.clause));

        if (r.figures) {
            /* the breaker rules carry long values; two wide columns read better than three */
            var f = el('div', 'figs' + (/^B/.test(r.id) ? ' wide' : ''));
            r.figures.forEach(function (x) {
                var row = el('div', 'fig');
                row.appendChild(el('span', '', x[0]));
                row.appendChild(el('b', '', x[1]));
                f.appendChild(row);
            });
            c.appendChild(f);
        }
        if (r.rows) {
            var t = el('div', 'ftable');
            var head = el('div', 'frow fhead');
            ['Feeder', 'Protective device', 'Cable', 'Now', 'After', 'Continuous', '%', '']
              .forEach(function (x) {
                head.appendChild(el('span', '', x));
            });
            t.appendChild(head);
            r.rows.forEach(function (x) {
                var row = el('div', 'frow ' + x.state);
                row.appendChild(el('span', 'fname', x.name));
                if (x.state === 'unknown') {
                    var s = el('span', 'fmuted', 'not recorded');
                    s.style.gridColumn = '2 / -1';
                    row.appendChild(s);
                } else {
                    /* Show the device the rating came from. Without it the
                       Continuous column reads as an unexplained number and
                       the breaker on the drawing looks absent from the
                       study - 32 A is a derated 40 A MCCB, not a 32 A one. */
                    row.appendChild(el('span', 'fmuted',
                        x.plate ? fmt(x.plate) + ' A' + (x.src ? '  ' + x.src : '') : '—'));
                    var cc = el('span', x.cableAtRisk ? 'fpct' : 'fmuted',
                                x.cable || 'not on the drawings');
                    if (x.cable && x.cableAtRisk) cc.textContent = x.cable + '  ⚠';
                    row.appendChild(cc);
                    row.appendChild(el('span', '', fmt(x.now, 1) + ' A'));
                    row.appendChild(el('span', '', fmt(x.after, 1) + ' A'));
                    row.appendChild(el('span', 'fmuted', x.cont
                        ? fmt(x.cont) + ' A' + (plateBasis === 'frame' && x.plate ? '  (×0.8)' : '')
                        : '—'));
                    row.appendChild(el('span', 'fpct', x.pct === null ? '—' : fmt(x.pct) + ' %'));
                    row.appendChild(el('span', 'fstate',
                        x.state === 'fail' ? 'over rating' : x.state === 'watch' ? 'above 87 %' : ''));
                }
                t.appendChild(row);
            });
            c.appendChild(t);
        }
        if (r.detail) c.appendChild(el('p', 'rule-detail', r.detail));
        if (r.note) c.appendChild(el('p', 'rule-note', r.note));
        return c;
    }

    var COVER_TEXT = {
        good:    ['Period well covered',
                  'The records span the requested period, so the worst recorded condition is a '
                  + 'meaningful peak.'],
        partial: ['Period only partly covered',
                  'The records cover part of the requested period. The worst condition found is '
                  + 'real, but an earlier peak outside the recorded span would not appear here.'],
        thin:    ['Not enough history to judge',
                  'There are too few readings, or they span too short a time, for a worst-case to '
                  + 'mean anything. A peak that has not been recorded cannot be found.'],
        none:    ['No history in this period',
                  'Nothing was recorded in the requested period.']
    };

    function renderCoverage() {
        var host = $('coverage');
        var tbl = $('histTable');
        host.innerHTML = ''; tbl.innerHTML = '';

        if (basis === 'today') {
            $('coverSection').hidden = true;
            return;
        }
        $('coverSection').hidden = false;

        if (histError) {
            var eb = el('div', 'cover-banner thin');
            eb.appendChild(el('b', '', 'History could not be retrieved'));
            eb.appendChild(el('span', '', 'The sheet returned "' + histError + '", so this panel '
                + 'is empty because the request failed — not because the period is empty. '
                + 'Redeploy Code.gs as a New version, then try again.'));
            host.appendChild(eb);
            return;
        }

        var c = coverage();
        var t = COVER_TEXT[c.quality] || COVER_TEXT.none;
        var b = el('div', 'cover-banner ' + c.quality);
        b.appendChild(el('b', '', t[0]));

        var line = t[1];
        if (c.dates) {
            line += '  Found ' + c.dates + ' reading date' + (c.dates === 1 ? '' : 's')
                  + ' between ' + c.first + ' and ' + c.last + ' — a span of ' + c.spanDays
                  + ' day' + (c.spanDays === 1 ? '' : 's') + ' against the ' + c.wantDays
                  + ' days requested. ' + c.rows + ' readings in total, of which '
                  + c.demandDates + ' date' + (c.demandDates === 1 ? '' : 's')
                  + ' had both incomers recorded, which is what a site demand needs.';
        }
        b.appendChild(el('span', '', line));
        host.appendChild(b);

        if (!hist || !hist.stats || !Object.keys(hist.stats).length) return;

        /* the main equipment, worst first */
        var rows = [];
        DC_CONFIG.equipment.forEach(function (e) {
            var st = hist.stats['Main|' + e.name + '|'];
            if (!st) return;
            var cont = continuousOf(e.name);
            rows.push({ name: e.name, st: st, cont: cont,
                        pct: cont ? st.max / cont * 100 : null });
        });
        rows.sort(function (x, y) { return (y.pct || 0) - (x.pct || 0); });

        var head = el('div', 'hrow hhead');
        ['Equipment', 'Max', 'p95', 'Median', 'Mean', 'Min', 'Max was'].forEach(function (h) {
            head.appendChild(el('span', '', h));
        });
        tbl.appendChild(head);

        rows.forEach(function (r) {
            var row = el('div', 'hrow');
            row.appendChild(el('span', 'fname', r.name));
            row.appendChild(el('span', 'hnum hmax', fmt(r.st.max, 1)));
            row.appendChild(el('span', 'hnum', fmt(r.st.p95, 1)));
            row.appendChild(el('span', 'hnum', fmt(r.st.med, 1)));
            row.appendChild(el('span', 'hnum', fmt(r.st.avg, 1)));
            row.appendChild(el('span', 'hnum', fmt(r.st.min, 1)));
            row.appendChild(el('span', 'fmuted', r.st.maxDate + '  (' + r.st.n + ')'));
            tbl.appendChild(row);
        });
    }

    function run() {
        var p = proposal();
        var host = $('results');
        host.innerHTML = '';
        out = [];

        /* the capacity table needs no proposal - only the readings */
        renderWayTable();

        if (!p) {
            $('verdict').className = 'verdict';
            $('verdict').innerHTML = '';
            $('verdict').appendChild(el('div', 'verdict-title', 'Enter a load to assess'));
            $('summary').innerHTML = '';
            return;
        }

        /* what was proposed */
        var sm = $('summary');
        sm.innerHTML = '';
        var lines = [
            ['Proposed load', fmt(p.kw, 1) + ' kW  ·  ' + fmt(p.kva, 1) + ' kVA  ·  ' + fmt(p.amps, 1) + ' A'
                + (p.phases === '1' ? ' in one phase' : ' per phase')],
            ['Power factor', p.pf.toFixed(2)],
            ['Load type', p.type + '  — diversity ' + (p.df * 100) + ' %'],
            ['Contribution to Maximum Demand', fmt(p.demandAmps, 1) + ' A'],
            ['Category', p.category],
            ['Connection point', p.point]
        ];
        var bw = p.way ? wayOf(p.point, p.way) : null;
        if (bw) {
            lines.push(['PDU breaker', bw.q + '  ·  ' + bw.plate + ' A  ·  ' + (bw.ph === '3' ? 'three phase' : bw.ph + ' phase')
                        + '  ·  ' + servesText(bw)]);
            lines.push(['Supply', p.cords === 'dual'
                ? 'dual-corded — half on each feed; all of it on one if a feed is lost'
                : 'single-corded — this breaker only']);
        }
        lines.forEach(function (x) {
            var d = el('div', 'fig');
            d.appendChild(el('span', '', x[0]));
            d.appendChild(el('b', '', x[1]));
            sm.appendChild(d);
        });

        renderCoverage();
        renderWayNote(p);

        /* nearest the load first: the breaker, then its partner, then the board and upstream */
        if (bw) {
            ruleBreaker(p);
            ruleRedundancy(p);
        }
        ruleIncomer(p);
        ruleTransformer(p);
        ruleGenerator(p);
        ruleUpstream(p);
        ruleUps(p);
        rulePowerFactor(p);
        ruleUpstreamMew(p);

        out.forEach(function (r) { if (r) host.appendChild(card(r)); });

        /* verdict */
        var fails = out.filter(function (r) { return r && r.verdict === 'fail'; });
        var unknowns = out.filter(function (r) { return r && r.verdict === 'unknown'; });
        var watches = out.filter(function (r) { return r && r.verdict === 'watch'; });

        var v = $('verdict');
        v.innerHTML = '';
        var kind, title, sub;
        var cov = coverage();

        /* A missing history for one item is not a reason to withhold the
           answer for every other item. Anything the data DOES support is
           assessed and stated plainly; anything it does not is named, and
           the verdict is qualified by exactly that list rather than
           replaced by a refusal. */
        /* "Not applicable" is neither a pass nor a gap: the rule does not
           bear on this connection point at all, so it must not prop up an
           acceptance and must not be counted as something left untested. */
        var assessed = out.filter(function (r) {
            return r && r.verdict !== 'unknown' && r.verdict !== 'na';
        });

        /* A6 judges the stated power factor of the proposal itself and needs
           no measurement, so it can pass on a site with no readings at all.
           An acceptance resting on nothing else would be an acceptance that
           no capacity was ever checked. */
        var INPUT_ONLY = ['A6'];
        var measured = assessed.filter(function (r) {
            return INPUT_ONLY.indexOf(r.id) < 0;
        });

        if (basis !== 'today' && histError) {
            /* Not the same thing as an empty period: the request itself did
               not complete, so nothing here has been tested against history
               at all and no acceptance may be implied from it. */
            kind = 'warn'; title = 'History could not be read';
            sub = 'The sheet returned "' + histError + '", so no historical loading was '
                + 'retrieved and nothing below has been tested against it. If the Apps Script '
                + 'was deployed before this feature was added, open Deploy \u2192 Manage '
                + 'deployments and redeploy Code.gs as a New version. Until then, assess on a '
                + 'single day and treat the result as provisional.';
            v.className = 'verdict ' + kind;
            v.appendChild(el('div', 'verdict-title', title));
            v.appendChild(el('div', 'verdict-sub', sub));
            $('scopeNote').innerHTML = '';
            renderScope();
            renderOutstanding();
            return;
        }

        if (fails.length) {
            kind = 'bad'; title = 'Reject';
            sub = fails.length + ' rule' + (fails.length === 1 ? '' : 's') + ' failed — '
                + fails.map(function (r) { return r.id; }).join(', ')
                + '. ' + fails[0].detail;
        } else if (!measured.length) {
            kind = 'warn'; title = 'No capacity check was possible';
            sub = 'Nothing on the supply path has a reading in this period, so not one capacity '
                + 'rule could be computed'
                + (assessed.length ? ' — only ' + assessed.map(function (r) { return r.id; }).join(', ')
                    + ', which judge' + (assessed.length === 1 ? 's' : '') + ' the proposal itself '
                    + 'rather than the system carrying it' : '')
                + '. This is not an acceptance. Choose a different basis, or record the currents '
                + 'first.';
        } else if (unknowns.length) {
            kind = 'warn'; title = 'Accept on the parameters assessed';
            sub = assessed.length + ' of ' + out.length + ' rules were testable and all pass'
                + (watches.length ? ' (' + watches.length + ' with a caution)' : '')
                + '. ' + unknowns.length + ' could not be tested — '
                + unknowns.map(function (r) { return r.id; }).join(', ')
                + ' — because that equipment has no recorded history in this period. '
                + 'This is a conditional acceptance: it holds for what was checked, and the '
                + 'unchecked items must be closed before connection.';
        } else {
            kind = 'ok'; title = 'Accept on the rules tested';
            sub = 'Every rule testable from recorded currents passes'
                + (watches.length ? ', with ' + watches.length + ' caution' + (watches.length === 1 ? '' : 's') : '')
                + '. Checks needing inputs the reading sheet does not hold — cable capacity, '
                + 'voltage drop, discrimination, fault level — are outside what this page '
                + 'can judge and are not covered by this result.';
        }
        v.className = 'verdict ' + kind;
        v.appendChild(el('div', 'verdict-title', title));
        v.appendChild(el('div', 'verdict-sub', sub));

        /* the span caveat now rides alongside the verdict instead of replacing it */
        var sn = $('scopeNote');
        sn.innerHTML = '';
        if (basis !== 'today' && (cov.quality === 'thin' || cov.quality === 'none') && assessed.length) {
            var n = el('div', 'cover-banner partial');
            n.appendChild(el('b', '', 'Read the worst case as a floor, not a ceiling'));
            n.appendChild(el('span', '', cov.dates
                ? 'The ' + cov.dates + ' reading date' + (cov.dates === 1 ? '' : 's')
                  + ' found span ' + cov.spanDays + ' day' + (cov.spanDays === 1 ? '' : 's')
                  + ' of the ' + cov.wantDays + ' requested. The peaks used below are real, and a '
                  + 'failure against them is real, but a higher peak may have occurred on a day '
                  + 'that was never recorded. Treat a pass as provisional.'
                : 'Nothing is recorded in this period.'));
            sn.appendChild(n);
        }

        renderScope();
        renderOutstanding();
    }

    /* An explicit statement of what the data did and did not support. The
       page should never leave the reader guessing which parameters stand
       behind a verdict. */
    function renderScope() {
        var host = $('assessedList');
        host.innerHTML = '';

        var did = out.filter(function (r) {
            return r && r.verdict !== 'unknown' && r.verdict !== 'na';
        });
        var didnt = out.filter(function (r) { return r && r.verdict === 'unknown'; });
        var na = out.filter(function (r) { return r && r.verdict === 'na'; });

        function block(label, arr, cls, mark, why) {
            if (!arr.length) return;
            host.appendChild(el('div', 'scope-head', label));
            arr.forEach(function (r) {
                var row = el('div', 'scope-row ' + cls);
                row.appendChild(el('span', 'mark', mark));
                var t = el('div', '');
                t.appendChild(el('b', '', r.id + ' \u00b7 ' + r.title));
                t.appendChild(el('div', 'rule-clause', r.clause));
                row.appendChild(t);
                row.appendChild(el('span', 'why', why(r)));
                host.appendChild(row);
            });
        }

        block('Assessed', did, 'yes', '\u2713', function (r) {
            var word = r.verdict === 'fail' ? 'Not acceptable'
                     : r.verdict === 'watch' ? 'Acceptable with a caution' : 'Acceptable';
            /* A1 already opens its detail with the same word, and "Acceptable
               - Acceptable - ..." reads like a stutter. */
            if (/^(Acceptable|Not acceptable|Rejected)\b/i.test(r.detail)) return r.detail;
            return word + ' \u2014 ' + r.detail;
        });
        block(histError ? 'Not assessed \u2014 history not retrieved'
                        : 'Not assessed \u2014 no data',
              didnt, 'no', '\u2014', function (r) {
            return r.detail;
        });
        block('Not applicable to this connection point', na, 'no', '\u00b7', function (r) {
            return r.detail;
        });

        if (didnt.length) {
            var f = el('div', 'scope-row no');
            f.appendChild(el('span', 'mark', '!'));
            var t = el('div', '');
            t.appendChild(el('b', '', 'What this means'));
            f.appendChild(t);
            f.appendChild(el('span', 'why',
                'The verdict above covers only the assessed rows. The items not assessed are '
                + 'not thereby acceptable \u2014 they are unknown, and each has to be closed by '
                + 'measurement or by calculation before the load is connected.'));
            host.appendChild(f);
        }
    }

    function renderOutstanding() {
        var os = $('outstanding');

        /* The "Outstanding before connection" section was taken off the page
           on 2026-09-09, to go back after further study. Everything below is
           left intact and simply does not run while its container is absent -
           restoring the section in additional-load.html is all that is needed
           to bring it back. */
        if (!os) return;

        os.innerHTML = '';
        /* Name the cables actually on this path. The drawings give the size
           but not the installation method, grouping or route, so the page
           states the size and stops there rather than inventing an
           ampacity. */
        var p0 = proposal();
        var onPath = [];
        if (p0) {
            (DC_SYSTEM.upstream[p0.point] || []).forEach(function (k) {
                var n = k.split('|')[1];
                var c = cableOf(n);
                if (c) onPath.push(n + ' ' + c);
            });
        }

        /* What the standards actually permit us to say. KOC publishes no
           ampacity table - cl. 8.3.2 sends the calculation to IEC 60287 and
           the manufacturer - so the only defensible statement about an
           unrated cable comes from cl. 8.3.5, and it runs one way only. */
        var over = [];
        if (p0) {
            (DC_SYSTEM.upstream[p0.point] || []).forEach(function (k) {
                var n = k.split('|')[1];
                var r = ratingOf(n), c = cableOf(n);
                if (!r || !c) return;
                var now = basisValue(k);
                if (now !== null && now + p0.amps > r) over.push(n + ' ' + c);
            });
        }

        [['Cable capacity, per IEC 60287',
          'KOC-E-008 cl. 8.3.2 — KOC publishes no ampacity table; the rating must be '
          + 'calculated per IEC 60287 for the actual installation, at 50 °C in air or 40 °C '
          + 'buried, soil resistivity ≥ 2 K·m/W, with grouping and installation method. '
          + 'cl. 8.3.5 requires the protective device to be set no higher than the cable can '
          + 'carry, so on a compliant installation each cable already carries at least its '
          + 'device rating — which is why a load inside that rating needs no separate cable '
          + 'check. That inference runs one way only. '
          + (over.length
              ? 'It does NOT cover ' + over.join('; ') + ', which this load pushes past the '
                + 'device rating and therefore past anything the cable was ever shown to '
                + 'carry. Rate these before proceeding.'
              : onPath.length
                  ? 'Nothing on this path exceeds its device rating, so the cables are '
                    + 'presumed adequate on that basis. Confirm the installed conditions '
                    + 'still match the original design — added grouping or a changed route '
                    + 'invalidates it. On this path: ' + onPath.join(';  ') + '.'
                  : 'No cable size is recorded for this path.')],
         ['Voltage drop ≤ 2.5 %', 'KOC-E-008 cl. 8.3.4(a)(iii) — needs cable size, length and route'],
         ['Cable short-circuit withstand', 'KOC-E-008 cl. 8.3.1(c),(d) — at the actual protection clearing time'],
         ['Protection discrimination', 'KOC-E-006 cl. 8.6.6 — 0.3 s selectivity interval to be preserved'],
         ['Fault level within ratings', 'KOC-E-003 Pt 1 cl. 9.4.1(c)'],
         ['Incomer ACB continuous rating', 'A1 judges the incomers against the 2133 A transformer '
            + 'FLC. The ACB-3 / ACB-4 frame size and trip settings are not on record and may be lower.'],
         ['Board incomer including spare ways', 'KOC-E-009 cl. 26.2 — needs the way schedule for the board'],
         ['Load flow and short circuit studies, KOC approved', 'KOC-E-006 cl. 8.1.1 — required for anything beyond a trivial addition']
        ].forEach(function (x) {
            var row = el('div', 'narow');
            row.appendChild(el('b', '', x[0]));
            row.appendChild(el('span', 'rule-clause', x[1]));
            os.appendChild(row);
        });

        if (basis !== 'today') {
            var c = coverage();
            if (c.quality === 'partial' || c.quality === 'good') {
                var row = el('div', 'narow');
                row.appendChild(el('b', '', 'Confirm the period covers a summer peak'));
                row.appendChild(el('span', 'rule-clause',
                    'Kuwait ambient drives the annual maximum. ' + c.dates
                    + ' reading dates from ' + c.first + ' to ' + c.last
                    + ' — check that at least one July or August is inside that span.'));
                os.appendChild(row);
            }
        }
    }

    /* ---------------------------------------------------------
       data
       --------------------------------------------------------- */

    /* ---------------------------------------------------------
       the breaker picker and the capacity table
       --------------------------------------------------------- */

    function fillWays() {
        var point = $('point').value, sel = $('way');
        var show = isPdu(point);
        $('wayWrap').hidden = !show;
        $('waySection').hidden = !show;
        if (!show) return;

        /* keep the choice when only the data changes; start fresh on another PDU */
        var keep = sel.getAttribute('data-pdu') === point ? sel.value : '';
        sel.innerHTML = '';
        var o0 = document.createElement('option');
        o0.value = '';
        o0.textContent = 'Board level — no particular breaker (PDU incomer and upstream only)';
        sel.appendChild(o0);

        var live = document.createElement('optgroup'), spare = document.createElement('optgroup');
        DC_CONFIG.pduCircuits[point].forEach(function (x) {
            var w = wayOf(point, x.c);
            var o = document.createElement('option');
            o.value = x.c;
            o.textContent = x.c + '  ·  ' + servesText(w) + '  ·  ' + w.plate + ' A  ·  '
                          + (w.ph === '3' ? 'three phase' : 'single phase ' + w.ph);
            (w.spare ? spare : live).appendChild(o);
        });
        live.label = 'Live breakers (' + live.children.length + ')';
        spare.label = 'Spare breakers (' + spare.children.length + ')';
        sel.appendChild(live);
        sel.appendChild(spare);
        sel.setAttribute('data-pdu', point);
        sel.value = keep;
    }

    /* one line under the pickers, so the choice is confirmed in words */
    function renderWayNote(p) {
        var n = $('wayNote');
        if (!n) return;
        n.textContent = '';
        if (!p || !p.way) {
            if (p && isPdu(p.point)) n.textContent = 'Choose a breaker to test the load where it actually '
                + 'connects — or pick one from the capacity table below.';
            $('cordsWrap').hidden = true;
            return;
        }
        $('cordsWrap').hidden = false;
        var w = wayOf(p.point, p.way), pr = partnerOf(w);
        n.textContent = w.pdu + ' ' + w.q + ' is a ' + w.plate + ' A ' + polesText(w) + ' on Feed ' + w.feed
            + ' (' + upsOf(w.feed) + '), '
            + (w.spare ? 'currently spare' + (servesText(w) === 'Spare' ? '' : ' ' + servesText(w).replace(/^Spare\s*/, ''))
                       : 'serving ' + w.rack) + '. '
            + (pr.way
                ? 'Its partner for a second cord is ' + pr.way.pdu + ' ' + pr.way.q + ', ' + pr.way.plate + ' A'
                  + (pr.kind === 'spare' ? ', also spare.' : ', on the same cabinet.')
                : 'It has no free partner on ' + PAIR[w.pdu] + ': ' + pr.why + '.');
    }

    function renderWayTable() {
        var point = $('point').value;
        if (!isPdu(point)) return;
        var host = $('wayTable'), strip = $('wayStrip'), key = $('wayKey');
        host.innerHTML = ''; strip.innerHTML = ''; key.innerHTML = '';
        $('wayTitle').textContent = point + ' — capacity of every breaker';

        var pf = parseFloat($('pf').value);
        if (!isFinite(pf) || pf <= 0 || pf > 1) pf = 0.9;
        var chosen = $('way').value;
        var filter = $('wayFilter').value;

        var all = DC_CONFIG.pduCircuits[point].map(function (x) { return capacityOf(wayOf(point, x.c)); });

        /* the summary strip */
        var liveN = all.filter(function (c) { return !c.way.spare; }).length;
        var unreadLive = all.filter(function (c) { return !c.way.spare && !c.now; }).length;
        var hot = all.filter(function (c) { return c.state === 'watch' || c.state === 'fail'; }).length;
        var bestSpare = all.filter(function (c) { return c.way.spare && c.free2 !== undefined; })
            .sort(function (a, b) { return kwOn(b.way, b.free2, pf) - kwOn(a.way, a.free2, pf); })[0];
        [['Live breakers', String(liveN), 'serving cabinets and sockets'],
         ['Spare breakers', String(all.length - liveN), 'free to connect to'],
         ['Above 87 % now', String(hot), hot ? 'no room on these' : 'none'],
         ['Live, not read', String(unreadLive), unreadLive ? 'cannot be assessed' : 'every live way read'],
         ['Best free spare pair', bestSpare ? fmt(kwOn(bestSpare.way, bestSpare.free2, pf), 1) + ' kW' : '—',
          bestSpare ? bestSpare.way.q + ' with ' + PAIR[point] + ' ' + bestSpare.way.q + ', dual-corded' : 'no spare pair']
        ].forEach(function (s) {
            var d = el('div', 'wstat');
            d.appendChild(el('div', 'k', s[0]));
            d.appendChild(el('div', 'v', s[1]));
            d.appendChild(el('div', 's', s[2]));
            strip.appendChild(d);
        });

        var head = el('div', 'wrow whead');
        ['Way', 'Serves', 'Breaker', 'Carrying now', 'Loading', 'Free — one cord', 'Free — dual-corded, redundant', '']
            .forEach(function (h) { head.appendChild(el('span', '', h)); });
        host.appendChild(head);

        all.forEach(function (c) {
            var w = c.way;
            if (filter === 'live' && w.spare) return;
            if (filter === 'spare' && !w.spare) return;
            var row = el('div', 'wrow' + (w.spare ? ' spare' : '') + (c.state ? ' ' + c.state : ' unread')
                                + (w.q === chosen ? ' on' : ''));
            row.setAttribute('role', 'button');
            row.tabIndex = 0;
            row.title = 'Study a load on ' + point + ' ' + w.q;

            row.appendChild(el('span', 'wq', w.q));
            row.appendChild(el('span', 'wserve', servesText(w)));
            row.appendChild(el('span', 'wnum', w.plate + ' A  ·  ' + (w.ph === '3' ? '3φ' : w.ph)));

            if (!c.now) {
                var miss = el('span', 'wsub', 'not read — cannot be assessed');
                miss.style.gridColumn = '4 / -1';
                row.appendChild(miss);
            } else {
                var nowCell = el('span', 'wnum', fmt(c.now.peak, 1) + ' A' + (c.now.assumed ? '*' : ''));
                if (c.now.assumed) nowCell.title = 'No reading; taken as 0 A because the way is spare';
                row.appendChild(nowCell);

                var lc = el('span', '');
                lc.appendChild(el('span', 'wnum', fmt(c.pct, 0) + ' % of ' + fmt(w.cont, 1) + ' A'));
                var bar = el('div', 'wbar');
                var bi = el('i'); bi.style.width = Math.min(100, c.pct / 115 * 100) + '%';
                var bt = el('span', 't'); bt.style.left = (87 / 115 * 100) + '%';
                bar.appendChild(bi); bar.appendChild(bt);
                lc.appendChild(bar);
                row.appendChild(lc);

                var f1 = el('span', '');
                f1.appendChild(el('span', 'wnum', c.free1 > 0 ? fmt(c.free1, 1) + ' A' : 'none'));
                if (c.free1 > 0) f1.appendChild(el('div', 'wsub', '≈ ' + fmt(kwOn(w, c.free1, pf), 2) + ' kW'));
                row.appendChild(f1);

                var f2 = el('span', '');
                if (c.free2 === undefined) {
                    f2.appendChild(el('span', 'wsub', c.pair && c.pair.way ? 'partner not read' : 'no free partner'));
                } else {
                    f2.appendChild(el('span', 'wnum', c.free2 > 0 ? fmt(c.free2, 1) + ' A' : 'none'));
                    f2.appendChild(el('div', 'wsub', (c.free2 > 0 ? '≈ ' + fmt(kwOn(w, c.free2, pf), 2) + ' kW, ' : '')
                        + 'with ' + PAIR[point] + ' ' + w.q));
                }
                row.appendChild(f2);

                row.appendChild(el('span', 'wtag', c.state === 'fail' ? 'over rating'
                                                   : c.state === 'watch' ? 'above 87 %' : ''));
            }

            var pick = function () {
                $('way').value = w.q;
                run();
                var r = $('results');
                if (r) r.scrollIntoView({ behavior: 'smooth', block: 'start' });
            };
            row.addEventListener('click', pick);
            row.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
            });
            host.appendChild(row);
        });

        var k = el('div', 'rule-note');
        k.style.borderTop = '0';
        k.style.marginTop = '10px';
        k.innerHTML =
            '<b>How to read this table.</b> Continuous rating is 0.8 × the breaker (KOC-E-003 cl. 11.2.2). '
          + '<b>Free — one cord</b> is the room left to 87 % of continuous, which keeps KOC’s 15 % spare, '
          + 'on the busiest phase. <b>Free — dual-corded, redundant</b> is what a new dual-corded load can add '
          + 'so that <i>either</i> breaker of the pair alone still carries the whole cabinet if a feed is lost: '
          + '87 % of the smaller breaker, less what both carry now. For IT equipment that second figure is the '
          + 'one that counts. kW are at the power factor entered above (' + pf.toFixed(2) + '), as a three-phase '
          + 'load on a 3φ way and a single-phase load on a single-phase way. '
          + (basis === 'today' ? 'Readings of ' + $('date').value + '.'
                               : 'Worst recorded in the last ' + basis + ' year' + (basis === '1' ? '' : 's')
                                 + '; on a four-pole way that worst phase is applied to all three.')
          + ' * a spare with no reading, taken as empty — confirm on site. Click a row to study a load on it.';
        key.appendChild(k);
    }

    function setBadge(msg, busy) {
        var b = $('status');
        b.innerHTML = '';
        if (busy) b.appendChild(el('span', 'spinner'));
        b.appendChild(el('span', '', msg));
    }

    function yearsAgo(n) {
        var d = new Date($('date').value || new Date().toISOString().slice(0, 10));
        d.setFullYear(d.getFullYear() - n);
        return d.toISOString().slice(0, 10);
    }

    function loadHistory() {
        hist = null; histError = null;
        var to = $('date').value;
        var from = yearsAgo(Number(basis));
        setBadge('Reading ' + basis + ' year' + (basis === '1' ? '' : 's')
               + ' of history…', true);
        return fetch(endpointUrl(), {
            method: 'POST', body: JSON.stringify({ type: 'history', from: from, to: to })
        })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (d) {
                if (!d || d.result !== 'success') throw new Error((d && d.message) || 'Unexpected response');
                hist = d;
                var c = d.cover || {};
                setBadge((c.rows || 0) + ' readings on ' + (c.dates || 0) + ' date'
                       + (c.dates === 1 ? '' : 's') + ' between ' + from + ' and ' + to);
                run();
            })
            .catch(function (e) {
                console.error('History load failed:', e);
                histError = e.message || 'unknown error';
                setBadge('Could not read history (' + histError + '). If the sheet was set up '
                       + 'before this feature, Code.gs needs redeploying as a New version.');
                run();
            });
    }

    function load() {
        var date = $('date').value;
        readings = {};
        if (!endpointUrl()) {
            setBadge('No sheet connected on this device — open the Load Reading page to connect');
            run();
            return Promise.resolve();
        }
        if (basis !== 'today') return loadHistory();
        setBadge('Reading the sheet…', true);
        return fetch(endpointUrl(), {
            method: 'POST', body: JSON.stringify({ type: 'status', date: date })
        })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (d) {
                if (!d || d.result !== 'success') throw new Error((d && d.message) || 'Unexpected response');
                readings = d.recorded || {};
                setBadge(Object.keys(readings).length + ' readings recorded for ' + date
                       + ' — the study is judged against these');
                run();
            })
            .catch(function (e) {
                console.error('Additional load study failed to load readings:', e);
                setBadge('Could not read the sheet (' + e.message + ')');
                run();
            });
    }


    /* The most recent date the sheet holds anything for. Readings are not
       taken daily, so opening on today would usually show nothing. Falls
       back to today if the sheet cannot be asked. */
    function latestDate() {
        if (!endpointUrl()) return Promise.resolve(null);
        var to = new Date();
        var from = new Date();
        from.setFullYear(from.getFullYear() - 6);
        return fetch(endpointUrl(), {
            method: 'POST',
            body: JSON.stringify({ type: 'history',
                                   from: from.toISOString().slice(0, 10),
                                   to: to.toISOString().slice(0, 10) })
        })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                return (d && d.result === 'success' && d.cover) ? d.cover.last : null;
            })
            .catch(function () { return null; });
    }

    function init() {
        $('date').value = new Date().toISOString().slice(0, 10);

        /* connection points, generator-backed ones marked */
        var sel = $('point');
        DC_CONFIG.equipment.forEach(function (e) {
            if (e.name === 'Incomer A' || e.name === 'Incomer B') return;
            var o = document.createElement('option');
            o.value = e.name;
            var g = DC_SYSTEM.backedBy[e.name];
            o.textContent = e.name + (g ? '  · backed by ' + g : '  · utility only');
            sel.appendChild(o);
        });
        sel.value = 'EMSB 2';

        try { plateBasis = localStorage.getItem(DERATE_KEY) || 'frame'; } catch (e) { plateBasis = 'frame'; }

        ['size', 'unit', 'pf', 'loadType', 'category', 'phases', 'way', 'cords', 'wayFilter'].forEach(function (id) {
            $(id).addEventListener('input', run);
            $(id).addEventListener('change', run);
        });
        /* a new connection point refills the breaker list before the study reruns */
        $('point').addEventListener('change', function () { fillWays(); run(); });
        fillWays();
        $('date').addEventListener('change', load);
        $('refresh').addEventListener('click', load);
        $('basis').addEventListener('change', function () {
            basis = $('basis').value;
            $('dateLabel').textContent = basis === 'today' ? 'on' : 'counting back from';
            load();
        });

        $('themeBtn').addEventListener('click', function () {
            var t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', t);
            try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* ignore */ }
        });
        var saved;
        try { saved = localStorage.getItem(THEME_KEY); } catch (e) { saved = null; }
        document.documentElement.setAttribute('data-theme', saved || 'dark');

        setBadge('Finding the latest reading\u2026', true);
        latestDate().then(function (d) {
            if (d) $('date').value = d;
            load();
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
