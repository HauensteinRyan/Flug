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
  'LiveStatus', 'DelayMin', 'LiveGate', 'LiveTerminal', 'StatusUpdated',
  'Hidden',
  'LiveLat', 'LiveLon', 'PosUpdated',
];
const COL = SHEET_HEADERS.length;
const IDX_UPDATED = 19;          // 'Updated' column (0-based)
const IDX_STATUS = 20;           // first live-status column (0-based); 1-based = 21
const IDX_HIDDEN = 25;           // 'Hidden' column (0-based); 1-based = 26
const IDX_POS = 26;              // 'LiveLat' column (0-based); 1-based = 27

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
  } else if (sheet.getLastColumn() < COL) {
    sheet.getRange(1, 1, 1, COL).setValues([SHEET_HEADERS]); // extend header for new columns
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
 * key. Batched: reads the sheet once and writes once, so it stays fast even
 * for a full-history sync. Returns the number of newly added rows.
 */
function upsertFlights(segments) {
  if (!segments || !segments.length) return 0;
  const sheet = getFlightSheet_();
  const tz = Session.getScriptTimeZone();

  const lastRow = sheet.getLastRow();
  const rows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, COL).getValues() : [];
  const idxOf = {};
  rows.forEach(function (r, i) { idxOf[r[0]] = i; });

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
      '', '', '', '', '', // live-status columns — filled by refreshStatus, preserved on merge
      '', // Hidden — set by manual erase, preserved on merge
      '', '', '', // LiveLat, LiveLon, PosUpdated — filled by refreshPositions
    ];

    if (key in idxOf) {
      const ex = rows[idxOf[key]];
      rows[idxOf[key]] = row.map(function (v, idx) {
        if (idx === IDX_UPDATED) return now; // Updated: always now
        if (idx === 0) return v;             // Key: unchanged
        const nv = v == null ? '' : String(v).trim();
        return nv !== '' ? v : ex[idx];      // keep new if present, else old
      });
    } else {
      rows.push(row);
      idxOf[key] = rows.length - 1;
      added++;
    }
  });

  if (rows.length) sheet.getRange(2, 1, rows.length, COL).setValues(rows);
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
      liveStatus: String(r[20] || ''), delayMin: String(r[21] || ''),
      liveGate: String(r[22] || ''), liveTerminal: String(r[23] || ''),
      statusUpdated: r[24] || '',
      hidden: String(r[25] || '').toUpperCase() === 'TRUE',
      liveLat: r[26] === '' || r[26] == null ? null : Number(r[26]),
      liveLon: r[27] === '' || r[27] == null ? null : Number(r[27]),
      posUpdated: r[28] || '',
    };
  }).filter(function (f) { return f.flightNo || f.origin || f.dest; });
}

/** Store a live aircraft position for one flight row (by key). */
function writePosition_(key, lat, lon) {
  const sheet = getFlightSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < keys.length; i++) {
    if (keys[i][0] === key) {
      sheet.getRange(i + 2, IDX_POS + 1, 1, 3).setValues([[lat, lon, new Date()]]);
      return true;
    }
  }
  return false;
}

/** Mark a flight hidden (manual erase). Survives re-sync (merge preserves it). */
function hideFlight_(key) {
  const sheet = getFlightSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < keys.length; i++) {
    if (keys[i][0] === key) { sheet.getRange(i + 2, IDX_HIDDEN + 1).setValue('TRUE'); return true; }
  }
  return false;
}

/** Write the live-status columns for one flight row (by key). No-op if absent. */
function writeStatus_(key, st) {
  const sheet = getFlightSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < keys.length; i++) {
    if (keys[i][0] === key) {
      sheet.getRange(i + 2, IDX_STATUS + 1, 1, 5).setValues([[
        st.status || '', st.delay == null ? '' : st.delay,
        st.gate || '', st.terminal || '', st.updated || new Date(),
      ]]);
      return true;
    }
  }
  return false;
}

/** URL of the underlying spreadsheet (handy for a quick manual look). */
function flightSheetUrl() {
  const sheet = getFlightSheet_();
  const url = sheet.getParent().getUrl();
  console.log('Flug Flights sheet: ' + url);
  return url;
}
