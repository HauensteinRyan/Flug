/**
 * Structured flight extraction — turns a confirmation email into an array
 * of flight segments the app can store and display.
 *
 * Primary source: schema.org FlightReservation / Flight JSON-LD embedded in
 * the email. This is the same structured markup Google reads to build its
 * flight cards, so when it's present we get standardized flight numbers,
 * IATA airport codes, exact departure/arrival times (with timezone), and the
 * confirmation number — no fragile text scraping.
 *
 * Fallback: the heuristic subject/body parse (Parse.js) for emails that
 * carry no markup. Coarser (often no precise times), but better than nothing.
 *
 * Each segment: {
 *   confirmation, airline, flightNo, origin, dest,
 *   depTime: Date|null, arrTime: Date|null, source: 'schema'|'text'
 * }
 */

function extractFlights(message) {
  // Cheap text parsers first (getPlainBody); the JSON-LD path calls the
  // expensive getBody() and only runs when the text parsers find nothing.
  let segments = extractAmTravLayout_(message);
  if (segments.length) return segments;
  segments = extractDeltaLayout_(message);
  if (segments.length) return segments;
  segments = extractFromJsonLd_(message);
  if (segments.length) return segments;
  return extractHeuristic_(message);
}

// Airline display name -> IATA code, for sources that name the carrier
// ("Delta #2905") instead of giving a code.
const AIRLINE_NAME_CODE = {
  'delta': 'DL', 'united': 'UA', 'american': 'AA', 'southwest': 'WN',
  'alaska': 'AS', 'jetblue': 'B6', 'spirit': 'NK', 'frontier': 'F9',
  'hawaiian': 'HA', 'air canada': 'AC', 'westjet': 'WS', 'lufthansa': 'LH',
  'british airways': 'BA', 'air france': 'AF', 'klm': 'KL', 'aer lingus': 'EI',
  'swiss': 'LX', 'iberia': 'IB', 'finnair': 'AY', 'ita airways': 'AZ',
};

// ---- AmTrav (corporate agency) booking layout ----------------------------
//
// AmTrav confirmations name the carrier and per-segment airline PNR:
//   CONFIRMATION # G6UNJ9 / Delta #2905 /
//   DEPARTS 9:45 AM Mon, Aug 24 SEA / ARRIVES 12:20 PM ... LAS
// The "CONFIRMATION #" is the airline record locator — the same code Delta's
// own email uses — so keying on flight+route+day merges the two sources.

var AMTRAV_CARRIERS = 'Delta|United|American|Southwest|Alaska|JetBlue|Spirit|Frontier|Hawaiian|Air\\s*Canada|WestJet|Lufthansa|British\\s*Airways|Air\\s*France|KLM|Aer\\s*Lingus|SWISS|Iberia|Finnair|ITA(?:\\s*Airways)?';

