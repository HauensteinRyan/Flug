/**
 * Detection: decide whether a Gmail message is a flight confirmation
 * (or flight-related update) worth organizing.
 */

// Sender domains of airlines and booking sites, mapped to a display name.
// Matched as a substring of the From header, so subdomains
// (e.g. t.delta.com, email.aa.com) match too. Extend via EXTRA_SENDERS.
const AIRLINE_SENDERS = {
  'delta.com': 'Delta Air Lines',
  'united.com': 'United Airlines',
  'aa.com': 'American Airlines',
  'southwest.com': 'Southwest Airlines',
  'alaskaair.com': 'Alaska Airlines',
  'jetblue.com': 'JetBlue',
  'hawaiianair.com': 'Hawaiian Airlines',
  'flyfrontier.com': 'Frontier Airlines',
  'spirit.com': 'Spirit Airlines',
  'allegiantair.com': 'Allegiant Air',
  'aircanada.ca': 'Air Canada',
  'aircanada.com': 'Air Canada',
  'westjet.com': 'WestJet',
  'lufthansa.com': 'Lufthansa',
  'lufthansa-group.com': 'Lufthansa Group',
  'miles-and-more.com': 'Lufthansa (Miles & More)',
  'swiss.com': 'SWISS',
  'austrian.com': 'Austrian Airlines',
  'brusselsairlines.com': 'Brussels Airlines',
  'eurowings.com': 'Eurowings',
  'britishairways.com': 'British Airways',
  'airfrance.com': 'Air France',
  'airfrance.fr': 'Air France',
  'klm.com': 'KLM',
  'klm.nl': 'KLM',
  'iberia.com': 'Iberia',
  'vueling.com': 'Vueling',
  'ryanair.com': 'Ryanair',
  'easyjet.com': 'easyJet',
  'wizzair.com': 'Wizz Air',
  'flytap.com': 'TAP Air Portugal',
  'tapmilesandgo.com': 'TAP Air Portugal',
  'aerlingus.com': 'Aer Lingus',
  'finnair.com': 'Finnair',
  'flysas.com': 'SAS',
  'sas.se': 'SAS',
  'norwegian.com': 'Norwegian',
  'ita-airways.com': 'ITA Airways',
  'turkishairlines.com': 'Turkish Airlines',
  'thy.com': 'Turkish Airlines',
  'emirates.com': 'Emirates',
  'etihad.com': 'Etihad Airways',
  'qatarairways.com': 'Qatar Airways',
  'singaporeair.com': 'Singapore Airlines',
  'cathaypacific.com': 'Cathay Pacific',
  'ana.co.jp': 'ANA',
  'jal.co.jp': 'Japan Airlines',
  'jal.com': 'Japan Airlines',
  'koreanair.com': 'Korean Air',
  'evaair.com': 'EVA Air',
  'qantas.com': 'Qantas',
  'airnewzealand.com': 'Air New Zealand',
  'latam.com': 'LATAM',
  'avianca.com': 'Avianca',
  'copaair.com': 'Copa Airlines',
  'aeromexico.com': 'Aeroméxico',
  'volaris.com': 'Volaris',
  // Booking sites / OTAs
  'expedia.com': 'Expedia',
  'orbitz.com': 'Orbitz',
  'travelocity.com': 'Travelocity',
  'priceline.com': 'Priceline',
  'booking.com': 'Booking.com',
  'hopper.com': 'Hopper',
  'kiwi.com': 'Kiwi.com',
  'navan.com': 'Navan',
};

const SUBJECT_KEYWORDS = [
  'flight confirmation', 'booking confirmation', 'booking reference',
  'your itinerary', 'itinerary confirmation', 'trip confirmation',
  'e-ticket', 'eticket', 'electronic ticket',
  'your trip to', 'your upcoming trip', 'your flight to',
  'flight receipt', 'your flight receipt', 'reservation confirmed',
  'your reservation', 'ticket confirmation', 'confirmation #',
  'confirmation number', 'you’re booked', "you're booked",
];

const CHANGE_KEYWORDS = [
  'schedule change', 'flight change', 'itinerary change', 'flight changed',
  'time change', 'flight delay', 'delayed', 'cancelled', 'canceled',
  'rebooked', 'gate change',
];

const BODY_HINTS = [
  'record locator', 'confirmation code', 'confirmation number',
  'booking reference', 'booking code', 'reservation code', 'pnr',
  'e-ticket number', 'boarding', 'departure', 'departs', 'arrival',
];

/**
 * Score a message. Returns null when it doesn't look flight-related,
 * otherwise:
 *   { airline, kind: 'confirmation'|'update', forwardable, score }
 *
 * forwardable = confident enough to auto-forward to Flighty (airline sender
 * and a parseable code/flight number), so Flighty isn't spammed with emails
 * it can't read.
 */
function classifyMessage(message, parsed) {
  const from = (message.getFrom() || '').toLowerCase();
  const subject = (message.getSubject() || '').toLowerCase();
  const body = (message.getPlainBody() || '').toLowerCase().slice(0, 20000);

  let airline = null;
  for (const domain in AIRLINE_SENDERS) {
    if (from.indexOf(domain) !== -1) {
      airline = AIRLINE_SENDERS[domain];
      break;
    }
  }
  if (!airline) {
    const extras = cfg('EXTRA_SENDERS').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(String);
    for (const extra of extras) {
      if (extra && from.indexOf(extra) !== -1) {
        airline = extra;
        break;
      }
    }
  }

  const subjectHit = SUBJECT_KEYWORDS.some(function (k) { return subject.indexOf(k) !== -1; });
  const changeHit = CHANGE_KEYWORDS.some(function (k) { return subject.indexOf(k) !== -1; });
  const bodyHits = BODY_HINTS.filter(function (k) { return body.indexOf(k) !== -1; }).length;

  let score = 0;
  if (airline) score += 3;
  if (subjectHit || changeHit) score += 2;
  score += Math.min(bodyHits, 2);
  if (parsed.flights.length > 0 || parsed.confirmationCode) score += 1;

  // Require a recognized sender or an explicit flight-y subject, plus
  // enough total signal, to keep marketing mail and hotel bookings out.
  if (score < 4 || (!airline && !subjectHit && !changeHit)) return null;
  // Sender-only signal isn't enough (airlines send plenty of promos).
  if (airline && !subjectHit && !changeHit && bodyHits === 0) return null;

  const kind = changeHit && !subjectHit ? 'update' : 'confirmation';
  const forwardable = Boolean(
    airline &&
    kind === 'confirmation' &&
    (parsed.confirmationCode || parsed.flights.length > 0)
  );

  return { airline: airline, kind: kind, forwardable: forwardable, score: score };
}

/** Gmail search query for candidate messages. */
function buildSearchQuery(windowDays) {
  const domains = Object.keys(AIRLINE_SENDERS)
    .concat(cfg('EXTRA_SENDERS').split(',').map(function (s) { return s.trim(); }).filter(String));
  const fromClause = 'from:(' + domains.join(' OR ') + ')';
  const subjectClause = 'subject:("flight confirmation" OR "booking confirmation" OR ' +
    '"your itinerary" OR "e-ticket" OR "eticket" OR "flight receipt" OR ' +
    '"trip confirmation" OR "itinerary confirmation" OR "schedule change")';
  return '-in:trash -in:spam -from:me newer_than:' + windowDays + 'd ' +
    '(' + fromClause + ' OR ' + subjectClause + ')';
}
