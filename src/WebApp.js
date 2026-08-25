/**
 * The shareable web app. Deploy as a Web App (Execute as: me; Who has
 * access: Anyone) for one permanent URL that reflects new bookings on each
 * load. Live status (delays/gates) is intentionally absent — that needs a
 * paid feed; everything here comes from your booking emails.
 */

function doGet() {
  const model = buildModel(readFlights(), new Date());
  return HtmlService.createHtmlOutput(renderPage(model))
    .setTitle('Flug Flights')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---- model (pure) --------------------------------------------------------

function buildModel(flights, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const tripMap = {};
  flights.forEach(function (f) {
    const id = f.trip || f.confirmation || (f.flightNo + '|' + f.date);
    (tripMap[id] = tripMap[id] || []).push(f);
  });

  const trips = Object.keys(tripMap).map(function (id) {
    const segs = tripMap[id].slice().sort(cmpISO_);
    const first = segs[0], last = segs[segs.length - 1];
    const startDT = parseISO_(first.departISO);
    const endDT = parseISO_(last.arriveISO) || parseISO_(last.departISO) || startDT;

    const layovers = [];
    for (let i = 0; i < segs.length - 1; i++) {
      const a = parseISO_(segs[i].arriveISO), d = parseISO_(segs[i + 1].departISO);
      if (a && d && segs[i].dest && segs[i].dest === segs[i + 1].origin && d > a) {
        layovers.push({ mins: Math.round((d - a) / 60000), airport: segs[i].dest });
      } else {
        layovers.push(null);
      }
    }

    return {
      id: id, confirmation: first.confirmation || '', segs: segs, layovers: layovers,
      origin: first.origin, dest: last.dest,
      stops: segs.length - 1,
      stopCodes: segs.slice(0, -1).map(function (s) { return s.dest; }).filter(Boolean),
      date: first.date, depart: first.depart, arrive: last.arrive,
      dateRange: first.date + (last.date && last.date !== first.date ? ' – ' + last.date : ''),
      flightNos: segs.map(function (s) { return s.flightNo; }).filter(Boolean),
      start: dayOnly_(startDT), end: dayOnly_(endDT),
      upcoming: dayOnly_(endDT) ? dayOnly_(endDT) >= today : false,
    };
  });

  const upcoming = trips.filter(function (t) { return t.upcoming; }).sort(function (a, b) { return keyTime_(a.start) - keyTime_(b.start); });
  const past = trips.filter(function (t) { return !t.upcoming; }).sort(function (a, b) { return keyTime_(b.start) - keyTime_(a.start); });

  const year = now.getFullYear();
  const thisYearSegs = flights.filter(function (f) {
    const d = parseISO_(f.departISO);
    return d && d.getFullYear() === year;
  });
  const airports = {};
  thisYearSegs.forEach(function (f) { if (f.origin) airports[f.origin] = 1; if (f.dest) airports[f.dest] = 1; });

  let daysToNext = null;
  if (upcoming.length && upcoming[0].start) {
    daysToNext = Math.max(0, Math.round((upcoming[0].start - today) / 86400000));
  }

  // Months to draw in the calendar: any with a trip in a window around now,
  // plus the current month, capped at 4.
  const winStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const winEnd = new Date(now.getFullYear(), now.getMonth() + 4, 1);
  const monthSet = {};
  monthSet[now.getFullYear() + '-' + now.getMonth()] = true;
  trips.forEach(function (t) {
    if (t.start && t.start >= winStart && t.start < winEnd) monthSet[t.start.getFullYear() + '-' + t.start.getMonth()] = true;
  });
  const months = Object.keys(monthSet).sort(function (a, b) {
    const A = a.split('-').map(Number), B = b.split('-').map(Number);
    return A[0] !== B[0] ? A[0] - B[0] : A[1] - B[1];
  }).slice(0, 4);

  return {
    next: upcoming.length ? upcoming[0] : null,
    upcoming: upcoming, past: past.slice(0, 12),
    daysToNext: daysToNext, trips: trips, months: months, today: today,
    stats: { flights: thisYearSegs.length, trips: upcoming.length + past.length, airports: Object.keys(airports).length, upcoming: upcoming.length },
    year: year, empty: flights.length === 0,
  };
}

function parseISO_(s) { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; }
function dayOnly_(d) { return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null; }
function keyTime_(d) { return d ? d.getTime() : 8.64e15; }
function cmpISO_(a, b) { return keyTime_(parseISO_(a.departISO)) - keyTime_(parseISO_(b.departISO)); }
function fmtDur_(mins) {
  if (mins == null) return '';
  const h = Math.floor(mins / 60), m = mins % 60;
  return (h ? h + 'h' : '') + (h && m ? ' ' : '') + (m ? m + 'm' : (h ? '' : '0m'));
}

// ---- rendering (pure) ----------------------------------------------------

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPage(model) {
  const hero = model.next ? renderHero_(model, model.next) : '';
  const stats = model.empty ? '' : renderStats_(model);
  const cal = model.empty ? '' : renderCalendar_(model);
  const up = model.upcoming.slice(model.next ? 1 : 0);
  const upSection = up.length
    ? '<div class="lbl">Upcoming</div>' + up.map(function (t) { return renderTrip_(t, true); }).join('')
    : '';
  const pastSection = model.past.length
    ? '<div class="lbl">Past trips</div>' + model.past.map(function (t) { return renderTrip_(t, false); }).join('')
    : '';
  const emptyMsg = model.empty
    ? '<div class="empty">No flights yet. Once a booking confirmation lands in Gmail, it shows up here automatically.</div>'
    : '';

  return HEAD_ + '<div class="shell">' +
    '<header class="topbar"><div class="brand"><span class="glyph">✈</span><span>Flug<small>flights</small></span></div></header>' +
    emptyMsg + hero + stats + cal + upSection + pastSection +
    '<footer class="foot">Updates automatically from your booking emails. Times are each airport’s local time. ' +
    'Live status isn’t tracked — schedule only.</footer></div>' + FOOT_;
}

function renderHero_(model, t) {
  const cd = model.daysToNext === 0 ? 'Today' : model.daysToNext === 1 ? 'Tomorrow'
    : model.daysToNext != null ? 'In ' + model.daysToNext + ' days' : '';
  const stop = t.stops > 0
    ? '<span class="stop mono">' + t.stops + ' STOP' + (t.stops > 1 ? 'S' : '') + (t.stopCodes.length ? ' · ' + esc_(t.stopCodes.join(' · ')) : '') + '</span>'
    : '<span class="stop mono">NONSTOP</span>';
  const fnos = t.flightNos.map(function (f) { return '<span class="fchip mono">' + esc_(f) + '</span>'; }).join('');
  return '<div class="lbl">Next flight' + (cd ? ' · ' + esc_(cd.toLowerCase()) : '') + '</div>' +
  '<section class="pass"><div class="pass-top">' +
    '<div class="pass-eyebrow"><span>' + esc_(String(t.date || '').toUpperCase()) + '</span>' +
      (t.confirmation ? '<span class="countdown mono">CONF&nbsp;' + esc_(t.confirmation) + '</span>' : '') + '</div>' +
    '<div class="route">' +
      '<div class="port"><div class="code mono">' + esc_(t.origin || '–') + '</div></div>' +
      '<div class="arc" aria-hidden="true"><svg viewBox="0 0 92 46" fill="none">' +
        '<path d="M4 40 C 30 2, 62 2, 88 40" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 4" opacity=".8"/>' +
        '<circle cx="46" cy="9.4" r="2.6" fill="currentColor"/></svg>' + stop + '</div>' +
      '<div class="port"><div class="code mono">' + esc_(t.dest || '–') + '</div></div></div>' +
    '<div class="pass-times">' +
      '<div class="t"><div class="clock mono">' + esc_(t.depart || '–') + '</div><div class="sub">Depart ' + esc_(t.origin) + '</div></div>' +
      '<div class="t r"><div class="clock mono">' + esc_(t.arrive || '–') + '</div><div class="sub">Arrive ' + esc_(t.dest) + '</div></div></div>' +
    '</div><div class="perf" aria-hidden="true"></div>' +
    '<div class="pass-bot"><div class="flightnos">' + fnos + '</div>' +
      '<span class="status ok"><span class="dot"></span>Scheduled</span></div></section>';
}

function renderStats_(model) {
  const s = model.stats;
  function tile(n, k) { return '<div class="stat"><div class="n mono">' + esc_(n) + '</div><div class="k">' + esc_(k) + '</div></div>'; }
  return '<div class="lbl">' + model.year + ' so far</div><section class="stats">' +
    tile(s.flights, 'Flights') + tile(s.airports, 'Airports') + tile(s.trips, 'Trips') + tile(s.upcoming, 'Upcoming') + '</section>';
}

function renderTrip_(t, open) {
  const meta = esc_(t.dateRange) + ' · ' + (t.stops > 0 ? t.stops + ' stop' + (t.stops > 1 ? 's' : '') : 'Nonstop');
  let body = '';
  t.segs.forEach(function (s, i) {
    body += renderSegDetail_(s);
    const lay = t.layovers[i];
    if (lay) body += '<div class="layover">Layover ' + esc_(fmtDur_(lay.mins)) + ' · ' + esc_(lay.airport) + '</div>';
  });
  return '<details class="trip"' + (open ? ' open' : '') + '>' +
    '<summary class="trip-sum"><div class="ts-main"><span class="where">' + esc_(t.origin) + ' → ' + esc_(t.dest) + '</span>' +
      '<span class="ts-meta">' + meta + '</span></div>' +
      (t.confirmation ? '<span class="ts-conf mono">' + esc_(t.confirmation) + '</span>' : '') +
      '<span class="chev" aria-hidden="true">›</span></summary>' +
    '<div class="trip-body">' + body + '</div></details>';
}

function renderSegDetail_(s) {
  const metaBits = [s.airline, s.cabin, s.seat ? 'Seat ' + s.seat : '', s.aircraft].filter(function (x) { return x; }).map(esc_).join(' · ');
  return '<div class="segd">' +
    '<div class="segd-row">' +
      '<div class="pt"><div class="c mono">' + esc_(s.origin || '–') + '</div><div class="tm mono">' + esc_(s.depart || '') + '</div>' +
        (s.depTerminal ? '<div class="term">Term ' + esc_(s.depTerminal) + '</div>' : '') + '</div>' +
      '<div class="pmid"><div class="fn mono">' + esc_(s.flightNo || '') + '</div>' +
        '<div class="pline"></div>' + (s.duration ? '<div class="dur mono">' + esc_(s.duration) + '</div>' : '') + '</div>' +
      '<div class="pt r"><div class="c mono">' + esc_(s.dest || '–') + '</div><div class="tm mono">' + esc_(s.arrive || '') + '</div>' +
        (s.arrTerminal ? '<div class="term">Term ' + esc_(s.arrTerminal) + '</div>' : '') + '</div>' +
    '</div>' + (metaBits ? '<div class="segd-meta">' + metaBits + '</div>' : '') + '</div>';
}

function renderCalendar_(model) {
  const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const today = model.today;

  const grids = model.months.map(function (key) {
    const parts = key.split('-'); const y = +parts[0], m = +parts[1];
    const first = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    let cells = '';
    for (let i = 0; i < first; i++) cells += '<div class="cell mut"></div>';
    for (let d = 1; d <= days; d++) {
      const date = new Date(y, m, d);
      let covered = false, isStart = false, isEnd = false;
      model.trips.forEach(function (t) {
        if (t.start && t.end && date >= t.start && date <= t.end) {
          covered = true;
          if (date.getTime() === t.start.getTime()) isStart = true;
          if (date.getTime() === t.end.getTime()) isEnd = true;
        }
      });
      let cls = 'cell';
      if (covered) { cls += ' span'; if (isStart) cls += ' span-start'; if (isEnd) cls += ' span-end'; }
      if (date.getTime() === today.getTime()) cls += ' today';
      cells += '<div class="' + cls + '"><span>' + d + '</span></div>';
    }
    return '<div class="cal"><div class="cal-head"><span class="m">' + MON[m] + ' ' + y + '</span></div>' +
      '<div class="grid">' + DOW.map(function (x) { return '<div class="dow">' + x + '</div>'; }).join('') + cells + '</div></div>';
  }).join('');

  return '<div class="lbl">Calendar</div><section class="cals">' + grids + '</section>';
}

// ---- styles / document shell ---------------------------------------------

var HEAD_ =
'<link rel="preconnect" href="https://fonts.googleapis.com">' +
'<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
'<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+Condensed:wght@600;700&display=swap">' +
'<style>' +
':root{--bg:#e9edf3;--surface:#fff;--surface-2:#f3f6fb;--ink:#0f1826;--ink-2:#53627a;--ink-3:#8492a6;--line:#dde4ee;--accent:#b06a12;--accent-bg:#f3e4cd;--accent-ink:#6b3f08;--good:#1e895a;--shadow:0 1px 2px rgba(16,24,38,.06),0 8px 24px rgba(16,24,38,.06)}' +
'@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0a0e15;--surface:#131a25;--surface-2:#1a2432;--ink:#e9eff8;--ink-2:#9cafc7;--ink-3:#63748c;--line:#253143;--accent:#f4b24c;--accent-bg:#33270f;--accent-ink:#f4b24c;--good:#48c58b;--shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.35)}}' +
'*{box-sizing:border-box}' +
'body{margin:0;background:var(--bg);color:var(--ink);font-family:"IBM Plex Sans",system-ui,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}' +
'.mono{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}' +
'.shell{max-width:460px;margin:0 auto;padding:0 16px 48px}' +
'.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;padding:14px 2px 12px;background:linear-gradient(var(--bg) 72%,transparent)}' +
'.brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:17px}' +
'.brand .glyph{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:var(--accent);color:#fff;font-size:15px}' +
'.brand small{color:var(--ink-3);font-weight:500;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-left:2px}' +
'.lbl{margin:26px 2px 11px;font-size:11px;letter-spacing:.13em;text-transform:uppercase;font-weight:600;color:var(--ink-3)}' +
'.empty{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:22px;color:var(--ink-2);box-shadow:var(--shadow);margin-top:8px}' +
'.pass{position:relative;border-radius:20px;overflow:hidden;background:radial-gradient(130% 100% at 82% -12%,rgba(244,178,76,.5),transparent 52%),linear-gradient(158deg,#1b2a45 0%,#26364f 44%,#8a5a25 100%);color:#f7f3ec;box-shadow:var(--shadow)}' +
'.pass-top{padding:18px 20px 20px}' +
'.pass-eyebrow{display:flex;align-items:center;justify-content:space-between;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:rgba(247,243,236,.72)}' +
'.countdown{background:rgba(255,255,255,.16);padding:3px 9px;border-radius:999px;color:#fff;font-weight:600}' +
'.route{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:6px;margin:16px 0 4px}' +
'.port{text-align:center}.port .code{font-family:"IBM Plex Sans Condensed","IBM Plex Sans",sans-serif;font-weight:700;font-size:50px;line-height:.9}' +
'.arc{position:relative;height:46px;width:92px;color:rgba(247,243,236,.85)}.arc svg{width:100%;height:100%;overflow:visible}' +
'.arc .stop{position:absolute;top:100%;left:50%;transform:translate(-50%,2px);font-size:10px;letter-spacing:.09em;color:rgba(247,243,236,.62);white-space:nowrap}' +
'.pass-times{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:18px}.pass-times .r{text-align:right}' +
'.pass-times .clock{font-size:21px;font-weight:600}.pass-times .sub{font-size:11px;color:rgba(247,243,236,.7)}' +
'.perf{position:relative;height:0;border-top:2px dashed rgba(247,243,236,.35);margin:4px 0}' +
'.perf::before,.perf::after{content:"";position:absolute;top:-11px;width:22px;height:22px;border-radius:50%;background:var(--bg)}' +
'.perf::before{left:-31px}.perf::after{right:-31px}' +
'.pass-bot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px 18px}' +
'.flightnos{display:flex;gap:6px;flex-wrap:wrap}.fchip{font-size:12px;font-weight:500;padding:4px 8px;border-radius:7px;background:rgba(255,255,255,.14);color:#fff}' +
'.status{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:12.5px;color:#b7f4d6}.status .dot{width:8px;height:8px;border-radius:50%;background:#46e29a;box-shadow:0 0 0 3px rgba(70,197,139,.25)}' +
'.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}' +
'.stat{background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:12px 10px;box-shadow:var(--shadow)}' +
'.stat .n{font-family:"IBM Plex Sans Condensed","IBM Plex Sans",sans-serif;font-weight:700;font-size:21px;line-height:1}' +
'.stat .k{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);margin-top:6px}' +
/* calendar */
'.cals{display:flex;flex-direction:column;gap:12px}' +
'.cal{background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:14px 15px 16px}' +
'.cal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.cal-head .m{font-weight:600;font-size:14px}' +
'.grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px 0}' +
'.dow{font-size:10px;color:var(--ink-3);text-align:center;padding-bottom:6px}' +
'.cell{position:relative;aspect-ratio:1;display:grid;place-items:center;font-size:12.5px;color:var(--ink-2)}' +
'.cell.mut{color:transparent}' +
'.cell.span{background:var(--accent-bg);color:var(--accent-ink);font-weight:600}' +
'.cell.span-start{border-top-left-radius:999px;border-bottom-left-radius:999px}' +
'.cell.span-end{border-top-right-radius:999px;border-bottom-right-radius:999px}' +
'.cell.today span{outline:2px solid var(--accent);outline-offset:2px;border-radius:50%}' +
/* trip cards (expandable) */
'.trip{background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);overflow:hidden;margin-bottom:12px}' +
'.trip-sum{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;padding:14px 15px}' +
'.trip-sum::-webkit-details-marker{display:none}' +
'.ts-main{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}' +
'.ts-main .where{font-weight:600;font-size:15px}.ts-meta{font-size:12px;color:var(--ink-2)}' +
'.ts-conf{font-size:11px;color:var(--ink-3);background:var(--surface-2);padding:3px 7px;border-radius:6px}' +
'.chev{color:var(--ink-3);font-size:20px;transition:transform .18s ease;line-height:1}' +
'details[open] .chev{transform:rotate(90deg)}' +
'.trip-body{padding:2px 15px 14px;border-top:1px solid var(--line)}' +
'.segd{padding:12px 0}.segd+.segd{border-top:1px dashed var(--line)}' +
'.segd-row{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px}' +
'.pt .c{font-weight:700;font-size:20px;letter-spacing:.02em}.pt.r{text-align:right}.pt .tm{font-size:12.5px;color:var(--ink-2);margin-top:2px}.pt .term{font-size:10.5px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.04em;margin-top:2px}' +
'.pmid{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:74px}.pmid .fn{font-size:11.5px;color:var(--ink-2);font-weight:500}.pmid .pline{height:2px;width:100%;background:repeating-linear-gradient(90deg,var(--line) 0 4px,transparent 4px 7px)}.pmid .dur{font-size:10.5px;color:var(--ink-3)}' +
'.segd-meta{margin-top:8px;font-size:12px;color:var(--ink-2)}' +
'.layover{margin:0 0 0 auto;text-align:center;font-size:11.5px;color:var(--accent-ink);background:var(--accent-bg);border-radius:999px;padding:4px 10px;width:fit-content}' +
'.foot{margin-top:26px;padding:14px 4px 0;border-top:1px solid var(--line);color:var(--ink-3);font-size:12px;line-height:1.55}' +
'</style>';

var FOOT_ = '';
