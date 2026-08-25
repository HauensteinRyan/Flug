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

  const LAYOVER_MAX = 360; // minutes; a longer gap is a stay, not a connection
  const trips = Object.keys(tripMap).map(function (id) {
    const segs = tripMap[id].slice().sort(cmpISO_);
    const first = segs[0], last = segs[segs.length - 1];
    const startDT = parseISO_(first.departISO);
    const endDT = parseISO_(last.arriveISO) || parseISO_(last.departISO) || startDT;

    // Gap between consecutive segments: short = layover (connection),
    // long = a stay at that airport. The longest stay is the destination.
    const gaps = [];
    let turnIdx = segs.length - 1, maxStay = -1, primaryDest = last.dest;
    for (let i = 0; i < segs.length - 1; i++) {
      const a = parseISO_(segs[i].arriveISO), d = parseISO_(segs[i + 1].departISO);
      const mins = (a && d && d > a) ? Math.round((d - a) / 60000) : null;
      const layover = mins != null && mins < LAYOVER_MAX && segs[i].dest === segs[i + 1].origin;
      gaps.push({ mins: mins, airport: segs[i].dest, layover: layover });
      if (!layover && mins != null && mins > maxStay) { maxStay = mins; primaryDest = segs[i].dest; turnIdx = i; }
    }

    const returnsHome = last.dest && first.origin && last.dest === first.origin;
    const headline = returnsHome ? first.origin + ' ⇄ ' + primaryDest : first.origin + ' → ' + last.dest;

    // Outbound sub-journey (start → primary destination) drives the hero.
    const ob = segs.slice(0, turnIdx + 1);
    const hero = {
      origin: ob[0].origin, dest: ob[ob.length - 1].dest,
      depart: ob[0].depart, arrive: ob[ob.length - 1].arrive,
      flightNos: ob.map(function (s) { return s.flightNo; }).filter(Boolean),
      stops: ob.length - 1,
      stopCodes: ob.slice(0, -1).map(function (s) { return s.dest; }).filter(Boolean),
      date: first.date, confirmation: first.confirmation || '',
    };

    return {
      id: id, confirmation: first.confirmation || '', segs: segs, gaps: gaps,
      headline: headline, hero: hero,
      origin: first.origin, dest: last.dest,
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

  // The hero is the next actual flight: the soonest segment not yet departed
  // (kept for 6h after takeoff so an in-progress flight still shows).
  const nowT = now.getTime();
  const allSegs = flights.filter(function (f) { return f.departISO; }).slice().sort(cmpISO_);
  let nextSeg = null;
  for (let i = 0; i < allSegs.length; i++) {
    const d = parseISO_(allSegs[i].departISO);
    if (d && d.getTime() >= nowT - 6 * 3600000) { nextSeg = allSegs[i]; break; }
  }
  let daysToNext = null;
  if (nextSeg) {
    const d = dayOnly_(parseISO_(nextSeg.departISO));
    if (d) daysToNext = Math.max(0, Math.round((d - today) / 86400000));
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

  // Map data: undirected routes between airports we have coordinates for,
  // with how many times each was flown and in which years.
  const coords = (typeof AIRPORT_COORDS !== 'undefined') ? AIRPORT_COORDS : {};
  const used = {}, routeMap = {}, yearSet = {};
  flights.forEach(function (f) {
    const o = f.origin, d = f.dest;
    if (!o || !d || !coords[o] || !coords[d] || o === d) return;
    const dt = parseISO_(f.departISO);
    const yr = dt ? dt.getFullYear() : null;
    if (yr) yearSet[yr] = 1;
    used[o] = 1; used[d] = 1;
    const pair = [o, d].sort();
    const key = pair.join('|');
    const r = routeMap[key] || (routeMap[key] = { o: pair[0], d: pair[1], n: 0, years: [] });
    r.n++;
    if (yr && r.years.indexOf(yr) < 0) r.years.push(yr);
  });
  const mapAirports = {};
  Object.keys(used).forEach(function (c) { mapAirports[c] = coords[c]; });
  const mapData = {
    airports: mapAirports,
    routes: Object.keys(routeMap).map(function (k) { return routeMap[k]; }),
    years: Object.keys(yearSet).map(Number).sort(function (a, b) { return b - a; }),
  };

  return {
    next: upcoming.length ? upcoming[0] : null,
    nextSeg: nextSeg,
    upcoming: upcoming, past: past.slice(0, 12),
    daysToNext: daysToNext, trips: trips, months: months, today: today,
    mapData: mapData,
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
function fmtStay_(mins) {
  if (mins == null) return '';
  const days = Math.floor(mins / 1440);
  if (days >= 1) return days + ' day' + (days > 1 ? 's' : '');
  return Math.max(1, Math.round(mins / 60)) + 'h';
}

// Live status -> {label, cls}. Returns null when no live data yet.
function statusInfo_(seg) {
  if (!seg) return null;
  const s = String(seg.liveStatus || '').toLowerCase();
  let delay = parseInt(seg.delayMin, 10);
  if (isNaN(delay)) delay = null;
  if (!s) return null;
  if (s.indexOf('cancel') >= 0) return { label: 'Cancelled', cls: 'crit' };
  if (s.indexOf('divert') >= 0) return { label: 'Diverted', cls: 'crit' };
  if (s.indexOf('arriv') >= 0 || s.indexOf('landed') >= 0) return { label: 'Landed', cls: 'muted' };
  if (s.indexOf('board') >= 0 || s.indexOf('gateclosed') >= 0) return { label: 'Boarding', cls: 'accent' };
  if (s.indexOf('enroute') >= 0 || s.indexOf('departed') >= 0 || s.indexOf('approach') >= 0) return { label: 'In air', cls: 'accent' };
  if (s.indexOf('delay') >= 0 || (delay != null && delay >= 15)) return { label: 'Delayed' + (delay ? ' +' + delay + 'm' : ''), cls: 'warn' };
  if (s.indexOf('unverif') >= 0) return { label: 'Unverified', cls: 'muted' };
  return { label: (delay != null && delay >= 15) ? 'Delayed +' + delay + 'm' : 'On time', cls: 'good' };
}

function agoText_(when) {
  if (!when || !(when instanceof Date) || isNaN(when.getTime())) return '';
  const mins = Math.round((Date.now() - when.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const h = Math.round(mins / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

// ---- rendering (pure) ----------------------------------------------------

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPage(model) {
  const hero = model.nextSeg ? renderHero_(model, model.nextSeg) : '';
  const stats = model.empty ? '' : renderStats_(model);
  const map = model.empty ? '' : renderMap_(model);
  const cal = model.empty ? '' : renderCalendar_(model);
  const up = model.upcoming;
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
    '<header class="topbar"><div class="brand"><span class="wordmark">Flug</span><span class="tag">flights</span></div></header>' +
    emptyMsg + hero + stats + map + cal + upSection + pastSection +
    '<footer class="foot">Updates automatically from your booking emails. Times are each airport’s local time. ' +
    'Live status isn’t tracked — schedule only.</footer></div>' + FOOT_;
}

function renderHero_(model, s) {
  const cd = model.daysToNext === 0 ? 'Today' : model.daysToNext === 1 ? 'Tomorrow'
    : model.daysToNext != null ? 'In ' + model.daysToNext + ' days' : '';
  const fno = s.flightNo ? '<span class="fchip mono">' + esc_(s.flightNo) + '</span>' : '';
  const gate = s.liveGate || s.depTerminal;
  return '<div class="lbl">Next flight' + (cd ? ' · ' + esc_(cd.toLowerCase()) : '') + '</div>' +
  '<section class="pass"><div class="pass-top">' +
    '<div class="pass-eyebrow"><span>' + esc_(String(s.date || '').toUpperCase()) + '</span>' +
      (s.confirmation ? '<span class="countdown mono">CONF&nbsp;' + esc_(s.confirmation) + '</span>' : '') + '</div>' +
    '<div class="route">' +
      '<div class="port"><div class="code mono">' + esc_(s.origin || '–') + '</div></div>' +
      '<div class="arc" aria-hidden="true"><svg viewBox="0 0 92 46" fill="none">' +
        '<path d="M4 40 C 30 2, 62 2, 88 40" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 4" opacity=".8"/>' +
        '<circle cx="46" cy="9.4" r="2.6" fill="currentColor"/></svg><span class="stop mono">NONSTOP</span></div>' +
      '<div class="port"><div class="code mono">' + esc_(s.dest || '–') + '</div></div></div>' +
    '<div class="pass-times">' +
      '<div class="t"><div class="clock mono">' + esc_(s.depart || '–') + '</div><div class="sub">Depart ' + esc_(s.origin) + (gate ? ' · Gate ' + esc_(gate) : '') + '</div></div>' +
      '<div class="t r"><div class="clock mono">' + esc_(s.arrive || '–') + '</div><div class="sub">Arrive ' + esc_(s.dest) + '</div></div></div>' +
    '</div><div class="perf" aria-hidden="true"></div>' +
    '<div class="pass-bot"><div class="flightnos">' + fno + '</div>' +
      heroStatus_(s) + '</div></section>';
}

function heroStatus_(s) {
  const si = statusInfo_(s);
  const label = si ? si.label : 'Scheduled';
  const col = !si ? '#8fe6b6'
    : si.cls === 'warn' ? '#ffcf7a'
    : si.cls === 'crit' ? '#ff9b8a'
    : si.cls === 'muted' ? '#cfe0d6' : '#8fe6b6';
  const ago = agoText_(s.statusUpdated);
  return '<span class="status" style="color:' + col + '"><span class="dot" style="background:' + col + '"></span>' +
    esc_(label) + (ago ? ' <span style="opacity:.7;font-weight:500">· ' + esc_(ago) + '</span>' : '') + '</span>';
}

function renderStats_(model) {
  const s = model.stats;
  function tile(n, k) { return '<div class="stat"><div class="n mono">' + esc_(n) + '</div><div class="k">' + esc_(k) + '</div></div>'; }
  return '<div class="lbl">' + model.year + ' so far</div><section class="stats">' +
    tile(s.flights, 'Flights') + tile(s.airports, 'Airports') + tile(s.trips, 'Trips') + tile(s.upcoming, 'Upcoming') + '</section>';
}

function renderTrip_(t, open) {
  const n = t.segs.length;
  const meta = esc_(t.dateRange) + ' · ' + n + ' flight' + (n > 1 ? 's' : '');
  let body = '';
  t.segs.forEach(function (s, i) {
    body += renderSegDetail_(s);
    const g = t.gaps[i];
    if (!g) return;
    if (g.layover && g.mins != null) {
      body += '<div class="layover">Layover ' + esc_(fmtDur_(g.mins)) + ' · ' + esc_(g.airport) + '</div>';
    } else if (g.mins != null) {
      body += '<div class="stay"><span>' + esc_(fmtStay_(g.mins)) + ' in ' + esc_(g.airport) + '</span></div>';
    }
  });
  return '<details class="trip" id="trip-' + safeId_(t.id) + '"' + (open ? ' open' : '') + '>' +
    '<summary class="trip-sum"><div class="ts-main"><span class="where">' + esc_(t.headline) + '</span>' +
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
    '</div>' + (metaBits ? '<div class="segd-meta">' + metaBits + '</div>' : '') +
    segStatusRow_(s) + '</div>';
}

function segStatusRow_(s) {
  const si = statusInfo_(s);
  if (!si) return '';
  const ago = agoText_(s.statusUpdated);
  return '<div class="segd-status"><span class="chip ' + si.cls + '">' + esc_(si.label) + '</span>' +
    (s.liveGate ? '<span class="segd-ago">Gate ' + esc_(s.liveGate) + '</span>' : '') +
    (ago ? '<span class="segd-ago">· updated ' + esc_(ago) + '</span>' : '') + '</div>';
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
      let covered = false, isStart = false, isEnd = false, tripId = '';
      model.trips.forEach(function (t) {
        if (t.start && t.end && date >= t.start && date <= t.end) {
          covered = true;
          if (!tripId) tripId = safeId_(t.id);
          if (date.getTime() === t.start.getTime()) isStart = true;
          if (date.getTime() === t.end.getTime()) isEnd = true;
        }
      });
      let cls = 'cell';
      if (covered) { cls += ' span'; if (isStart) cls += ' span-start'; if (isEnd) cls += ' span-end'; }
      if (date.getTime() === today.getTime()) cls += ' today';
      cells += '<div class="' + cls + '"' + (tripId ? ' data-trip="' + tripId + '"' : '') + '><span>' + d + '</span></div>';
    }
    return '<div class="cal"><div class="cal-head"><span class="m">' + MON[m] + ' ' + y + '</span></div>' +
      '<div class="grid">' + DOW.map(function (x) { return '<div class="dow">' + x + '</div>'; }).join('') + cells + '</div></div>';
  }).join('');

  return '<div class="lbl">Calendar <span class="hint">— swipe · tap a highlighted day</span></div>' +
    '<section class="cals">' + grids + '</section>' +
    '<script>(function(){document.addEventListener("click",function(e){var c=e.target.closest?e.target.closest(".cell.span[data-trip]"):null;if(!c)return;var el=document.getElementById("trip-"+c.getAttribute("data-trip"));if(!el)return;el.open=true;try{el.scrollIntoView({behavior:"smooth",block:"center"});}catch(x){el.scrollIntoView();}el.classList.add("flash");setTimeout(function(){el.classList.remove("flash");},1400);});})();</script>';
}

function safeId_(s) { return String(s).replace(/[^A-Za-z0-9]/g, ''); }

function renderMap_(model) {
  const md = model.mapData;
  if (!md || !md.routes.length) return '';
  const chips = ['all'].concat(md.years).map(function (y, i) {
    return '<button class="yrchip' + (i === 0 ? ' on' : '') + '" data-y="' + y + '">' +
      (y === 'all' ? 'All time' : y) + '</button>';
  }).join('');
  const json = JSON.stringify(md).replace(/</g, '\\u003c');
  const world = (typeof WORLD_LAND !== 'undefined') ? WORLD_LAND : [];
  const worldJson = JSON.stringify(world).replace(/</g, '\\u003c');
  return '<div class="lbl">Flight map</div>' +
    '<section class="mapwrap"><div class="yrchips">' + chips + '</div>' +
    '<canvas id="flugmap" class="mapcanvas" title="Tap to enlarge"></canvas>' +
    '<div class="mapcap" id="mapcap"></div></section>' +
    '<div class="globe-modal" id="globeModal" hidden>' +
      '<div class="globe-modal-inner">' +
        '<button class="globe-close" id="globeClose" aria-label="Close">✕</button>' +
        '<canvas id="flugmapBig" class="mapcanvas-big"></canvas>' +
        '<div class="mapcap" id="mapcapBig"></div>' +
      '</div></div>' +
    '<script>window.FLUG_MAP=' + json + ';window.FLUG_WORLD=' + worldJson + ';</script>' +
    '<script>' + MAP_JS + '</script>';
}

// ---- styles / document shell ---------------------------------------------

var HEAD_ =
'<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2064%2064%27%3E%3Crect%20width=%2764%27%20height=%2764%27%20rx=%2714%27%20fill=%27%23005c46%27/%3E%3Ctext%20x=%2732%27%20y=%2747%27%20font-family=%27Georgia,serif%27%20font-style=%27italic%27%20font-weight=%27bold%27%20font-size=%2740%27%20fill=%27%23ffffff%27%20text-anchor=%27middle%27%3EF!%3C/text%3E%3C/svg%3E">' +
'<link rel="preconnect" href="https://fonts.googleapis.com">' +
'<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
'<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+Condensed:wght@600;700&family=Playfair+Display:ital,wght@0,700;0,900;1,700;1,900&display=swap">' +
'<style>' +
':root{--bg:#eef2ea;--surface:#ffffff;--surface-2:#f1f6ef;--ink:#0d2c20;--ink-2:#48604f;--ink-3:#84948a;--line:#dbe6dd;--accent:#005c46;--accent-bg:#dbebe1;--accent-ink:#005c46;--good:#005c46;--warn:#b26a00;--warn-bg:#f7ead2;--crit:#b23b2e;--crit-bg:#f6ded9;--pill:#e7f0e9;--pill-ink:#005c46;--font-display:"Playfair Display",Georgia,serif;--shadow:0 1px 2px rgba(0,46,32,.06),0 8px 24px rgba(0,46,32,.07)}' +
'@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#002a1b;--surface:#014030;--surface-2:#015138;--ink:#eaf3ed;--ink-2:#a3c6b3;--ink-3:#6c9282;--line:#0c5540;--accent:#6fdba6;--accent-bg:rgba(111,219,166,.15);--accent-ink:#88e6ba;--good:#6fdba6;--warn:#e9b45c;--warn-bg:rgba(233,180,92,.16);--crit:#ec7d67;--crit-bg:rgba(236,125,103,.16);--pill:#eef4ee;--pill-ink:#005c46;--shadow:0 1px 2px rgba(0,0,0,.45),0 10px 30px rgba(0,0,0,.4)}}' +
'*{box-sizing:border-box}' +
'body{margin:0;background:var(--bg);color:var(--ink);font-family:"IBM Plex Sans",system-ui,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}' +
'.mono{font-family:"IBM Plex Mono",ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}' +
'.shell{max-width:460px;margin:0 auto;padding:0 16px 48px}' +
'.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:baseline;gap:10px;padding:16px 2px 12px;background:linear-gradient(var(--bg) 72%,transparent)}' +
'.brand{display:flex;align-items:baseline;gap:9px}' +
'.brand .wordmark{font-family:var(--font-display);font-style:italic;font-weight:900;font-size:23px;letter-spacing:.01em;line-height:1;color:var(--pill-ink);background:var(--pill);padding:5px 16px 7px;border-radius:999px}' +
'.brand .tag{color:var(--ink-3);font-weight:500;font-size:11px;letter-spacing:.14em;text-transform:uppercase}' +
'.lbl{margin:26px 2px 11px;font-size:11px;letter-spacing:.13em;text-transform:uppercase;font-weight:600;color:var(--accent)}' +
'.empty{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:22px;color:var(--ink-2);box-shadow:var(--shadow);margin-top:8px}' +
'.pass{position:relative;border-radius:20px;overflow:hidden;background:radial-gradient(130% 100% at 82% -12%,rgba(120,224,178,.30),transparent 55%),linear-gradient(158deg,#00402f 0%,#005c46 45%,#00281a 100%);color:#eef4ec;box-shadow:var(--shadow)}' +
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
'.cals{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;padding-bottom:6px;scrollbar-width:none}.cals::-webkit-scrollbar{display:none}' +
'.cal{flex:0 0 86%;scroll-snap-align:center;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:14px 15px 16px}' +
'.cell.span[data-trip]{cursor:pointer}.hint{font-weight:500;letter-spacing:0;text-transform:none;color:var(--ink-3)}.trip.flash{box-shadow:0 0 0 2px var(--accent),var(--shadow)}' +
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
'.ts-main .where{font-family:var(--font-display);font-style:italic;font-weight:800;font-size:17px;letter-spacing:.01em}.ts-meta{font-size:12px;color:var(--ink-2)}' +
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
'.stay{display:flex;align-items:center;gap:10px;margin:2px 0;color:var(--ink-3);font-size:11px;letter-spacing:.04em;text-transform:uppercase}.stay::before,.stay::after{content:"";height:1px;background:var(--line);flex:1}' +
'.chip{font-size:11.5px;font-weight:600;padding:4px 9px;border-radius:999px;white-space:nowrap}.chip.info{color:var(--ink-2);background:var(--surface-2)}.chip.landed,.chip.muted{color:var(--ink-2);background:var(--surface-2)}.chip.good{color:var(--good);background:var(--accent-bg)}.chip.warn{color:var(--warn);background:var(--warn-bg)}.chip.crit{color:var(--crit);background:var(--crit-bg)}.chip.accent{color:var(--accent-ink);background:var(--accent-bg)}' +
'.segd-status{display:flex;align-items:center;gap:8px;margin-top:8px}.segd-ago{font-size:10.5px;color:var(--ink-3)}' +
'.mapwrap{background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:12px 12px 14px}' +
'.yrchips{display:flex;gap:6px;overflow-x:auto;padding-bottom:10px;-webkit-overflow-scrolling:touch}' +
'.yrchip{flex:0 0 auto;font:600 12px "IBM Plex Sans",sans-serif;color:var(--ink-2);background:var(--surface-2);border:1px solid var(--line);border-radius:999px;padding:5px 12px;cursor:pointer}' +
'.yrchip.on{background:var(--accent);color:#fff;border-color:var(--accent)}' +
'.mapcanvas{display:block;width:100%;height:300px;cursor:pointer}' +
'.globe-modal{position:fixed;inset:0;z-index:100;background:rgba(0,20,12,.74);display:flex;align-items:center;justify-content:center;padding:16px}.globe-modal[hidden]{display:none}' +
'.globe-modal-inner{position:relative;width:min(92vw,560px)}' +
'.mapcanvas-big{display:block;width:100%;height:min(92vw,560px);cursor:grab;touch-action:none}.mapcanvas-big:active{cursor:grabbing}' +
'.globe-close{position:absolute;top:-8px;right:-8px;width:36px;height:36px;border-radius:50%;border:1px solid var(--line);background:var(--surface);color:var(--ink);font-size:15px;cursor:pointer;box-shadow:var(--shadow);z-index:2}' +
'.mapcap{margin-top:8px;font-size:11.5px;color:var(--ink-3);text-align:center;font-variant-numeric:tabular-nums}' +
'.foot{margin-top:26px;padding:14px 4px 0;border-top:1px solid var(--line);color:var(--ink-3);font-size:12px;line-height:1.55}' +
'</style>';

var FOOT_ = '';

var MAP_JS = `(function(){
  var D=window.FLUG_MAP, LAND=window.FLUG_WORLD||[]; if(!D)return;
  var RAD=Math.PI/180, sel='all';
  function css(v){ try{return getComputedStyle(document.documentElement).getPropertyValue(v).trim();}catch(e){return '';} }
  function vis(){ return D.routes.filter(function(r){ return sel==='all'||r.years.indexOf(+sel)>=0; }); }
  function gc(o,d,n){ var la1=o[0]*RAD,lo1=o[1]*RAD,la2=d[0]*RAD,lo2=d[1]*RAD;
    var x1=Math.cos(la1)*Math.cos(lo1),y1=Math.cos(la1)*Math.sin(lo1),z1=Math.sin(la1);
    var x2=Math.cos(la2)*Math.cos(lo2),y2=Math.cos(la2)*Math.sin(lo2),z2=Math.sin(la2);
    var dot=Math.max(-1,Math.min(1,x1*x2+y1*y2+z1*z2)), ang=Math.acos(dot); if(ang<1e-6)return[o,d];
    var out=[]; for(var i=0;i<=n;i++){ var t=i/n,s1=Math.sin((1-t)*ang)/Math.sin(ang),s2=Math.sin(t*ang)/Math.sin(ang);
      var x=s1*x1+s2*x2,y=s1*y1+s2*y2,z=s1*z1+s2*z2; out.push([Math.atan2(z,Math.sqrt(x*x+y*y))/RAD,Math.atan2(y,x)/RAD]); } return out; }

  function makeGlobe(cv, opts){
    if(!cv) return null;
    var ctx=cv.getContext('2d'); var cap=opts.cap?document.getElementById(opts.cap):null;
    var cen=[20,0]; (function(){ var la=0,lo=0,n=0; for(var c in D.airports){ la+=D.airports[c][0]; lo+=D.airports[c][1]; n++; } if(n)cen=[la/n,lo/n]; })();
    var cLat=cen[0], cLon=cen[1], dragging=false, lx=0, ly=0;
    var W=300,H=300,R=140,cx=150,cy=150;
    function resize(){ W=cv.clientWidth||300; H=cv.clientHeight||300; var dpr=window.devicePixelRatio||1; cv.width=W*dpr; cv.height=H*dpr; ctx.setTransform(dpr,0,0,dpr,0,0); cx=W/2; cy=H/2; R=Math.min(W,H)/2-(opts.labels?22:12); }
    function proj(lat,lon){ var p=lat*RAD,l=(lon-cLon)*RAD,p0=cLat*RAD;
      var cosc=Math.sin(p0)*Math.sin(p)+Math.cos(p0)*Math.cos(p)*Math.cos(l);
      var x=Math.cos(p)*Math.sin(l), y=Math.cos(p0)*Math.sin(p)-Math.sin(p0)*Math.cos(p)*Math.cos(l);
      return [cx+R*x, cy-R*y, cosc>=0, x, y]; }
    function draw(){
      ctx.clearRect(0,0,W,H);
      var ocean=css('--surface-2')||'#eef', line=css('--line')||'#ccc', accent=css('--accent')||'#005c46', ink=css('--ink')||'#111';
      ctx.beginPath(); ctx.arc(cx,cy,R,0,6.2832); ctx.fillStyle=ocean; ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.arc(cx,cy,R,0,6.2832); ctx.clip();
      ctx.fillStyle=accent; ctx.strokeStyle=accent; ctx.lineWidth=.6;
      for(var r=0;r<LAND.length;r++){ var ring=LAND[r]; ctx.beginPath(); var any=false;
        for(var i=0;i<ring.length;i+=2){ var pr=proj(ring[i+1],ring[i]); var X=pr[0],Y=pr[1];
          if(!pr[2]){ var h=Math.hypot(pr[3],pr[4])||1; X=cx+R*pr[3]/h; Y=cy-R*pr[4]/h; if(!any){continue;} }
          if(!any){ ctx.moveTo(X,Y); any=true; } else ctx.lineTo(X,Y); }
        if(any){ ctx.closePath(); ctx.globalAlpha=.16; ctx.fill(); ctx.globalAlpha=.5; ctx.stroke(); } }
      ctx.globalAlpha=1;
      ctx.strokeStyle=line; ctx.lineWidth=.6; ctx.globalAlpha=.5;
      function poly(pts){ var pen=false; ctx.beginPath(); for(var i=0;i<pts.length;i++){ var p=proj(pts[i][0],pts[i][1]); if(p[2]){ if(!pen){ctx.moveTo(p[0],p[1]);pen=true;} else ctx.lineTo(p[0],p[1]); } else pen=false; } ctx.stroke(); }
      var a,b,arr;
      for(a=-150;a<=180;a+=30){ arr=[]; for(b=-80;b<=80;b+=5)arr.push([b,a]); poly(arr); }
      for(a=-60;a<=60;a+=30){ arr=[]; for(b=-180;b<=180;b+=5)arr.push([a,b]); poly(arr); }
      ctx.globalAlpha=1;
      var rs=vis(), codes={}; rs.forEach(function(x){ codes[x.o]=1; codes[x.d]=1; });
      ctx.lineJoin='round'; ctx.lineCap='round';
      rs.forEach(function(rt){ var o=D.airports[rt.o],d=D.airports[rt.d]; if(!o||!d)return;
        var pts=gc(o,d,60), pen=false; ctx.beginPath();
        for(var i=0;i<pts.length;i++){ var p=proj(pts[i][0],pts[i][1]); if(p[2]){ if(!pen){ctx.moveTo(p[0],p[1]);pen=true;} else ctx.lineTo(p[0],p[1]); } else pen=false; }
        ctx.strokeStyle=accent; ctx.globalAlpha=.85; ctx.lineWidth=Math.min(1+rt.n*0.5,4.5); ctx.stroke(); });
      ctx.globalAlpha=1; ctx.restore();
      ctx.beginPath(); ctx.arc(cx,cy,R,0,6.2832); ctx.strokeStyle=line; ctx.lineWidth=1; ctx.stroke();
      ctx.font='600 '+(opts.labels?11:10)+'px "IBM Plex Mono",monospace';
      Object.keys(codes).forEach(function(c){ var a=D.airports[c]; if(!a)return; var p=proj(a[0],a[1]); if(!p[2])return;
        ctx.beginPath(); ctx.arc(p[0],p[1],opts.labels?3.6:2.6,0,6.2832); ctx.fillStyle=accent; ctx.fill();
        ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(p[0],p[1],1.2,0,6.2832); ctx.fill();
        if(opts.labels){ ctx.fillStyle=ink; ctx.fillText(c,p[0]+6,p[1]-5); } });
      if(cap){ var nf=0; rs.forEach(function(x){nf+=x.n;}); cap.textContent=rs.length+' routes · '+Object.keys(codes).length+' airports · '+nf+' flights'+(opts.labels?' · drag to spin':''); }
    }
    if(opts.interactive){
      function dn(e){dragging=true;var t=e.touches?e.touches[0]:e;lx=t.clientX;ly=t.clientY;}
      function mv(e){if(!dragging)return;var t=e.touches?e.touches[0]:e;var dx=t.clientX-lx,dy=t.clientY-ly;lx=t.clientX;ly=t.clientY;cLon-=dx*0.4;cLat+=dy*0.4;if(cLat>85)cLat=85;if(cLat<-85)cLat=-85;if(e.cancelable)e.preventDefault();draw();}
      function upp(){dragging=false;}
      cv.addEventListener('mousedown',dn);window.addEventListener('mousemove',mv);window.addEventListener('mouseup',upp);
      cv.addEventListener('touchstart',dn,{passive:true});cv.addEventListener('touchmove',mv,{passive:false});window.addEventListener('touchend',upp);
    }
    return { draw:function(){resize();draw();} };
  }

  var small=makeGlobe(document.getElementById('flugmap'),{labels:false,interactive:false,cap:'mapcap'});
  var big=makeGlobe(document.getElementById('flugmapBig'),{labels:true,interactive:true,cap:'mapcapBig'});
  function drawAll(){ if(small)small.draw(); if(big)big.draw(); }

  var chips=[].slice.call(document.querySelectorAll('.yrchip'));
  chips.forEach(function(b){ b.addEventListener('click',function(){ sel=b.getAttribute('data-y'); chips.forEach(function(x){x.classList.remove('on');}); b.classList.add('on'); drawAll(); }); });

  var modal=document.getElementById('globeModal'), openEl=document.getElementById('flugmap'), closeEl=document.getElementById('globeClose');
  function openModal(){ if(!modal)return; modal.hidden=false; if(big)big.draw(); }
  function closeModal(){ if(modal)modal.hidden=true; }
  if(openEl)openEl.addEventListener('click',openModal);
  if(closeEl)closeEl.addEventListener('click',closeModal);
  if(modal)modal.addEventListener('click',function(e){ if(e.target===modal)closeModal(); });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape')closeModal(); });

  if(small)small.draw();
  window.addEventListener('resize',drawAll);
})();`;
