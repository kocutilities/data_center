/* =============================================================
   load-study.js

   Several load requests at once: what each one puts on each way,
   normally and when a feed is lost, and the totals that the rules
   upstream of the breaker are judged against.

   Why this exists. One request at a time answers the wrong question
   when two arrive in the same week for the same pair of ways: each
   fits, and together they do not. Everything here works on the SUM,
   and keeps each request's own share so the report can say which one
   pushed a breaker over.

   How a request is shared out
     A request names the ways it connects to - one for a single cord,
     two for a dual-corded cabinet, four for the C-09 pattern (two
     sockets from each PDU, on two phases). The load is divided
     equally between them, which is what a cabinet with one PSU per
     socket does.

     If a feed is lost, the ways on the other feed carry the whole
     request between them: the same current, over fewer ways. With
     four ways, two a side, each survivor carries twice its normal
     share. With every way on one feed, nothing survives - the load
     goes dark, which is a redundancy answer, not a capacity one.

   Currents. `amps` is the current in the phase the load sits on: for
   a three-phase load the per-phase current, for a single-phase load
   the whole of it in one phase. Shares are in the same terms, so a
   share can be added straight onto a phase of a way.

   No DOM, no readings: this module divides a proposal up, and the
   page adds the result to what the breakers are carrying.
   ============================================================= */
'use strict';

