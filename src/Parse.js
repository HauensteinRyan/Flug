/**
 * Best-effort extraction of flight details from a confirmation email.
 * This only feeds the Google Chat card — Flighty does its own (much
 * deeper) parsing of the forwarded original — so missing fields are fine.
 */

// IATA airline codes we recognize when matching bare flight numbers
// like "DL 1234". Restricting to a known set avoids matching things
// like "US 2026" or "NO 1".
const KNOWN_AIRLINE_CODES = [
  'DL', 'UA', 'AA', 'WN', 'AS', 'B6', 'HA', 'NK', 'F9', 'G4', 'AC', 'WS',
  'LH', 'LX', 'OS', 'SN', 'EW', 'BA', 'AF', 'KL', 'IB', 'VY', 'FR', 'W6',
  'TP', 'EI', 'AY', 'SK', 'DY', 'AZ', 'TK', 'EK', 'EY', 'QR', 'SQ', 'CX',
  'NH', 'JL', 'KE', 'BR', 'QF', 'NZ', 'LA', 'AV', 'CM', 'AM', 'Y4', 'VS',
];

function parseFlightInfo(subject, plainBody) {
  const text = (subject + '\n' + plainBody).slice(0, 30000);

  // Confirmation code / record locator: 5-8 alphanumerics containing at
  // least one letter (pure digits are usually ticket or phone numbers).
  // The label and code must sit on the same line, and the code must be
  // uppercase in the original text, so ordinary words after a label
  // ("...confirmation\nBooking...") don't get captured.
  let confirmationCode = null;
  const codeMatch = text.match(
    /(?:confirmation(?:[ \t]+(?:code|number|#))?|record[ \t]+locator|booking[ \t]+(?:reference|code|ref)|reservation[ \t]+(?:code|number)|\bPNR\b)[ \t]*(?:is|:|#|-)?[ \t]*([A-Za-z0-9]{5,8})(?![A-Za-z0-9])/i
  );
  if (codeMatch && /^[A-Z0-9]+$/.test(codeMatch[1]) && /[A-Z]/.test(codeMatch[1])) {
    confirmationCode = codeMatch[1];
  }

  // Flight numbers: "Flight 1234", "Flight DL 1234", or bare "DL1234"
  // with a known airline code.
  const flights = [];
  const seenFlights = {};
  function addFlight(code, num) {
    const label = (code ? code.toUpperCase() + ' ' : '') + parseInt(num, 10);
    if (!seenFlights[label] && flights.length < 8) {
      seenFlights[label] = true;
      flights.push(label);
    }
  }
  let m;
  const reExplicit = /\bflight\s*#?\s*:?\s*(?:([A-Z]{2})\s*)?(\d{1,4})\b/gi;
  while ((m = reExplicit.exec(text)) !== null) addFlight(m[1], m[2]);
  const reBare = /\b([A-Z]{2})\s?(\d{2,4})\b/g;
  while ((m = reBare.exec(text)) !== null) {
    if (KNOWN_AIRLINE_CODES.indexOf(m[1]) !== -1) addFlight(m[1], m[2]);
  }

  // Route: "SFO → JFK" style pairs first, then parenthesized "(SFO)" codes
  // in order of appearance.
  let route = null;
  const routeMatch = text.match(/\b([A-Z]{3})\s*(?:→|➔|->|—|–|\bto\b)\s*([A-Z]{3})\b/);
  if (routeMatch) {
    route = routeMatch[1] + ' → ' + routeMatch[2];
  } else {
    const codes = [];
    const reParen = /\(([A-Z]{3})\)/g;
    while ((m = reParen.exec(text)) !== null) {
      if (codes.indexOf(m[1]) === -1) codes.push(m[1]);
      if (codes.length >= 4) break;
    }
    if (codes.length >= 2) route = codes.join(' → ');
  }

  // Dates: "Mon, Aug 3" / "August 3, 2026" style, first few unique hits.
  const dates = [];
  const reDate = /\b(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?\b/g;
  while ((m = reDate.exec(text)) !== null) {
    const d = m[0].replace(/\s+/g, ' ').trim();
    if (dates.indexOf(d) === -1) dates.push(d);
    if (dates.length >= 4) break;
  }

  // Times: "8:15am" / "8:15 AM" / "20:15". Collected in order of appearance
  // so times[i] loosely pairs with dates[i] (airlines list segments in order).
  const times = [];
  const reTime = /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/gi;
  while ((m = reTime.exec(text)) !== null) {
    let hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    const meridiem = (m[3] || '').toLowerCase();
    if (hour > 23 || minute > 59) continue;
    if (meridiem.indexOf('p') === 0 && hour < 12) hour += 12;
    if (meridiem.indexOf('a') === 0 && hour === 12) hour = 0;
    times.push({ hour: hour, minute: minute });
    if (times.length >= 4) break;
  }

  return {
    confirmationCode: confirmationCode,
    flights: flights,
    route: route,
    dates: dates,
    times: times,
  };
}

/**
 * Turn a parsed date string (possibly year-less, e.g. "Sat, Aug 15") into a
 * Date, using the email's date to infer the year. A result more than ~2
 * months before the email was received rolls over to the next year
 * (December booking for a January trip).
 */
function resolveDate(dateStr, emailDate) {
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
                  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const m = dateStr.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  const day = parseInt(m[2], 10);
  let year = m[3] ? parseInt(m[3], 10) : emailDate.getFullYear();
  let d = new Date(year, month, day);
  if (!m[3] && d.getTime() < emailDate.getTime() - 60 * 24 * 60 * 60 * 1000) {
    d = new Date(year + 1, month, day);
  }
  return d;
}
