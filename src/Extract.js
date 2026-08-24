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
  return extractHeuristic_(message);
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
