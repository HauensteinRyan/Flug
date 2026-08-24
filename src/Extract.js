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
  let segments = extractFromJsonLd_(message);
  if (segments.length) return segments;
  segments = extractDeltaLayout_(message);
  if (segments.length) return segments;
  return extractHeuristic_(message);
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
