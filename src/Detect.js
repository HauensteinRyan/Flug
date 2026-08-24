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
  'amtrav.com': 'AmTrav',
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

// Airline mail that is NOT a new booking — check-in nudges, menus, seat
// upgrades, login PINs, mileage promos. Matching any of these skips the
// message entirely (no forward, no calendar, no label).
const EXCLUDE_SUBJECT_KEYWORDS = [
  'time to check in', 'check in for your', 'check-in', 'time to check',
  'your menu', 'menu for your', 'upgraded seat', 'your upgraded',
  'what you can look forward', 'look forward to on your',
  'pin code', 'is your pin', 'verification code', 'security code',
  'bonus miles', 'special offer', 'credit card', 'cruise',
  'earn up to', 'shot at', 'travel challenge', 'new benefits',
  'how was your', 'rate your', 'tell us about',
];

// Subjects that positively mean "this is a booking / ticket confirmation."
// Only these get forwarded to Flighty and put on the calendar.
const CONFIRM_SUBJECT_KEYWORDS = [
  'trip details', 'flight confirmation', 'booking confirmation',
  'your itinerary', 'itinerary confirmation', 'trip confirmation',
  'e-ticket', 'eticket', 'electronic ticket', 'flight receipt',
  'reservation confirmed', 'ticket confirmation', 'confirmation number',
  'award trip', "you're booked", 'you’re booked', 'your trip to',
  'amtrav booking', 'trip is booked',
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

  // Non-booking airline mail (check-in, menu, upgrade, PIN, promos) — skip.
  if (EXCLUDE_SUBJECT_KEYWORDS.some(function (k) { return subject.indexOf(k) !== -1; })) {
    return null;
  }

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

  const confirmSubjectHit = CONFIRM_SUBJECT_KEYWORDS.some(function (k) { return subject.indexOf(k) !== -1; });
  const subjectHit = confirmSubjectHit || SUBJECT_KEYWORDS.some(function (k) { return subject.indexOf(k) !== -1; });
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

  const kind = changeHit && !confirmSubjectHit ? 'update' : 'confirmation';

  // Only forward to Flighty / add to calendar for genuine booking
  // confirmations (subject says so), so we never act on stray airline mail
  // that merely happens to mention a flight number.
  const bookingConfirmation = kind === 'confirmation' && confirmSubjectHit;
  const forwardable = Boolean(airline && bookingConfirmation);

  return {
    airline: airline,
    kind: kind,
    forwardable: forwardable,
    bookingConfirmation: bookingConfirmation,
    score: score,
  };
}

/**
 * Tight query for booking confirmations only (by subject). Airlines send a
 * huge volume of check-in/menu/promo mail, so a sender-based search gets
 * crowded out past the result cap; matching confirmation subjects directly
 * keeps historical bookings findable. Used for backfill/sync and preview.
 */
function buildBookingQuery(windowDays) {
  return '-in:trash -in:spam -from:me newer_than:' + windowDays + 'd ' +
    'subject:("trip details" OR "flight receipt" OR "your itinerary" OR ' +
    '"itinerary confirmation" OR "trip confirmation" OR "e-ticket" OR ' +
    '"eticket" OR "booking confirmation" OR "flight confirmation" OR ' +
    '"award trip" OR "confirmation number" OR "you\'re booked" OR ' +
    '"amtrav booking" OR "trip is booked")';
}

/** Gmail search query for candidate messages. */
function buildSearchQuery(windowDays) {
  const domains = Object.keys(AIRLINE_SENDERS)
    .concat(cfg('EXTRA_SENDERS').split(',').map(function (s) { return s.trim(); }).filter(String));
  const fromClause = 'from:(' + domains.join(' OR ') + ')';
  const subjectClause = 'subject:("flight confirmation" OR "booking confirmation" OR ' +
    '"your itinerary" OR "e-ticket" OR "eticket" OR "flight receipt" OR ' +
    '"trip confirmation" OR "itinerary confirmation" OR "trip details" OR ' +
    '"award trip" OR "schedule change")';
  return '-in:trash -in:spam -from:me newer_than:' + windowDays + 'd ' +
    '(' + fromClause + ' OR ' + subjectClause + ')';
}
