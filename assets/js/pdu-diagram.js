/* =============================================================
   KOC Data Center - PDU diagrams
   pdu-diagram.js

   Each PDU as a single line diagram: the incomer, the busbar, and
   every outgoing way with its breaker, phase and what it serves -
   drawn the way the sheets draw it, two mirrored halves either side
   of the bar.

   It is drawn from the schedules in config.js, not from the PDF, so
   it cannot drift from what the rest of the app assesses. That is
   also its limit: it shows what the transcription holds - way,
   rating, poles, phase and load - and not the things only the
   drawing carries, such as cable sizes, RCBO sensitivities and
   makes. For those, read the sheet.

   With a round chosen, each way also shows what it was carrying and
   how that sits against its continuous rating, so the board can be
   read for loading as well as for layout. The room is rebuilt for
   the date of the round, so a way that has since been re-rated or
   released is drawn as it was then.
   ============================================================= */

(function () {
    'use strict';

    var THEME_KEY  = 'koc-dc-theme';
    var LATEST_KEY = 'koc-dc-latest-date';
    var M = DC_CABINETS;

    /* the pairs, in the order the room is wired: Feed A board then its partner */
    var ORDER = ['PDU 1', 'PDU 6', 'PDU 3', 'PDU 2', 'PDU 5', 'PDU 4', 'PDU 7', 'PDU 8'];

    var shown = 'PDU 1';
    var rec = {};
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

    function equip(name) {
        return (DC_CONFIG.equipment || []).filter(function (e) { return e.name === name; })[0] || null;
    }
    function plateOf(breaker) {
        var m = String(breaker || '').match(/(\d+(?:\.\d+)?)/);
        return m ? parseFloat(m[1]) : null;
    }

    /* one way, as it stood on the round being shown */
    function wayOn(c) {
        var spare = M.spareOn(c, shownDate);
        var breaker = M.breakerOn(c, shownDate);
        var plate = plateOf(breaker);
        var r = rec['PDU|' + shown + '|' + c.c] || null;
        var phases = c.ph === '3' ? ['r', 'y', 'b'] : [String(c.ph).toLowerCase()];
        var I = null;
        if (r) {
            var vals = phases.map(function (p) {
                var v = r[p];
                return (v === '' || v === null || v === undefined || !isFinite(Number(v))) ? null : Number(v);
            });
            if (vals.some(function (v) { return v !== null; })) {
                I = Math.max.apply(null, vals.map(function (v) { return v === null ? 0 : v; }));
            }
        }
        return {
            q: c.c, ph: c.ph, breaker: breaker, plate: plate, spare: spare,
            rack: M.rackOn(c, shownDate),
            I: I,
            /* a way the schedule calls spare but the round found carrying
               current: either the schedule is behind the board, or the round
               was read against an older one. Worth seeing on the diagram. */
            odd: spare && I !== null && I > 0.05,
            state: (I === null || !plate) ? 'none' : M.levelOf(I, plate),
            pct: (I === null || !plate) ? null : I / (plate * M.CONT) * 100
        };
    }

    /* ---------------------------------------------------------
       the board
       --------------------------------------------------------- */

    function renderTabs() {
        var bar = $('pduBar');
        bar.innerHTML = '';
        ORDER.forEach(function (name) {
            var e = equip(name);
            var t = el('button', 'pdutab' + (name === shown ? ' on' : ''));
            t.type = 'button';
            t.appendChild(el('b', '', name.replace('PDU ', 'PDU-')));
            t.appendChild(el('span', '', 'Feed ' + DC_PDU_FEED[name] + '  ·  ' + (e ? e.source : '')));
            t.onclick = function () { shown = name; render(); };
            bar.appendChild(t);
        });
    }

    function renderHead() {
        var host = $('head');
        host.innerHTML = '';
        var e = equip(shown);
        var ways = DC_CONFIG.pduCircuits[shown] || [];
        var live = ways.filter(function (c) { return !M.spareOn(c, shownDate); }).length;
        var r = rec['Main|' + shown + '|'];
        var peak = null;
        if (r) {
            var v = ['r', 'y', 'b'].map(function (p) { return Number(r[p]); })
                .filter(function (x) { return isFinite(x); });
            if (v.length) peak = Math.max.apply(null, v);
        }
        var cont = e ? e.rated * M.CONT : null;

        var g = el('div', 'inc');
        var add = function (k, v) {
            var d = el('div', '');
            d.appendChild(el('div', 'k', k));
            d.appendChild(el('b', '', v));
            return g.appendChild(d);
        };
        add('Fed from', e ? e.source + (e.cableAt ? '  ·  ' + e.cableAt : '') : '—');
        add('Incomer', (e ? e.rated : '—') + ' A MCCB  ·  continuous ' + fmt(cont, 1) + ' A');
        add('Incoming cable', e && e.cable ? e.cable : 'not on file');
        add('Ways', ways.length + '  ·  ' + live + ' in service, ' + (ways.length - live) + ' spare');
        add('Incomer carrying', peak === null ? 'not read'
            : fmt(peak, 1) + ' A  ·  ' + fmt(peak / cont * 100, 1) + ' % of continuous');
        host.appendChild(g);
    }

    function wayRow(w, side) {
        var row = el('div', 'wrow ' + (w.spare ? 'spare' : '') + (w.I !== null ? ' loaded' : '')
                                     + (w.odd ? ' odd' : ''));
        var q = el('span', 'wq', w.q);
        var brk = el('span', 'wbrk', (w.plate === null ? '—' : w.plate + ' A')
            + '  ' + (w.ph === '3' ? '4P' : 'DP'));
        var ph = el('span', 'wph ph-' + w.ph, w.ph === '3' ? '3φ' : w.ph);
        var amp = el('span', 'wamp st-' + w.state, w.I === null ? '—' : fmt(w.I, 1) + ' A');
        var name = el('span', 'wname', w.rack);
        row.title = shown + ' ' + w.q + '  ·  ' + w.breaker + (w.ph === '3' ? ' four-pole' : ' two-pole, ' + w.ph + ' phase')
            + '  ·  ' + w.rack
            + (w.I === null ? '  ·  not read' + (shownDate ? ' on ' + dmy(shownDate) : '')
                            : '  ·  ' + fmt(w.I, 1) + ' A, ' + fmt(w.pct, 1) + ' % of continuous')
            + (w.odd ? '  ·  drawn spare, but this round recorded current on it' : '');
        var cells = side === 'l' ? [name, brk, ph, amp, q] : [q, amp, ph, brk, name];
        cells.forEach(function (c) { row.appendChild(c); });
        return row;
    }

    function renderBoard() {
        var host = $('board');
        host.innerHTML = '';
        var ways = (DC_CONFIG.pduCircuits[shown] || []).map(wayOn);
        var half = Math.ceil(ways.length / 2);

        /* the incomer, feeding the bar, so the page reads as a diagram
           rather than as two lists either side of a line */
        var e = equip(shown);
        var wrap = el('div', 'incwrap');
        var box = el('div', 'incbox', shown.replace('PDU ', 'PDU-') + '   ·   ' + (e ? e.rated : '?') + ' A MCCB');
        box.appendChild(el('span', '', 'from ' + (e ? e.source : '—')
            + (e && e.cableAt ? ', ' + e.cableAt : '')));
        wrap.appendChild(box);
        wrap.appendChild(el('div', 'drop'));
        host.appendChild(wrap);

        var board = el('div', 'board');
        var left = el('div', 'half l'), bus = el('div', 'bus'), right = el('div', 'half r');
        ways.slice(0, half).forEach(function (w) { left.appendChild(wayRow(w, 'l')); });
        ways.slice(half).forEach(function (w) { right.appendChild(wayRow(w, 'r')); });
        board.appendChild(left); board.appendChild(bus); board.appendChild(right);
        host.appendChild(board);

        var odd = ways.filter(function (w) { return w.odd; });
        var worst = ways.filter(function (w) { return w.state === 'critical' || w.state === 'overload'; });
        var high = ways.filter(function (w) { return w.state === 'high'; });
        var read = ways.filter(function (w) { return w.I !== null; }).length;
        var note = el('div', 'rule-note');
        note.style.marginTop = '14px';
        note.innerHTML = '<b>' + read + ' of ' + ways.length + ' ways read'
            + (shownDate ? ' on ' + dmy(shownDate) : '') + '.</b> '
            + (worst.length ? '<b style="color:var(--bad)">' + worst.length + ' above continuous rating</b> ('
                + worst.map(function (w) { return w.q; }).join(', ') + '). ' : '')
            + (high.length ? high.length + ' above the 15 % level (' + high.map(function (w) { return w.q; }).join(', ') + '). ' : '')
            + (odd.length ? '<b style="color:var(--warn)">' + odd.length + ' way'
                + (odd.length === 1 ? '' : 's') + ' drawn spare carried current</b> ('
                + odd.map(function (w) { return w.q + ' ' + fmt(w.I, 1) + ' A'; }).join(', ')
                + ') — either the schedule is behind the board, or the round was read against an older one. '
                : '')
            + 'Colour on the current is the way against its own continuous rating (0.8 × plate): '
            + '<span style="color:var(--good)">normal</span>, '
            + '<span style="color:var(--warn)">above 87 %</span>, '
            + '<span style="color:#fb923c">above continuous</span>, '
            + '<span style="color:var(--bad)">above the plate</span>.';
        host.appendChild(note);
    }

    function renderMethod() {
        $('method').innerHTML =
            '<h3>What this is drawn from</h3>' +
            '<ul><li>The schedules in <code>config.js</code> — the transcription of record, read off the PDU ' +
            'single line diagrams. The same data the Cabinet Load and Additional Load Study pages assess, so this ' +
            'page cannot drift from them.</li>' +
            '<li><b>It is not a copy of the sheet.</b> It holds the way, its rating and poles, its phase and what ' +
            'it serves. Cable sizes, RCBO sensitivities and breaker makes are on the drawing only — for those, ' +
            'read the sheet in <code>02-Drawings/PDU 1 to 8 Single Line Diagram - Current/</code>.</li>' +
            '<li>The two halves either side of the bar follow the sheet: the first half of the ways on the left, ' +
            'the second on the right, mirrored.</li></ul>' +

            '<h3>The date matters</h3>' +
            '<ul><li>Pick a round and the board is rebuilt <b>as it stood that day</b>: a way re-rated since is ' +
            'drawn with the breaker that was in it, and a way released or taken into use is drawn as it was. ' +
            'B-09’s pair reads 25 A for a round before 16-10-2026 and 32 A after it.</li>' +
            '<li>A way nobody read shows a dash, never a zero.</li></ul>' +

            '<h3>Taking it away</h3>' +
            '<ul><li><b>Print / PDF</b> prints the board on its own, on white, with a title block naming the board, ' +
            'the round and where the figures came from. Choose "Save as PDF" in the print dialog for a file. One ' +
            'board at a time, as the tabs show it.</li>' +
            '<li><b>CSV</b> downloads the same board as data — way, breaker, poles, phase, what it serves, and ' +
            'what the round recorded. <b>CSV · all 8</b> does every board in one file, 564 rows.</li>' +
            '<li>Both carry the reading date and the source, so a sheet or a file found later can still be ' +
            'placed.</li></ul>' +

            '<h3>Reading the loading</h3>' +
            '<ul><li>The current shown is the busiest phase of that way in the round. The colour is that current ' +
            'against the way’s own continuous rating, 0.8 × plate (KOC-E-003 Pt 1 cl. 11.2.2), with the 15 % ' +
            'spare level at 87 % of it (cl. 9.4.1(a)).</li>' +
            '<li>This is each way on its own. What a cabinet’s breaker would carry if its other feed is lost is ' +
            'the <a href="cabinets.html">Cabinet Load</a> page, and that is the test that usually binds.</li></ul>';
    }

    /* ---------------------------------------------------------
       taking it away: print, and the board as data

       A printed board is the thing people carry to the floor, so it
       prints without the furniture, on white, with a title block
       saying which board, which round, and where the figures came
       from - a sheet with no provenance on it is a sheet nobody can
       check later.
       --------------------------------------------------------- */

    function renderPrintHead() {
        var host = $('printHead');
        if (!host) return;
        host.innerHTML = '';
        var e = equip(shown);
        host.appendChild(el('h1', '', 'KOC Data Center  ·  ' + shown.replace('PDU ', 'PDU-')
            + '  ·  single line diagram'));
        host.appendChild(el('div', 'sub', 'Feed ' + DC_PDU_FEED[shown] + ', from ' + (e ? e.source : '—')
            + '  ·  incomer ' + (e ? e.rated : '?') + ' A MCCB'
            + '  ·  readings of ' + (shownDate ? dmy(shownDate) : 'no round loaded')));
        host.appendChild(el('div', 'prov',
            'Drawn from the circuit schedules held in the KOC Data Center electrical records app, which transcribe '
            + 'the PDU single line diagrams. Cable sizes, RCBO sensitivities and breaker makes are on the drawings '
            + 'only. Printed ' + dmy(new Date().toISOString().slice(0, 10)) + '.'));
    }

    function csvRows(name) {
        var keep = shown;
        shown = name;
        var rows = (DC_CONFIG.pduCircuits[name] || []).map(wayOn).map(function (w) {
            return [name, w.q, w.plate === null ? '' : w.plate, w.ph === '3' ? '4P' : 'DP',
                    w.ph === '3' ? 'R+Y+B' : w.ph, w.rack, w.spare ? 'spare' : 'in service',
                    w.I === null ? '' : w.I, w.pct === null ? '' : w.pct.toFixed(1),
                    w.I === null ? 'not read' : w.state, w.odd ? 'spare way carrying current' : ''];
        });
        shown = keep;
        return rows;
    }

    function download(filename, text) {
        var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    function saveCsv(all) {
        var head = ['PDU', 'Way', 'Breaker (A)', 'Poles', 'Phase', 'Serves', 'State',
                    'Current (A)', '% of continuous', 'Loading', 'Note'];
        var rows = all ? ORDER.reduce(function (acc, n) { return acc.concat(csvRows(n)); }, [])
                       : csvRows(shown);
        var esc = function (v) {
            v = (v === null || v === undefined) ? '' : String(v);
            return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
        };
        var lines = [
            ['KOC Data Center - PDU circuit schedule' + (all ? ', all eight boards' : ', ' + shown)],
            ['Readings of', shownDate ? dmy(shownDate) : 'no round loaded'],
            ['Exported', dmy(new Date().toISOString().slice(0, 10))],
            ['Source', 'circuit schedules in the electrical records app, transcribed from the PDU single line diagrams'],
            [],
            head
        ].concat(rows).map(function (r) { return r.map(esc).join(','); }).join('\r\n');
        download('KOC DC ' + (all ? 'all PDUs' : shown) + ' schedule '
            + (shownDate || 'no round') + '.csv', lines);
    }

    function render() { renderTabs(); renderPrintHead(); renderHead(); renderBoard(); renderMethod(); }

    /* ---------------------------------------------------------
       data
       --------------------------------------------------------- */

    function fillDates(list, chosen) {
        var sel = $('date');
        var dates = (list || []).slice().sort().reverse();
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
        if (!endpointUrl()) {
            setStatus('No sheet connected on this device — the boards are drawn without readings.');
            render(); return;
        }
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
                + ' — the boards are drawn as they stood that day');
            render();
        }).catch(function (e) {
            console.error('PDU diagram: readings failed', e);
            setStatus('Could not read the sheet (' + e.message + ') — the boards are drawn without readings.');
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
        $('printBtn').addEventListener('click', function () { window.print(); });
        $('csvBtn').addEventListener('click', function () { saveCsv(false); });
        $('csvAllBtn').addEventListener('click', function () { saveCsv(true); });
        /* #pdu=PDU%203 and #pdu=PDU+3 both mean PDU 3: decode before matching */
        var hash = '';
        try { hash = decodeURIComponent(location.hash || '').replace(/\+/g, ' '); } catch (e) { hash = location.hash || ''; }
        var m = /[#&]pdu=\s*(?:PDU)?\s*(\d)/i.exec(hash);
        if (m && ORDER.indexOf('PDU ' + m[1]) >= 0) shown = 'PDU ' + m[1];
        render();
        var start; try { start = localStorage.getItem(LATEST_KEY); } catch (e) { start = null; }
        load(start || new Date().toISOString().slice(0, 10), true);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
