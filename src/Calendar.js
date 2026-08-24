/**
 * Google Calendar events for detected flights — a coarse "you're flying
 * this day" marker; Flighty holds the precise times, gates, and seats.
 *
 * One ALL-DAY event per unique upcoming travel date in the email. All-day
 * (rather than timed) is deliberate: airline emails list several times
 * (check-in, depart, arrive, connection) with no reliable way to tell which
 * is the departure, so a timed event would often be wrong — a day marker
 * never is. Only future dates are used, which also discards footer/fare
 * dates and other junk a wide parse might pick up.
 *
 * Note: Gmail/Calendar's built-in "Events from Gmail" feature can also do
 * this for many airlines — Flug's version works regardless of that setting
 * and can target a dedicated calendar via CALENDAR_ID.
 */

function addToCalendar(message, parsed, meta) {
  if (!cfgBool('ADD_TO_CALENDAR') || parsed.dates.length === 0) return 0;

  const calId = cfg('CALENDAR_ID');
  const cal = calId ? CalendarApp.getCalendarById(calId) : CalendarApp.getDefaultCalendar();
  if (!cal) {
    console.error('Calendar not found: ' + calId + ' (check CALENDAR_ID and that the calendar is shared with this account).');
    return 0;
  }

  const gmailLink = 'https://mail.google.com/mail/u/0/#all/' + message.getId();
  const description = [
    meta.airline ? 'Airline: ' + meta.airline : null,
    parsed.route ? 'Route: ' + parsed.route : null,
    parsed.flights.length ? 'Flight(s): ' + parsed.flights.join(', ') : null,
    parsed.confirmationCode ? 'Confirmation code: ' + parsed.confirmationCode : null,
    'Email: ' + gmailLink,
    '(added by Flug)',
  ].filter(String).join('\n');

  // One title for the whole trip (route if known, else first flight).
  const title = '✈️ ' + (
    parsed.route ? parsed.route :
    parsed.flights.length ? 'Flight ' + parsed.flights[0] :
    'Flight' + (meta.airline ? ' — ' + meta.airline : '')
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const seenDays = {};
  let created = 0;

  parsed.dates.forEach(function (dateStr) {
    const day = resolveDate(dateStr, message.getDate());
    if (!day) return;
    if (day < today) return; // skip past trips and junk footer/fare dates

    const key = day.getFullYear() + '-' + day.getMonth() + '-' + day.getDate();
    if (seenDays[key]) return; // one event per calendar day
    seenDays[key] = true;

    // Skip if an identically titled event already exists that day
    // (a re-sent or updated confirmation for the same booking).
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const exists = cal.getEvents(dayStart, dayEnd).some(function (ev) {
      return ev.getTitle() === title;
    });
    if (exists) return;

    cal.createAllDayEvent(title, day, { description: description });
    created++;
  });

  return created;
}
