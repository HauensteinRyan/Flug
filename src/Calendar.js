/**
 * Google Calendar events for detected flights.
 *
 * One event per parsed travel date, best-effort paired with the flight
 * number and time listed in the same position in the email (airlines list
 * segments in order). With a parsed departure time the event is a timed
 * block (FLIGHT_EVENT_HOURS long); otherwise it's an all-day event.
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
    parsed.confirmationCode ? 'Confirmation code: ' + parsed.confirmationCode : null,
    'Email: ' + gmailLink,
    '(added by Flug)',
  ].filter(String).join('\n');

  const durationMs = cfgInt('FLIGHT_EVENT_HOURS', 3) * 60 * 60 * 1000;
  let created = 0;

  parsed.dates.forEach(function (dateStr, i) {
    const day = resolveDate(dateStr, message.getDate());
    if (!day) return;

    const flight = parsed.flights[i] || parsed.flights[0] || null;
    const title = '✈️ ' +
      (flight ? 'Flight ' + flight : 'Flight') +
      (meta.airline && !flight ? ' — ' + meta.airline : '') +
      (parsed.route && i === 0 ? ' (' + parsed.route + ')' : '');

    // Skip if an identically titled event already exists that day
    // (updated/duplicate confirmation emails for the same booking).
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const existing = cal.getEvents(dayStart, dayEnd).some(function (ev) {
      return ev.getTitle() === title;
    });
    if (existing) return;

    const time = parsed.times[i];
    if (time) {
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.hour, time.minute);
      cal.createEvent(title, start, new Date(start.getTime() + durationMs), { description: description });
    } else {
      cal.createAllDayEvent(title, day, { description: description });
    }
    created++;
  });

  return created;
}
