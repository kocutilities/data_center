/* =============================================================
   KOC Data Center - cabinet changes
   cabinet-changes.js

   Which cabinets have gone out of service, which reserved positions
   have been taken into use, and what each one's ways were carrying
   the last time anybody read them.

   A decommissioned cabinet does not disappear from the room: its
   ways are redrawn as spare cabin ways, cable and socket in place,
   so the position is held. That is why this page exists separately
   from the way counts - a withdrawal changes what is connected, not
   how many ways there are.

   The register is DC_CONFIG.cabinetChanges. This page lays it out and
   adds what the chosen round recorded, and it reads the room through
   DC_CABINETS.build(date), so the load shown for a cabinet is the
   load of the round it was still in service for.
   ============================================================= */

(function () {
    'use strict';

    var THEME_KEY  = 'koc-dc-theme';
    var LATEST_KEY = 'koc-dc-latest-date';
    var M   = DC_CABINETS;
    var REG = DC_CONFIG.cabinetChanges || [];

    var rec = {};             /* readings of the date shown */
    var shownDate = null;
    var dates = [];

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
       ways and readings
       --------------------------------------------------------- */

    function way(key) {
        var p = String(key).split('|'), pdu = p[0], q = p[1];
        var c = ((DC_CONFIG.pduCircuits || {})[pdu] || []).filter(function (x) { return x.c === q; })[0] || null;
        return { key: 'PDU|' + pdu + '|' + q, pdu: pdu, q: q, entry: c, name: pdu.replace(' ', '-') + ' ' + q,
                 breaker: c ? c.breaker : '', ph: c ? c.ph : '', rack: c ? c.rack : '' };
    }

    /* what that way carried on the round shown, phase by phase */
    function currentOf(w) {
        var r = rec[w.key];
        if (!r) return null;
        var phases = w.ph === '3' ? ['r', 'y', 'b'] : [String(w.ph).toLowerCase()];
        var out = [], any = false;
        phases.forEach(function (ph) {
            var v = r[ph];
            if (v === '' || v === null || v === undefined || !isFinite(Number(v))) { out.push(null); return; }
            any = true; out.push(Number(v));
        });
        if (!any) return null;
        return { list: out, phases: phases, peak: Math.max.apply(null, out.map(function (v) { return v === null ? 0 : v; })) };
    }

    function currentText(w) {
        var c = currentOf(w);
        if (!c) return null;
        return c.phases.map(function (ph, i) {
            return ph.toUpperCase() + ' ' + (c.list[i] === null ? '—' : fmt(c.list[i], 1));
        }).join('  ·  ') + ' A';
    }

    /* every way of an entry, totalled across both feeds */
    function totalOf(e) {
        var t = 0, read = 0;
        e.ways.forEach(function (k) {
            var c = currentOf(way(k));
            if (c) { read++; c.list.forEach(function (v) { t += v || 0; }); }
        });
        return { amps: t, read: read, of: e.ways.length };
    }

    /* was the cabinet still in service on the round shown? */
    function liveThen(e) {
        return !!shownDate && (e.kind === 'out' ? shownDate < e.date : shownDate >= e.date);
    }

    /* ---------------------------------------------------------
       summary
       --------------------------------------------------------- */

    function renderTiles() {
        var host = $('tiles');
        host.innerHTML = '';
        var out = REG.filter(function (e) { return e.kind === 'out'; });
        var inn = REG.filter(function (e) { return e.kind === 'in'; });
        var ways = out.reduce(function (s, e) { return s + e.ways.length; }, 0);
        var live = M.build().cabinets.length;
        var still = out.filter(liveThen);
        var removed = still.reduce(function (s, e) { return s + totalOf(e).amps; }, 0);
        var readOf = still.reduce(function (s, e) { var t = totalOf(e); return s + t.read; }, 0);
        var waysOf = still.reduce(function (s, e) { return s + e.ways.length; }, 0);
        var loadSub = !shownDate ? 'no round loaded'
            : !still.length ? 'all of them were already out on ' + dmy(shownDate)
            : readOf === 0 ? 'none of their ways was read on ' + dmy(shownDate)
            : 'as read on ' + dmy(shownDate) + ', both feeds'
              + (readOf < waysOf ? ' — ' + readOf + ' of ' + waysOf + ' ways read' : '');

        [['In service now', live, 'dual-fed cabinets', ''],
         ['Out of service', out.length, 'positions held, not released', 't-out'],
         ['Taken into use', inn.length, inn.length === 1 ? 'a reserved position made live'
                                                         : 'reserved positions made live', 't-in'],
         ['Ways held in reserve', ways, 'cable and socket in place', 't-held'],
         ['Load withdrawn', fmt(removed, 1) + ' A', loadSub, '']
        ].forEach(function (t) {
            var d = el('div', 'tile-s ' + t[3]);
            d.appendChild(el('div', 'k', t[0]));
            d.appendChild(el('div', 'v', String(t[1])));
            d.appendChild(el('div', 's', t[2]));
            host.appendChild(d);
        });
    }

    /* ---------------------------------------------------------
       one entry
       --------------------------------------------------------- */

    function wayTable(e) {
        var t = el('div', 'rgrid');
        t.style.display = 'block';
        var head = el('div', 'wayrow head');
        ['Way', 'Breaker', 'Phase', 'Drawn now', 'On ' + (shownDate ? dmy(shownDate) : 'the round')]
            .forEach(function (h) { head.appendChild(el('span', '', h)); });
        t.appendChild(head);
        e.ways.forEach(function (k) {
            var w = way(k);
            var row = el('div', 'wayrow');
            row.appendChild(el('b', '', w.name));
            row.appendChild(el('span', '', w.breaker || '—'));
            row.appendChild(el('span', '', w.ph === '3' ? 'three' : w.ph || '—'));
            row.appendChild(el('span', 'dim', w.rack || '—'));
            var c = currentText(w);
            row.appendChild(el('span', c ? '' : 'dim', c || 'not read'));
            t.appendChild(row);
        });
        return t;
    }

    function card(e) {
        var c = el('article', 'change ' + e.kind);
        c.id = e.label;
        var head = el('div', 'ch-head');
        head.appendChild(el('span', 'ch-cab', 'Cabinet ' + e.label));
        head.appendChild(el('span', 'pill ' + e.kind, e.kind === 'out' ? 'Out of service' : 'Taken into use'));
        head.appendChild(el('span', 'ch-id', e.pair));
        head.appendChild(el('span', 'ch-since', dmy(e.date)));
        c.appendChild(head);

        var tot = totalOf(e);
        var was = liveThen(e);
        var drew = tot.read ? 'drawing ' + fmt(tot.amps, 1) + ' A across its ' + e.ways.length + ' ways'
                            : 'none of its ways read in this round';
        var line;
        if (e.kind === 'out') {
            line = (was ? 'In service on the round shown, ' + drew + '. '
                        : 'Already out of service on the round shown. ')
                 + 'Its ways are kept as spare cabin ways.';
        } else if (was) {
            line = 'In service on the round shown, ' + drew + '.';
        } else {
            /* H-12 is the case this wording exists for: the meter had it
               running before the drawing caught up, so "not in use yet"
               would contradict the figures in its own table */
            line = 'Still drawn as a reserved position on the round shown'
                 + (tot.read && tot.amps > 0
                     ? ', though its ways already carried ' + fmt(tot.amps, 1) + ' A — the meter was ahead '
                       + 'of the drawing.'
                     : '.');
        }
        c.appendChild(el('div', 'ch-title', line));

        c.appendChild(wayTable(e));

        var g = el('div', 'rgrid');
        var add = function (k, v) { g.appendChild(el('div', 'k', k)); g.appendChild(el('div', '', v)); };
        add('Reported', e.reported);
        add('Drawings', e.drawings);
        if (e.note) add('Note', e.note);
        c.appendChild(g);
        return c;
    }

    function renderList(id, kind, empty) {
        var host = $(id);
        host.innerHTML = '';
        var list = REG.filter(function (e) { return e.kind === kind; })
                      .slice()
                      .sort(function (a, b) { return b.date.localeCompare(a.date) || a.label.localeCompare(b.label); });
        if (!list.length) { host.appendChild(el('p', 'muted', empty)); return; }
        var lastDate = null;
        list.forEach(function (e) {
            if (e.date !== lastDate) {
                var h = el('div', 'ch-title');
                h.style.cssText = 'margin:18px 0 8px;font-size:13px;color:var(--text-dim)';
                var n = list.filter(function (x) { return x.date === e.date; }).length;
                h.textContent = dmy(e.date) + '  ·  ' + n + (n === 1 ? ' cabinet' : ' cabinets');
                host.appendChild(h);
                lastDate = e.date;
            }
            host.appendChild(card(e));
        });
    }

    function renderMethod() {
        var out = REG.filter(function (e) { return e.kind === 'out'; });
        var ways = out.reduce(function (s, e) { return s + e.ways.length; }, 0);
        $('method').innerHTML =
            '<h3>What counts as a change here</h3>' +
            '<ul><li><b>Out of service</b> — the cabinet was live on both feeds and is not now. Its ways stay in ' +
            'the schedules, redrawn as <b>spare cabin ways</b>: the cable is still connected and a spare industrial ' +
            'socket is still installed under the position, so the cabinet can come back without new cabling. ' +
            '<b>' + ways + ' ways</b> are held that way across ' + out.length + ' positions.</li>' +
            '<li><b>Taken into use</b> — a position that was drawn as a reserved spare cabin way and is now a live ' +
            'cabinet.</li>' +
            '<li>A cabinet that merely moved to a different breaker is not here: that is a supply change, on the ' +
            '<a href="supply-changes.html">Supply Changes</a> page.</li></ul>' +

            '<h3>The dates</h3>' +
            '<ul><li>Where the day the work was done is known, that is the date shown — the eight cabinets of ' +
            '<b>04-10-2026</b> are dated by the works, and the drawings that record them are dated 05-10-26.</li>' +
            '<li>Where it is not, the date is the day the drawing recorded it, and the entry says so. I-05 and ' +
            'H-12 are dated by the 10-09-2026 revision; A-01 was advised on 12-09-2026 and had been drawn as a ' +
            'reserved position for longer than that.</li></ul>' +

            '<h3>The load shown</h3>' +
            '<ul><li>Pick a round at the top. Each way shows what that round recorded for it, and the cabinet ' +
            'line totals the ways across both feeds — so a round taken before the change shows what the cabinet ' +
            'was actually drawing, and a round after it shows the ways idle.</li>' +
            '<li>The <b>Cabinet Load</b> page works the same way: open a round from before a withdrawal and the ' +
            'cabinet is there, struck through, counted as that round found it.</li>' +
            '<li>A way that nobody read is shown as <i>not read</i>, never as zero.</li></ul>' +

            '<h3>Adding an entry</h3>' +
            '<ul><li>The register is <code>cabinetChanges</code> in <code>assets/js/config.js</code>: the cabinet, ' +
            'its pair, its ways, the date, who reported it and which drawing shows it. The same ways carry ' +
            '<code>until</code> or <code>from</code> in the schedules, which is what lets a past round be rebuilt ' +
            'with the room as it stood.</li></ul>';
    }

    function render() { renderTiles(); renderList('out', 'out', 'No cabinet has been taken out of service.');
                        renderList('in', 'in', 'No reserved position has been taken into use.'); renderMethod(); }

    /* ---------------------------------------------------------
       data
       --------------------------------------------------------- */

    function fillDates(list, chosen) {
        var sel = $('date');
        dates = (list || []).slice().sort().reverse();
        if (dates.indexOf(chosen) === -1) dates.unshift(chosen);
        sel.innerHTML = '';
        dates.forEach(function (d) {
            var o = el('option', '', dmy(d));
            o.value = d;
            sel.appendChild(o);
        });
        sel.value = chosen;
    }

    function ask(date) {
        return fetch(endpointUrl(), { method: 'POST', body: JSON.stringify({ type: 'status', date: date }) })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (d) {
                if (!d || d.result !== 'success') throw new Error((d && d.message) || 'Unexpected reply');
                return d;
            });
    }

    function load(date, auto) {
        if (!endpointUrl()) { setStatus('No sheet connected on this device — the register is shown without readings.'); render(); return; }
        setStatus('Reading ' + dmy(date) + ' from the sheet…', true);
        ask(date).then(function (d) {
            if (auto && d.latest && d.latest !== date) {
                try { localStorage.setItem(LATEST_KEY, d.latest); } catch (e) { /* ignore */ }
                return load(d.latest, false);
            }
            rec = d.recorded || {};
            shownDate = date;
            fillDates(d.dates, date);
            setStatus(Object.keys(rec).length + ' readings recorded for ' + dmy(date)
                + ' — each way shows what that round found');
            render();
            if (location.hash) {
                var t = document.getElementById(location.hash.slice(1));
                if (t) t.scrollIntoView({ block: 'start' });
            }
        }).catch(function (e) {
            console.error('Cabinet changes: readings failed', e);
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
        $('date').addEventListener('change', function () { load($('date').value, false); });
        render();
        var start; try { start = localStorage.getItem(LATEST_KEY); } catch (e) { start = null; }
        load(start || new Date().toISOString().slice(0, 10), true);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