function extractAmTravLayout_(message) {
  const from = (message.getFrom() || '').toLowerCase();
  const text = message.getPlainBody() || '';
  if (from.indexOf('amtrav') === -1 && !/AmTrav Booking|Your Trip is Booked/i.test(text)) return [];
  const emailDate = message.getDate();

  // Confirmation codes (airline record locators), with positions, so each
  // flight can inherit the most recent one. Codes come wrapped like
  // "CONFIRMATION # *GD97ZY*".
  const confs = [];
  let cm;
  const reConf = /CONFIRMATION\s*#\s*\*?\s*([A-Z0-9]{5,8})/gi;
  while ((cm = reConf.exec(text)) !== null) confs.push({ pos: cm.index, code: cm[1].toUpperCase() });
  function confAt(pos) {
    let code = '';
    for (let i = 0; i < confs.length; i++) { if (confs[i].pos <= pos) code = confs[i].code; else break; }
    return code;
  }

  // Every flight is its own "Carrier #NNNN" marker — including connections
  // under one confirmation code. Slice the text between markers.
  const marks = [];
  let fm;
  const reFlight = new RegExp('\\b(' + AMTRAV_CARRIERS + ')\\s*#\\s*(\\d{1,4})', 'gi');
  while ((fm = reFlight.exec(text)) !== null) {
    marks.push({ pos: fm.index, end: reFlight.lastIndex, airline: fm[1].replace(/\s+/g, ' '), num: fm[2] });
  }

  const STOP = { USB: 1, TSA: 1, FAA: 1, WIF: 1 };
  const out = [];

  for (let i = 0; i < marks.length; i++) {
    const chunk = text.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].pos : text.length);

    const code = AIRLINE_NAME_CODE[marks[i].airline.toLowerCase()] || '';
    const flightNo = (code ? code + ' ' : '') + parseInt(marks[i].num, 10);

    const codes = [];
    let am;
    const reAir = /\b([A-Z]{3})\b/g;
    while ((am = reAir.exec(chunk)) !== null) {
      if (!STOP[am[1]] && codes.indexOf(am[1]) === -1) codes.push(am[1]);
      if (codes.length >= 2) break;
    }

    const dep = chunk.match(/DEPARTS?\s+(\d{1,2}:\d{2})\s*(AM|PM)/i);
    const arr = chunk.match(/ARRIVES?\s+(\d{1,2}:\d{2})\s*(AM|PM)/i);
    const depTimeStr = dep ? dep[1] + ' ' + dep[2].toUpperCase() : '';
    const arrTimeStr = arr ? arr[1] + ' ' + arr[2].toUpperCase() : '';

    let dateStr = '';
    const dm = chunk.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/);
    if (dm) dateStr = dm[1].slice(0, 3) + ' ' + dm[2] + (dm[3] ? ', ' + dm[3] : '');

    if (codes.length < 2 && !depTimeStr) continue;
    const origin = codes[0] || '', dest = codes[1] || '';
    const depDate = dateStr ? resolveDate(dateStr, emailDate) : null;
    const depTime = depDate && depTimeStr ? combineDateTime_(depDate, depTimeStr) : null;
    let arrTime = depDate && arrTimeStr ? combineDateTime_(depDate, arrTimeStr) : null;
    if (arrTime && depTime && arrTime < depTime) arrTime = new Date(arrTime.getTime() + 86400000);

    // Extra per-flight detail AmTrav includes.
    const seat = (chunk.match(/SEAT\(?S?\)?\s*\n?\s*([0-9]{1,3}[A-K])/i) || [])[1] || '';
    const cabin = ((chunk.match(/CABIN\s*\n?\s*([^\n]+?)\s*(?:SEAT|STOPS)/i) || [])[1] || '').trim();
    const aircraft = ((chunk.match(/AIRCRAFT\s*\n?\s*([^\n]+)/i) || [])[1] || '').trim();
    const duration = (chunk.match(/DURATION\s*\n?\s*(\d+h(?:\s*\d+m)?|\d+m)/i) || [])[1] || '';
    const depTerminal = origin ? ((chunk.match(new RegExp(origin + '\\s+Terminal\\s+([A-Za-z0-9]+)', 'i')) || [])[1] || '') : '';
    const arrTerminal = dest ? ((chunk.match(new RegExp(dest + '\\s+Terminal\\s+([A-Za-z0-9]+)', 'i')) || [])[1] || '') : '';

    out.push({
      confirmation: confAt(marks[i].pos),
      airline: marks[i].airline + ' Air Lines',
      flightNo: flightNo, origin: origin, dest: dest,
      dateStr: dateStr, depTimeStr: depTimeStr, arrTimeStr: arrTimeStr,
      depDate: depDate, depTime: depTime, arrTime: arrTime,
      seat: seat, cabin: cabin, aircraft: aircraft, duration: duration,
      depTerminal: depTerminal, arrTerminal: arrTerminal,
      source: 'amtrav',
    });
  }

  return dedupeSegments_(out);
}

