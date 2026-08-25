/**
 * Google Calendar sync — one tied-together event per trip.
 *
 * Instead of a marker per flight, each trip becomes a single multi-day
 * all-day event spanning the whole journey (first departure through final
 * arrival), so the days you're in a place are part of the same block. The
 * events live in a dedicated green "Flights" calendar (its own on/off group
 * and color), carry no reminders, and the calendar can be auto-shared with
 * someone.
 *
 * Config: ADD_TO_CALENDAR, FLIGHT_CALENDAR_NAME, SHARE_CALENDAR_WITH,
 * CALENDAR_ID (optional: use an existing calendar instead of the dedicated one).
 */

const FLUG_CAL_ID_KEY = 'FLUG_CALENDAR_ID';
const FLUG_CAL_SHARED_KEY = 'FLUG_CAL_SHARED_WITH';
const FLUG_CAL_TRIPS_KEY = 'FLUG_CAL_TRIPS';

/** Get (or create) the dedicated Flights calendar; share it once if asked. */
function getFlugCalendar_() {
  const props = PropertiesService.getScriptProperties();

  const override = cfg('CALENDAR_ID');
  if (override) {
    const c = CalendarApp.getCalendarById(override);
    if (!c) console.error('CALENDAR_ID not found: ' + override);
    return c;
  }

  let id = props.getProperty(FLUG_CAL_ID_KEY);
  let cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    cal = CalendarApp.createCalendar(cfg('FLIGHT_CALENDAR_NAME') || 'Flights');
    try { cal.setColor(CalendarApp.Color.GREEN); } catch (e) {}
    props.setProperty(FLUG_CAL_ID_KEY, cal.getId());
  }

  // Auto-share (read-only) with one person, once per address.
  const shareWith = cfg('SHARE_CALENDAR_WITH');
  if (shareWith && props.getProperty(FLUG_CAL_SHARED_KEY) !== shareWith) {
    try {
      Calendar.Acl.insert({ role: 'reader', scope: { type: 'user', value: shareWith } }, cal.getId());
      props.setProperty(FLUG_CAL_SHARED_KEY, shareWith);
      console.log('Shared the Flights calendar with ' + shareWith + '.');
    } catch (e) {
      console.error('Could not auto-share the calendar (' + e + '). Enable the Calendar advanced service, or share it manually.');
    }
  }
  return cal;
}

/** Run manually to create the green Flights calendar and share it now. */
function setupCalendar() {
  const cal = getFlugCalendar_();
  if (cal) console.log('Flights calendar ready: "' + cal.getName() + '" (' + cal.getId() + ').');
}

/**
 * Create one trip-spanning all-day event from the extracted segments.
 * Returns 1 if an event was created, else 0.
 */
function addTripToCalendar(segments, gmailLink) {
  if (!cfgBool('ADD_TO_CALENDAR') || !segments || !segments.length) return 0;

  // Trip span from segment dates.
  const deps = segments.map(function (s) { return s.depDate; }).filter(Boolean);
  const arrs = segments.map(function (s) { return s.arrTime || s.depDate; }).filter(Boolean);
  if (!deps.length) return 0;
  const start = new Date(Math.min.apply(null, deps.map(function (d) { return d.getTime(); })));
  const endArr = new Date(Math.max.apply(null, arrs.map(function (d) { return d.getTime(); })));
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endDay = new Date(endArr.getFullYear(), endArr.getMonth(), endArr.getDate());

  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (endDay < today) return 0; // don't clutter with past trips

  const tripKey = segments[0].confirmation || segments[0].key || (segments[0].flightNo + '|' + segments[0].origin);
  const done = loadCalTrips_();
  if (done.ids[tripKey]) return 0;

  const cal = getFlugCalendar_();
  if (!cal) return 0;

  // Title: A ⇄ B for a round trip, else A → final.
  const origin = segments[0].origin, finalDest = segments[segments.length - 1].dest;
  const returnsHome = finalDest && origin && finalDest === origin;
  let far = finalDest, maxStay = -1;
  for (let i = 0; i < segments.length - 1; i++) {
    const a = segments[i].arrTime, d = segments[i + 1].depTime;
    if (a && d && d - a > maxStay) { maxStay = d - a; far = segments[i].dest; }
  }
  const title = '✈️ ' + origin + (returnsHome ? ' ⇄ ' + far : ' → ' + finalDest);

  const lines = segments.map(function (s) {
    return (s.dateStr || '') + '  ' + (s.flightNo || '') + '  ' + s.origin + '→' + s.dest +
      (s.depTimeStr ? '  ' + s.depTimeStr : '');
  });
  if (segments[0].confirmation) lines.push('', 'Confirmation: ' + segments[0].confirmation);
  if (gmailLink) lines.push('', gmailLink);
  lines.push('', '(added by Flug)');

  // End date is exclusive for multi-day all-day events.
  const endExclusive = new Date(endDay.getFullYear(), endDay.getMonth(), endDay.getDate() + 1);
  const ev = cal.createAllDayEvent(title, startDay, endExclusive, { description: lines.join('\n') });
  try { ev.removeAllReminders(); } catch (e) {}

  done.ids[tripKey] = true; done.order.push(tripKey);
  saveCalTrips_(done);
  return 1;
}

/**
 * Backfill trip events from already-stored flights (upcoming trips), so you
 * don't have to wait for the next booking email. Run once after enabling.
 */
function syncCalendar() {
  if (!cfgBool('ADD_TO_CALENDAR')) { console.log('ADD_TO_CALENDAR is off.'); return; }
  const flights = readFlights().filter(function (f) { return !f.hidden; });
  const trips = {};
  flights.forEach(function (f) {
    const id = f.trip || f.confirmation || (f.flightNo + '|' + f.date);
    (trips[id] = trips[id] || []).push(f);
  });
  let made = 0;
  Object.keys(trips).forEach(function (id) {
    const segs = trips[id].slice()
      .sort(function (a, b) { return String(a.departISO) < String(b.departISO) ? -1 : 1; })
      .map(function (f) {
        const dep = f.departISO ? new Date(f.departISO) : null;
        const arr = f.arriveISO ? new Date(f.arriveISO) : null;
        return {
          origin: f.origin, dest: f.dest, flightNo: f.flightNo, dateStr: f.date,
          depTimeStr: f.depart, confirmation: f.confirmation,
          depDate: dep, depTime: dep, arrTime: arr,
        };
      });
    made += addTripToCalendar(segs, '');
  });
  console.log('Calendar sync: ' + made + ' new trip event(s) added.');
}

function loadCalTrips_() {
  const raw = PropertiesService.getScriptProperties().getProperty(FLUG_CAL_TRIPS_KEY);
  const order = raw ? JSON.parse(raw) : [];
  const ids = {};
  order.forEach(function (k) { ids[k] = true; });
  return { ids: ids, order: order };
}

function saveCalTrips_(done) {
  PropertiesService.getScriptProperties()
    .setProperty(FLUG_CAL_TRIPS_KEY, JSON.stringify(done.order.slice(-500)));
}
