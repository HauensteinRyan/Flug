/**
 * Flight store — a Google Sheet that acts as the app's database.
 *
 * One row per flight segment, de-duplicated by a stable key (flight + route
 * + day) so the same flight seen via AmTrav and via Delta merges into one
 * row. On merge, fields are combined: a non-empty value from either source
 * is kept, so the richer email (AmTrav has seat/cabin/aircraft) isn't wiped
 * by a sparser one.
 */

const SHEET_ID_KEY = 'FLUG_SHEET_ID';
const SHEET_TAB = 'Flights';
const SHEET_HEADERS = [
  'Key', 'Trip', 'Confirmation', 'Airline', 'FlightNo', 'Origin', 'Dest',
  'Date', 'Depart', 'Arrive', 'DepartISO', 'ArriveISO',
  'Seat', 'Cabin', 'Aircraft', 'Duration', 'DepTerminal', 'ArrTerminal',
  'Source', 'Updated',
];
const COL = SHEET_HEADERS.length;

/** Find (or create) the Flug Flights spreadsheet and return its Flights tab. */
function getFlightSheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(SHEET_ID_KEY);
  let ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Flug Flights');
    props.setProperty(SHEET_ID_KEY, ss.getId());
  }
  let sheet = ss.getSheetByName(SHEET_TAB);
  if (!sheet) {
    sheet = ss.getSheets()[0];
    sheet.setName(SHEET_TAB);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, COL).setValues([SHEET_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function segmentKey_(seg) {
  const day = seg.depDate ? Utilities.formatDate(seg.depDate, Session.getScriptTimeZone(), 'yyyy-MM-dd')
    : (seg.dateStr || '');
  return [seg.flightNo || '', seg.origin || '', seg.dest || '', day].join('|');
}

/** Clear all stored flights and refresh the header. Rebuild with syncNow. */
function resetFlights() {
  const sheet = getFlightSheet_();
  const last = sheet.getLastRow();
  if (last > 1) sheet.deleteRows(2, last - 1);
  sheet.getRange(1, 1, 1, COL).setValues([SHEET_HEADERS]); // refresh to current schema
  console.log('Cleared stored flights. Run syncNow to rebuild.');
}

/**
 * Insert or update rows for the given segments, merging fields on an existing
 * key. Returns the number of newly added rows.
 */
function upsertFlights(segments) {
  if (!segments || !segments.length) return 0;
  const sheet = getFlightSheet_();
  const tz = Session.getScriptTimeZone();

  const lastRow = sheet.getLastRow();
  const data = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, COL).getValues() : [];
  const rowOf = {};
  data.forEach(function (r, i) { rowOf[r[0]] = i + 2; });

  const now = new Date();
  let added = 0;

  segments.forEach(function (seg) {
    if (!seg.flightNo && !seg.origin && !seg.dest) return;
    const key = segmentKey_(seg);
    const dateDisp = seg.dateStr || (seg.depDate ? Utilities.formatDate(seg.depDate, tz, 'MMM d') : '');
    const depISO = seg.depTime ? Utilities.formatDate(seg.depTime, tz, "yyyy-MM-dd'T'HH:mm")
      : (seg.depDate ? Utilities.formatDate(seg.depDate, tz, "yyyy-MM-dd'T'00:00") : '');
    const arrISO = seg.arrTime ? Utilities.formatDate(seg.arrTime, tz, "yyyy-MM-dd'T'HH:mm") : '';

    const row = [
      key, seg.confirmation || '', seg.confirmation || '', seg.airline || '',
      seg.flightNo || '', seg.origin || '', seg.dest || '',
      dateDisp, seg.depTimeStr || '', seg.arrTimeStr || '', depISO, arrISO,
      seg.seat || '', seg.cabin || '', seg.aircraft || '', seg.duration || '',
      seg.depTerminal || '', seg.arrTerminal || '', seg.source || '', now,
    ];

    if (rowOf[key]) {
      const existing = data[rowOf[key] - 2];
      const merged = row.map(function (v, idx) {
        if (idx === COL - 1) return now;            // Updated: always now
        if (idx === 0) return v;                    // Key: unchanged
        const nv = v == null ? '' : String(v).trim();
        const ov = existing[idx];
        return nv !== '' ? v : ov;                  // keep new if present, else old
      });
      sheet.getRange(rowOf[key], 1, 1, COL).setValues([merged]);
      existing.splice(0, existing.length, ...merged); // keep snapshot current
    } else {
      sheet.appendRow(row);
      rowOf[key] = sheet.getLastRow();
      data.push(row);
      added++;
    }
  });

  return added;
}

/** Read all stored flights as plain objects. */
function readFlights() {
  const sheet = getFlightSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const tz = Session.getScriptTimeZone();
  const values = sheet.getRange(2, 1, lastRow - 1, COL).getValues();

  // Sheets may auto-convert date/time-looking cells to Date objects.
  function s(v) { return v == null ? '' : (v instanceof Date ? Utilities.formatDate(v, tz, 'MMM d') : String(v)); }
  function t(v) { return v == null ? '' : (v instanceof Date ? Utilities.formatDate(v, tz, 'h:mm a') : String(v)); }
  function iso(v) { return v == null ? '' : (v instanceof Date ? Utilities.formatDate(v, tz, "yyyy-MM-dd'T'HH:mm") : String(v)); }

  return values.map(function (r) {
    return {
      key: String(r[0]), trip: String(r[1]), confirmation: String(r[2]),
      airline: String(r[3]), flightNo: String(r[4]),
      origin: String(r[5]), dest: String(r[6]),
      date: s(r[7]), depart: t(r[8]), arrive: t(r[9]),
      departISO: iso(r[10]), arriveISO: iso(r[11]),
      seat: String(r[12]), cabin: String(r[13]), aircraft: String(r[14]),
      duration: String(r[15]), depTerminal: String(r[16]), arrTerminal: String(r[17]),
      source: String(r[18]), updated: r[19],
    };
  }).filter(function (f) { return f.flightNo || f.origin || f.dest; });
}

/** URL of the underlying spreadsheet (handy for a quick manual look). */
function flightSheetUrl() {
  const sheet = getFlightSheet_();
  const url = sheet.getParent().getUrl();
  console.log('Flug Flights sheet: ' + url);
  return url;
}
