/**
 * Flight store — a Google Sheet that acts as the app's database.
 *
 * One row per flight segment, de-duplicated by a stable key so re-scanning
 * the same email never creates duplicates (it updates the existing row).
 * The web app reads straight from this sheet, so new bookings appear the
 * next time anyone opens the shared URL.
 */

const SHEET_ID_KEY = 'FLUG_SHEET_ID';
const SHEET_TAB = 'Flights';
const SHEET_HEADERS = [
  'Key', 'Trip', 'Confirmation', 'Airline', 'FlightNo',
  'Origin', 'Dest', 'Date', 'Depart', 'Arrive', 'DepartISO', 'Source', 'Updated',
];

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
    sheet.getRange(1, 1, 1, SHEET_HEADERS.length).setValues([SHEET_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function segmentKey_(seg) {
  const day = seg.depDate ? Utilities.formatDate(seg.depDate, Session.getScriptTimeZone(), 'yyyy-MM-dd')
    : (seg.dateStr || '');
  return [seg.confirmation || '', seg.flightNo || '', seg.origin || '', seg.dest || '', day].join('|');
}

/**
 * Insert or update rows for the given segments. Returns the number of
 * segments that were newly added (updates don't count as added).
 */
function upsertFlights(segments) {
  if (!segments || !segments.length) return 0;
  const sheet = getFlightSheet_();
  const tz = Session.getScriptTimeZone();

  const lastRow = sheet.getLastRow();
  const existing = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function (r) { return r[0]; })
    : [];
  const rowOf = {};
  existing.forEach(function (k, i) { rowOf[k] = i + 2; });

  const now = new Date();
  let added = 0;

  segments.forEach(function (seg) {
    if (!seg.flightNo && !seg.origin && !seg.dest) return;
    const key = segmentKey_(seg);
    const dateDisp = seg.dateStr ||
      (seg.depDate ? Utilities.formatDate(seg.depDate, tz, 'MMM d') : '');
    const iso = seg.depTime ? Utilities.formatDate(seg.depTime, tz, "yyyy-MM-dd'T'HH:mm")
      : (seg.depDate ? Utilities.formatDate(seg.depDate, tz, "yyyy-MM-dd'T'00:00") : '');
    const row = [
      key, seg.confirmation || '', seg.confirmation || '', seg.airline || '',
      seg.flightNo || '', seg.origin || '', seg.dest || '',
      dateDisp, seg.depTimeStr || '', seg.arrTimeStr || '', iso, seg.source || '', now,
    ];
    if (rowOf[key]) {
      sheet.getRange(rowOf[key], 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
      rowOf[key] = sheet.getLastRow();
      added++;
    }
  });

  return added;
}

/** Read all stored flights as plain objects (newest-scan values). */
function readFlights() {
  const sheet = getFlightSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, SHEET_HEADERS.length).getValues();
  return values.map(function (r) {
    return {
      key: r[0], trip: r[1], confirmation: r[2], airline: r[3], flightNo: r[4],
      origin: r[5], dest: r[6], date: r[7], depart: r[8], arrive: r[9],
      departISO: r[10], source: r[11], updated: r[12],
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