// ---- Delta (and similar) plain-text itinerary layout ---------------------
//
// Delta confirmations carry no schema markup, but the plain-text body has a
// consistent per-segment layout:
//   Flight 1 of 2 / DL177 / Boarding Closes 10:45 AM / 11:00 AM ... /
//   Tue, Aug 11 / 2:53 PM / DUB- -ATL / Dublin / Atlanta / Your Onboard...
// We split on the "Flight N of M" markers and read each segment's flight
// number, the two airport codes, the departure/arrival clock times, and the
// date. Times are the airport's local time, so we keep them as display
// strings and also resolve a sortable departure Date.

function extractDeltaLayout_(message) {
  const text = message.getPlainBody() || '';
  if (!/Flight\s+\d+\s+of\s+\d+/i.test(text) && !/Boarding\s+Closes/i.test(text)) return [];
  const emailDate = message.getDate();

  let conf = '';
  const cm = text.match(/MATION\s*#\s*([A-Z0-9]{5,8})/i);
  if (cm && /[A-Za-z]/.test(cm[1])) conf = cm[1].toUpperCase();

  const parts = text.split(/Flight\s+\d+\s+of\s+\d+/i);
  const chunks = parts.length > 1 ? parts.slice(1) : [text];
  const STOP = { USB: 1, VPN: 1, SMS: 1, FAQ: 1, FAA: 1, TSA: 1, WIF: 1 };
  const out = [];

  chunks.forEach(function (raw) {
    let chunk = raw;
    const cut = chunk.search(/Your\s+Onboard\s+Experience|Layover\s*\|/i);
    if (cut > 0) chunk = chunk.slice(0, cut);

    let mm, flightNo = '';
    const reCode = /\b([A-Z]{2})\s?(\d{2,4})\b/g;
    while ((mm = reCode.exec(chunk)) !== null) {
      if (KNOWN_AIRLINE_CODES.indexOf(mm[1]) !== -1) { flightNo = mm[1] + ' ' + parseInt(mm[2], 10); break; }
    }

    const codes = [];
    const reAir = /\b([A-Z]{3})\b/g;
    while ((mm = reAir.exec(chunk)) !== null) {
      if (!STOP[mm[1]] && codes.indexOf(mm[1]) === -1) codes.push(mm[1]);
      if (codes.length >= 2) break;
    }

    const times = [];
    const reT = /(\d{1,2}:\d{2})\s*(AM|PM)/gi;
    while ((mm = reT.exec(chunk)) !== null) times.push(mm[1] + ' ' + mm[2].toUpperCase());
    const depTimeStr = times.length >= 3 ? times[1] : (times[0] || '');
    const arrTimeStr = times.length ? times[times.length - 1] : '';

    let dateStr = '';
    const dm = chunk.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/);
    if (dm) dateStr = dm[1].slice(0, 3) + ' ' + dm[2] + (dm[3] ? ', ' + dm[3] : '');

    if (!flightNo && codes.length < 2) return;
    const depDate = dateStr ? resolveDate(dateStr, emailDate) : null;

    out.push({
      confirmation: conf,
      airline: 'Delta Air Lines',
      flightNo: flightNo,
      origin: codes[0] || '',
      dest: codes[1] || '',
      dateStr: dateStr,
      depTimeStr: depTimeStr,
      arrTimeStr: arrTimeStr,
      depDate: depDate,
      depTime: depDate && depTimeStr ? combineDateTime_(depDate, depTimeStr) : null,
      source: 'delta',
    });
  });

  return dedupeSegments_(out);
}

function combineDateTime_(day, timeStr) {
  const m = String(timeStr).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m || !day) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (m[3].toUpperCase() === 'PM' && h < 12) h += 12;
  if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, min);
}

// ---- primary: schema.org JSON-LD -----------------------------------------

function extractFromJsonLd_(message) {
  let html = '';
  try { html = message.getBody() || ''; } catch (e) { return []; }

  const blocks = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  ) || [];

  const segments = [];
  blocks.forEach(function (block) {
    const json = block
      .replace(/^<script[^>]*>/i, '')
      .replace(/<\/script>\s*$/i, '')
      .trim();
    let data;
    try { data = JSON.parse(json); } catch (e) { return; }
    collectReservations_(data, null, segments);
  });

  return dedupeSegments_(segments);
}