var DC_LOADSTUDY = (function () {

    var V = DC_SYSTEM.systemVoltage;
    var SQRT3 = Math.sqrt(3);
    var V_PH = V / SQRT3;

    function feedOf(pdu) { return (typeof DC_PDU_FEED !== 'undefined' ? DC_PDU_FEED[pdu] : null) || null; }
    function keyOf(w) { return 'PDU|' + w.pdu + '|' + w.q; }

    /* ---------------------------------------------------------
       one request, in electrical terms
       --------------------------------------------------------- */

    /* raw: { name, size, unit 'kw'|'kva'|'a', pf, phases '1'|'3',
              type 'continuous'|'intermittent'|'standby', category,
              point, ways: [{pdu, q}] }                              */
    function normalise(raw) {
        var val = parseFloat(raw.size);
        if (!isFinite(val) || val <= 0) return null;
        var pf = parseFloat(raw.pf);
        if (!isFinite(pf) || pf <= 0 || pf > 1) pf = 0.9;

        var single = String(raw.phases) === '1';
        var perPhase = function (kva) { return single ? kva * 1000 / V_PH : kva * 1000 / (SQRT3 * V); };

        var kva, kw, amps;
        if (raw.unit === 'kw') { kw = val; kva = kw / pf; amps = perPhase(kva); }
        else if (raw.unit === 'kva') { kva = val; kw = kva * pf; amps = perPhase(kva); }
        else { amps = val; kva = single ? V_PH * amps / 1000 : SQRT3 * V * amps / 1000; kw = kva * pf; }

        var df = KOC.diversity[raw.type];
        var ways = (raw.ways || []).map(function (w) {
            return { pdu: w.pdu, q: w.q, feed: feedOf(w.pdu), key: keyOf(w) };
        });

        return {
            id: raw.id, name: raw.name || '', point: raw.point,
            kw: kw, kva: kva, amps: amps, pf: pf,
            phases: single ? '1' : '3',
            type: raw.type, df: df, demandAmps: amps * df,
            category: raw.category,
            ways: ways,
            feeds: ways.reduce(function (s, w) { if (s.indexOf(w.feed) < 0) s.push(w.feed); return s; }, []),
            raw: raw
        };
    }

    /* ---------------------------------------------------------
       how one request divides between its ways
       --------------------------------------------------------- */

    /* Share on each way in normal running, and with either feed lost.
       Returned per way key: { normal, lossA, lossB } in amps, where
       lossA is what this way carries when FEED A is the feed lost. */
    function sharesOf(req) {
        var out = {}, n = req.ways.length;
        if (!n) return out;
        var survivors = function (lost) {
            return req.ways.filter(function (w) { return w.feed !== lost; });
        };
        var sA = survivors('A'), sB = survivors('B');
        req.ways.forEach(function (w) {
            out[w.key] = {
                normal: req.amps / n,
                lossA: w.feed === 'A' ? 0 : (sA.length ? req.amps / sA.length : 0),
                lossB: w.feed === 'B' ? 0 : (sB.length ? req.amps / sB.length : 0)
            };
        });
        return out;
    }

    /* Is this request held up if a feed is lost? */
    function redundancyOf(req) {
        var a = req.ways.filter(function (w) { return w.feed === 'A'; }).length;
        var b = req.ways.filter(function (w) { return w.feed === 'B'; }).length;
        return { onA: a, onB: b,
                 dual: a > 0 && b > 0,
                 dark: a === 0 || b === 0 ? (a ? 'B' : 'A') : null };
    }

    /* ---------------------------------------------------------
       all the requests together
       --------------------------------------------------------- */

    /* byWay[key] = { way, items: [{ req, normal, lossA, lossB }],
                      normal, lossA, lossB }            totals in amps
       byPoint[point] = a combined proposal for the rules above the
                        breaker: currents summed, demand summed, the
                        strictest category, the weighted power factor.
       totals = { kw, kva, amps, demandAmps, requests, ways }         */
    function aggregate(reqs) {
        var byWay = {}, byPoint = {}, totals = { kw: 0, kva: 0, amps: 0, demandAmps: 0, requests: reqs.length, ways: 0 };
        var RANK = { critical: 3, essential: 2, 'non-essential': 1 };

        reqs.forEach(function (req) {
            var sh = sharesOf(req);
            req.ways.forEach(function (w) {
                var b = byWay[w.key] || (byWay[w.key] = { way: w, items: [], normal: 0, lossA: 0, lossB: 0 });
                var s = sh[w.key];
                b.items.push({ req: req, normal: s.normal, lossA: s.lossA, lossB: s.lossB });
                b.normal += s.normal; b.lossA += s.lossA; b.lossB += s.lossB;
            });

            /* Which chains carry this request: every PDU it has a way on,
               and the picked point when it names no way at all. The WHOLE
               request is applied to each of them, not its share - that is
               the case the feeders have to survive, one feed lost and the
               other carrying all of it, and it is how this page has always
               judged a dual-corded load. */
            var chains = req.ways.map(function (w) { return w.pdu; })
                            .filter(function (v, i, a) { return a.indexOf(v) === i; });
            if (!chains.length && req.point) chains = [req.point];
            chains.forEach(function (pt) {
                var p = byPoint[pt] || (byPoint[pt] = {
                    point: pt, kw: 0, kva: 0, amps: 0, demandAmps: 0,
                    pfNum: 0, category: 'non-essential', phases: req.phases, type: req.type,
                    requests: [], mixedPhases: false, mixedType: false
                });
                p.kw += req.kw; p.kva += req.kva; p.amps += req.amps; p.demandAmps += req.demandAmps;
                p.pfNum += req.kva * req.pf;
                if (RANK[req.category] > RANK[p.category]) p.category = req.category;
                if (p.phases !== req.phases) p.mixedPhases = true;
                if (p.type !== req.type) p.mixedType = true;
                p.requests.push(req);
            });

            totals.kw += req.kw; totals.kva += req.kva; totals.amps += req.amps;
            totals.demandAmps += req.demandAmps;
        });

        Object.keys(byPoint).forEach(function (k) {
            var p = byPoint[k];
            p.pf = p.kva ? p.pfNum / p.kva : 0.9;
            p.df = p.amps ? p.demandAmps / p.amps : 1;
            /* a mixed set is reported as its own worst case: any single-phase
               request means the current can land in one phase */
            p.phases = p.requests.some(function (r) { return r.phases === '1'; }) ? '1' : '3';
        });
        totals.ways = Object.keys(byWay).length;
        totals.allAmps = totals.amps;
        return { byWay: byWay, byPoint: byPoint, totals: totals };
    }

    /* Every pair of ways the aggregate touches, as {a, b} way keys, so
       the redundancy rule is run once per pair and not twice. */
    function pairsOf(agg, partnerFn) {
        var seen = {}, pairs = [];
        Object.keys(agg.byWay).forEach(function (k) {
            if (seen[k]) return;
            var w = agg.byWay[k].way;
            var pr = partnerFn(w);
            var otherKey = pr && pr.way ? 'PDU|' + pr.way.pdu + '|' + pr.way.q : null;
            seen[k] = 1; if (otherKey) seen[otherKey] = 1;
            pairs.push({ key: k, otherKey: otherKey, way: w, partner: pr });
        });
        return pairs;
    }

    return {
        normalise: normalise,
        sharesOf: sharesOf,
        redundancyOf: redundancyOf,
        aggregate: aggregate,
        pairsOf: pairsOf,
        keyOf: keyOf
    };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DC_LOADSTUDY;
