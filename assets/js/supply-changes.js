/* =============================================================
   KOC Data Center - supply changes
   supply-changes.js

   Shows DC_CONFIG.supplyChanges: every cabinet not fed through its
   standard pair of breakers (the same way number on both PDUs of its
   pair). Temporary changes made on site come first, with what was
   changed, when and why, and the cabinet's supply as it stands now;
   then the departures found by comparing the drawings and readings,
   recorded for review.

   The register itself is data in config.js. This page only lays it out,
   and adds what the latest readings say about each way.
   ============================================================= */

(function () {
    'use strict';

    var THEME_KEY  = 'koc-dc-theme';
    var LATEST_KEY = 'koc-dc-latest-date';
    var M = DC_CABINETS;
    var REG = DC_CONFIG.supplyChanges || [];

    var rec = {};            /* readings of the date shown */
    var shownDate = null;

    function $(id) { return document.getElementById(id); }
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = text;
        return n;
    }
    function fmt(n, dp) {
        if (n === null || n === undefined || !isFinite(n)) return '—';
        return Number(n).toFixed(dp === undefined ? 1 : dp);
    }
    function dmy(s) {
        var p = String(s || '').split('-');
        return p.length === 3 ? p[2] + '-' + p[1] + '-' + p[0] : s;
    }
    function endpointUrl() { return (typeof DC_ENDPOINT === 'function') ? DC_ENDPOINT() : ''; }
    function setStatus(msg, busy) {
        var s = $('status');
        s.innerHTML = '';
        if (busy) s.appendChild(el('span', 'spinner'));
        s.appendChild(el('span', '', msg));
    }

    /* ---------------------------------------------------------
       ways
       --------------------------------------------------------- */

    /* 'PDU 1|Q46' -> the schedule entry, with a display name */
    function way(key) {
        var parts = String(key).split('|'), pdu = parts[0], q = parts[1];
        var c = ((DC_CONFIG.pduCircuits || {})[pdu] || []).filter(function (x) { return x.c === q; })[0] || null;
        return {
            key: key, pdu: pdu, q: q, entry: c,
            name: pdu.replace(' ', '-') + ' ' + q,
            feed: DC_PDU_FEED[pdu],
            breaker: c ? c.breaker.replace(/(\d)A/, '$1 A') + ' · ' + (c.ph === '3' ? 'three phase' : c.ph + ' phase') : '',
            phases: c ? (c.ph === '3' ? ['R', 'Y', 'B'] : [c.ph]) : []
        };
    }

    function num(v) {
        if (v === '' || v === null || v === undefined) return null;
        var n = Number(v);
        return isFinite(n) ? n : null;
    }

    /* what a way carried on the date shown, in words */
    function readingOf(w) {
        var r = rec['PDU|' + w.pdu + '|' + w.q];
        if (!r) return null;
        var vals = w.phases.map(function (p) { return { p: p, I: num(r[p.toLowerCase()]) }; });
        if (vals.some(function (v) { return v.I === null; })) return null;
        return vals.length === 1 ? fmt(vals[0].I) + ' A (' + vals[0].p + ')'
                                 : vals.map(function (v) { return v.p + ' ' + fmt(v.I); }).join(' · ') + ' A';
    }

    function readingChip(key) {
        var w = way(key), r = readingOf(w);
        var ch = el('span', 'rchip' + (r ? '' : ' nr'));
        ch.appendChild(el('b', '', w.name));
        ch.appendChild(document.createTextNode(' · ' + (r || 'not read')));
        if (w.entry) ch.title = w.entry.rack + ', ' + w.breaker;
        return ch;
    }

    function arrowIcon() {
        var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke-width', '2');
        s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
        var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', 'M5 12h14M13 6l6 6-6 6');
        s.appendChild(p);
        return s;
    }

    function fact(label, text, wide) {
        var f = el('div', 'fact' + (wide ? ' wide' : ''));
        f.appendChild(el('span', '', label));
        f.appendChild(document.createTextNode(text));
        return f;
    }

    function listOf(items) {
        var ul = el('ul', 'list');
        items.forEach(function (t) { ul.appendChild(el('li', '', t)); });
        return ul;
    }

    /* ---------------------------------------------------------
       summary
       --------------------------------------------------------- */

    function renderTiles() {
        var host = $('tiles');
        host.innerHTML = '';
        var temp = REG.filter(function (e) { return e.kind === 'temporary' && e.status === 'active'; });
        var review = REG.filter(function (e) { return e.kind === 'review'; });
        var drawing = REG.filter(function (e) { return e.kind === 'drawing'; });
        var cabs = M.build().cabinets.length;
        var named = {};
        REG.forEach(function (e) { named[e.cabinet] = 1; if (e.also) named[e.also] = 1; });
        [['Temporary changes', temp.length, 'active on site', 't-temp'],
         ['For review', review.length, 'non-standard supply found', 't-review'],
         ['Drawing issues', drawing.length, 'supply standard, drawing wrong', 't-draw'],
         ['Cabinets checked', cabs, (cabs - Object.keys(named).length) + ' standard and consistent', ''],
         ['Readings', shownDate ? dmy(shownDate) : '—', 'latest round on the sheet', '']
        ].forEach(function (t) {
            var d = el('div', 'tile-s ' + t[3]);
            d.appendChild(el('div', 'k', t[0]));
            d.appendChild(el('div', 'v', String(t[1])));
            d.appendChild(el('div', 's', t[2]));
            host.appendChild(d);
        });
    }

    /* ---------------------------------------------------------
       temporary changes
       --------------------------------------------------------- */

    function daysSince(iso) {
        var d = new Date(iso + 'T00:00:00');
        return Math.floor((Date.now() - d.getTime()) / 86400000);
    }

    function renderTemporary() {
        var host = $('temporary');
        host.innerHTML = '';
        var list = REG.filter(function (e) { return e.kind === 'temporary'; });
        if (!list.length) { host.appendChild(el('p', 'muted', 'No temporary supply changes are recorded.')); return; }

        list.forEach(function (e) {
            var card = el('article', 'change');
            card.id = e.id;

            var head = el('div', 'ch-head');
            head.appendChild(el('span', 'ch-cab', 'Cabinet ' + e.label));
            head.appendChild(el('span', 'pill temp', e.status === 'active' ? 'Temporary — active' : 'Temporary — ' + e.status));
            head.appendChild(el('span', 'ch-id', e.id));
            head.appendChild(el('span', 'ch-since', 'since ' + dmy(e.date) + ' · ' + daysSince(e.date) + ' days'));
            card.appendChild(head);

            /* original -> temporary, feed by feed */
            var swap = el('div', 'swap');
            ['', 'Original power source', '', 'Temporary power source'].forEach(function (h, i) {
                swap.appendChild(el('div', 'hd' + (i === 2 ? ' h-arrow' : i === 3 ? ' h-new' : ''), h));
            });
            e.original.forEach(function (o, i) {
                var t = e.temporary[i] || {};
                var changed = !t.unchanged;
                swap.appendChild(el('div', 'feed ' + o.feed.toLowerCase(), 'Feed ' + o.feed));
                var ow = el('div', 'way' + (changed ? ' old' : ''));
                ow.appendChild(el('b', '', way(o.way).name));
                ow.appendChild(el('div', 'd', o.detail));
                swap.appendChild(ow);
                var ar = el('div', 'arrow' + (changed ? ' on' : ''));
                ar.appendChild(arrowIcon());
                swap.appendChild(ar);
                var nw = el('div', 'way ' + (changed ? 'new' : 'same'));
                nw.appendChild(el('b', '', changed ? way(t.way).name : way(o.way).name));
                nw.appendChild(el('div', 'd', changed ? t.detail : 'unchanged'));
                swap.appendChild(nw);
            });
            card.appendChild(swap);

            var facts = el('div', 'facts');
            facts.appendChild(fact('Date of change', dmy(e.date)));
            facts.appendChild(fact('Reported', e.reported));
            facts.appendChild(fact('Reason for the change', e.reason, true));
            card.appendChild(facts);

            /* the cabinet's supply as it stands now, from the schedules */
            card.appendChild(el('div', 'sub-h', 'Current power-supply configuration'));
            var cfg = el('div', 'cfg');
            var hd = el('div', 'cfg-row hd');
            ['Feed', 'PDU', 'Way', 'Breaker', 'Pairs with', 'Reading' + (shownDate ? ', ' + dmy(shownDate) : '')]
                .forEach(function (h) { hd.appendChild(el('span', '', h)); });
            cfg.appendChild(hd);
            var tempWays = e.temporary.filter(function (t) { return !t.unchanged; }).map(function (t) { return t.way; });
            var cab = M.build().cabinets.filter(function (c) { return c.name === e.cabinet; })[0];
            if (cab) {
                cab.A.concat(cab.B).forEach(function (w) {
                    var k = w.pdu + '|' + w.q, info = way(k);
                    var row = el('div', 'cfg-row');
                    row.appendChild(el('span', '', 'Feed ' + info.feed));
                    row.appendChild(el('span', '', w.pdu.replace(' ', '-')));
                    var q = el('span', 'num' + (tempWays.indexOf(k) >= 0 ? ' tmp' : ''), w.q);
                    if (tempWays.indexOf(k) >= 0) q.title = 'temporary';
                    row.appendChild(q);
                    row.appendChild(el('span', '', info.breaker + (tempWays.indexOf(k) >= 0 ? '  · temporary' : '')));
                    var otherPdu = info.feed === 'A' ? cab.B[0].pdu : cab.A[0].pdu;
                    var partner = cab[info.feed === 'A' ? 'B' : 'A'].filter(function (x) { return x.pq === w.pq && x.ph === w.ph; })[0];
                    row.appendChild(el('span', 'muted', partner ? partner.pdu.replace(' ', '-') + ' ' + partner.q : 'no partner on ' + otherPdu));
                    row.appendChild(el('span', 'num' + (readingOf(info) ? '' : ' muted'), readingOf(info) || 'not read'));
                    cfg.appendChild(row);
                });
            }
            card.appendChild(cfg);

            /* whether it is still redundant, from the same model as Cabinet Load */
            if (cab && shownDate) {
                var r = M.analyse(cab, rec), words;
                if (r.state === 'unread' || r.state === 'incomplete') {
                    words = 'No redundancy status for ' + dmy(shownDate) + ': ' + r.unread.map(function (x) {
                        return x.pdu.replace(' ', '-') + ' ' + x.q;
                    }).join(', ') + ' not read. A reading that was not taken is not counted as 0 A.';
                } else {
                    var g = r.governing.worst;
                    words = 'Redundancy on ' + dmy(shownDate) + ': ' + { normal: 'Normal', high: 'High Load', critical: 'Critical', overload: 'Overload' }[r.state]
                          + ' — if one PDU fails, ' + g.ch.way.pdu.replace(' ', '-') + ' ' + g.ch.way.q + ' carries '
                          + fmt(g.I) + ' A, ' + fmt(g.pctCont) + ' % of its continuous rating.';
                }
                card.appendChild(el('div', 'redund', words));
            }

            if (e.notes && e.notes.length) { card.appendChild(el('div', 'sub-h', 'Notes')); card.appendChild(listOf(e.notes)); }
            if (e.drawings && e.drawings.length) { card.appendChild(el('div', 'sub-h', 'Drawings')); card.appendChild(listOf(e.drawings)); }
            if (e.actions && e.actions.length) { card.appendChild(el('div', 'sub-h', 'Follow-up')); card.appendChild(listOf(e.actions)); }

            host.appendChild(card);
        });
    }

    /* ---------------------------------------------------------
       found in review
       --------------------------------------------------------- */

    function renderReview() {
        var host = $('review');
        host.innerHTML = '';
        var list = REG.filter(function (e) { return e.kind !== 'temporary'; });
        if (!list.length) { host.appendChild(el('p', 'muted', 'Nothing found.')); return; }

        list.forEach(function (e) {
            var card = el('article', 'change ' + e.kind);
            card.id = e.id;
            var head = el('div', 'ch-head');
            head.appendChild(el('span', 'ch-cab', 'Cabinet ' + e.label));
            head.appendChild(el('span', 'pill ' + e.kind, e.category));
            head.appendChild(el('span', 'ch-id', e.id));
            head.appendChild(el('span', 'ch-since', e.status === 'for-review' ? 'open — for review' : e.status));
            card.appendChild(head);
            card.appendChild(el('div', 'ch-title', e.title));

            var g = el('div', 'rgrid');
            var add = function (k, node) { g.appendChild(el('div', 'k', k)); g.appendChild(node); };
            add('PDU schedules', el('div', '', e.schedules));
            add('Server room layout', el('div', '', e.layout));
            var chips = el('div', 'chips');
            (e.ways || []).forEach(function (k) { chips.appendChild(readingChip(k)); });
            add('Readings' + (shownDate ? ', ' + dmy(shownDate) : ''), chips);
            add('Finding', el('div', '', e.finding));
            add('Suggested action', el('div', '', e.action));
            card.appendChild(g);
            host.appendChild(card);
        });
    }

    function renderMethod() {
        var cabs = M.build().cabinets.length;
        var named = {};
        REG.forEach(function (e) { named[e.cabinet] = 1; if (e.also) named[e.also] = 1; });
        $('method').innerHTML =
            '<h3>The standard</h3>' +
            '<ul><li>Every cabinet takes one supply from an odd PDU (Feed A) and one from the even PDU it pairs with ' +
            '(Feed B), on the <b>same way number</b> — the server room layout marks each rack “P1 Q74 / P6 Q74”. ' +
            'The same number is also the same phase, which is what lets the Cabinet Load page work out exactly what ' +
            'each breaker carries when the other feed is lost.</li>' +
            '<li>A way moved by a temporary change names its partner in the schedules (<code>pairQ</code>), so the ' +
            'failover stays exact: A-12’s Feed A is PDU-1 Q46, paired with PDU-6 Q76.</li></ul>' +

            '<h3>What was compared, 15-09-2026</h3>' +
            '<ul><li><b>PDU-01 single line diagram, 15-09-26, against the 10-09-26 issue</b>, row by row for all 78 ways: ' +
            'Q46 and Q76 changed for A-12; Q19 was relettered (already spare); the title block changed. Nothing else.</li>' +
            '<li><b>Server room layout, 15-09-2026, against the 10-09-2026 issue</b> (now in 99-Archive), aligned and ' +
            'compared pixel by pixel: A-12’s box and the drawn-by name changed. Nothing else.</li>' +
            '<li><b>Every cabinet’s marks on the layout against the PDU schedules.</b> The layout draws a brown ' +
            'SPARE beside an outlet that is not in use, and that was taken into account. Of ' + cabs + ' dual-fed ' +
            'cabinets, <b>' + (cabs - Object.keys(named).length) + ' use the standard pairing and match the layout exactly</b>; ' +
            'the others are the entries on this page.</li>' +
            '<li><b>The latest readings</b> for every way named here, shown on each entry.</li></ul>' +

            '<h3>Checked and consistent — not entries</h3>' +
            '<ul><li><b>Reserved pairs named for a cabinet</b>, drawn SPARE on the layout and on both PDUs: A-01 (withdrawn ' +
            '12-09-2026), A05 Q51, C-03, C-07 Q11, E-12 Q42, F-01 Q8, G-10 Q48, H-03 Q28, H-08 Q33, H-11 Q50, H-12 Q64, ' +
            'I-05, I-06 and M-12 Q14. Planned spare capacity, not changes.</li>' +
            '<li><b>B-04 and B-06</b> each hold a spare PDU-2 outlet (Q78, Q77) — spare on the PDU-2 schedule too.</li>' +
            '<li><b>Building sockets and the RMS on PDU-1 Q63–Q75</b> are single-fed by design and are not cabinets.</li></ul>' +

            '<h3>Adding an entry</h3>' +
            '<ul><li>The register is <code>supplyChanges</code> in <code>assets/js/config.js</code>. A temporary change ' +
            'records the original and temporary way for each feed, the date, the reason and who reported it; the ' +
            'schedules are then updated to the temporary way, with <code>pairQ</code> if its number differs from the ' +
            'partner’s.</li></ul>';
    }

    function render() { renderTiles(); renderTemporary(); renderReview(); renderMethod(); }

    /* ---------------------------------------------------------
       data
       --------------------------------------------------------- */

    function ask(date) {
        return fetch(endpointUrl(), { method: 'POST', body: JSON.stringify({ type: 'status', date: date }) })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (d) {
                if (!d || d.result !== 'success') throw new Error((d && d.message) || 'Unexpected reply');
                return d;
            });
    }

    function load(date, auto) {
        if (!endpointUrl()) { setStatus('No sheet connected on this device — readings are not shown.'); render(); return; }
        setStatus('Reading the latest round from the sheet…', true);
        ask(date).then(function (d) {
            if (auto && d.latest && d.latest !== date) {
                try { localStorage.setItem(LATEST_KEY, d.latest); } catch (e) { /* ignore */ }
                return load(d.latest, false);
            }
            rec = d.recorded || {};
            shownDate = date;
            setStatus(Object.keys(rec).length + ' readings recorded for ' + dmy(date) + ' — shown against each way');
            render();
            if (location.hash) {
                var t = document.getElementById(location.hash.slice(1));
                if (t) t.scrollIntoView({ block: 'start' });
            }
        }).catch(function (e) {
            console.error('Supply changes: readings failed', e);
            setStatus('Could not read the sheet (' + e.message + ') — the register is shown without readings.');
            render();
        });
    }

    function init() {
        var saved; try { saved = localStorage.getItem(THEME_KEY); } catch (e) { saved = null; }
        document.documentElement.setAttribute('data-theme', saved || 'dark');
        $('themeBtn').addEventListener('click', function () {
            var t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', t);
            try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* ignore */ }
        });
        render();
        var start; try { start = localStorage.getItem(LATEST_KEY); } catch (e) { start = null; }
        load(start || new Date().toISOString().slice(0, 10), true);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