/** Walk arbitrary JSON-LD (objects, arrays, @graph) collecting flights. */
function collectReservations_(node, inheritedConf, out) {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    node.forEach(function (n) { collectReservations_(n, inheritedConf, out); });
    return;
  }

  const types = [].concat(node['@type'] || []);
  const isReservation = types.indexOf('FlightReservation') !== -1;
  const conf = node.reservationNumber || node.confirmationNumber || inheritedConf || null;

  if (isReservation && node.reservationFor) {
    [].concat(node.reservationFor).forEach(function (f) {
      const seg = flightToSegment_(f, conf);
      if (seg) out.push(seg);
    });
  } else if (types.indexOf('Flight') !== -1) {
    const seg = flightToSegment_(node, conf);
    if (seg) out.push(seg);
  }

  // Recurse into common containers so nested reservations aren't missed.
  if (node['@graph']) collectReservations_(node['@graph'], conf, out);
  if (node.subReservation) collectReservations_(node.subReservation, conf, out);
  if (node.reservationFor && !isReservation) collectReservations_(node.reservationFor, conf, out);
}

function flightToSegment_(flight, conf) {
  if (!flight || typeof flight !== 'object') return null;
  const air = flight.airline || {};
  const code = String(air.iataCode || '').toUpperCase();
  const num = String(flight.flightNumber || '').replace(/[^0-9]/g, '');
  const origin = airportCode_(flight.departureAirport);
  const dest = airportCode_(flight.arrivalAirport);
  if (!num && !origin && !dest) return null;

  return {
    confirmation: conf || '',
    airline: air.name || code || '',
    flightNo: (code ? code + ' ' : '') + num,
    origin: origin,
    dest: dest,
    depTime: parseIso_(flight.departureTime),
    arrTime: parseIso_(flight.arrivalTime),
    source: 'schema',
  };
}

function airportCode_(airport) {
  if (!airport) return '';
  if (typeof airport === 'string') {
    const m = airport.match(/\b([A-Z]{3})\b/);
    return m ? m[1] : '';
  }
  return String(airport.iataCode || (airport.name || '')).toUpperCase().slice(0, 3);
}

function parseIso_(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ---- fallback: heuristic text parse --------------------------------------

function extractHeuristic_(message) {
  const parsed = parseFlightInfo(message.getSubject() || '', message.getPlainBody() || '');
  const out = [];

  // Only confident enough to emit a segment when we have a clear O→D route.
  let origin = '', dest = '';
  if (parsed.route) {
    const m = parsed.route.match(/([A-Z]{3})\s*→\s*([A-Z]{3})/);
    if (m) { origin = m[1]; dest = m[2]; }
  }

  const firstFuture = firstFutureDate_(parsed.dates, message.getDate());
  const flights = parsed.flights.length ? parsed.flights : [''];

  flights.forEach(function (fn, i) {
    out.push({
      confirmation: parsed.confirmationCode || '',
      airline: '',
      flightNo: fn,
      origin: i === 0 ? origin : '',
      dest: i === 0 ? dest : '',
      depTime: firstFuture,
      arrTime: null,
      source: 'text',
    });
  });

  return dedupeSegments_(out);
}

function firstFutureDate_(dateStrs, emailDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < dateStrs.length; i++) {
    const d = resolveDate(dateStrs[i], emailDate);
    if (d && d >= today) return d;
  }
  return null;
}

// ---- shared ---------------------------------------------------------------

function dedupeSegments_(segments) {
  const seen = {};
  const out = [];
  segments.forEach(function (s) {
    const dayKey = s.depTime ? s.depTime.toISOString().slice(0, 10) : '';
    const key = [s.flightNo, s.origin, s.dest, dayKey].join('|');
    if (seen[key]) return;
    seen[key] = true;
    out.push(s);
  });
  return out;
}
