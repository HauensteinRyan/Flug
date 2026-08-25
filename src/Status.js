/**
 * Live flight status via AeroDataBox (RapidAPI). Enriches near-term flights
 * with status / delay / gate / terminal. Quota-safe by design:
 *   - only flights departing within STATUS_WINDOW_HOURS (and up to 6h past)
 *   - one request per second (provider limit)
 *   - writes ONLY on success; on quota (429) or error it stops/skips and
 *     leaves the last-known values in place, so the app never blanks out.
 *
 * Set FLIGHT_API_KEY (Script Property) to your RapidAPI key to enable.
 */

function refreshStatus() {
  // Trim whitespace and any stray surrounding quotes pasted with the key.
  const key = (cfg('FLIGHT_API_KEY') || '').trim().replace(/^['"]+|['"]+$/g, '');
  if (!key) { console.log('Live status off: set the FLIGHT_API_KEY script property to enable.'); return; }
  const host = cfg('FLIGHT_API_HOST') || 'aerodatabox.p.rapidapi.com';

  const now = Date.now();
  const windowMs = cfgInt('STATUS_WINDOW_HOURS', 48) * 3600000;
  const soon = now + windowMs, back = now - 6 * 3600000;

  const targets = readFlights().filter(function (f) {
    if (!f.flightNo || !f.origin || !f.departISO) return false;
    const d = new Date(f.departISO).getTime();
    return !isNaN(d) && d >= back && d <= soon;
  });

  let calls = 0, updated = 0;
  for (let i = 0; i < targets.length; i++) {
    const f = targets[i];
    const fn = f.flightNo.replace(/\s+/g, '');       // "DL 2905" -> "DL2905"
    const date = f.departISO.slice(0, 10);           // yyyy-MM-dd
    const url = 'https://' + host + '/flights/number/' + encodeURIComponent(fn) + '/' + date +
      '?withAircraftImage=false&withLocation=false';

    let resp;
    try {
      resp = UrlFetchApp.fetch(url, {
        method: 'get', muteHttpExceptions: true,
        headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host },
      });
    } catch (e) { console.error('Status fetch error for ' + fn + ': ' + e); break; }
    calls++;

    const code = resp.getResponseCode();
    if (code === 429) { console.warn('Quota reached (429) — keeping last-known status.'); break; }
    if (code === 204) { writeStatus_(f.key, { status: 'Unverified', updated: new Date() }); Utilities.sleep(1100); continue; }
    if (code >= 400) { console.warn('Status ' + code + ' for ' + fn + ': ' + resp.getContentText().slice(0, 200)); Utilities.sleep(1100); continue; }

    let data;
    try { data = JSON.parse(resp.getContentText()); } catch (e) { Utilities.sleep(1100); continue; }
    const list = Array.isArray(data) ? data : (data && data.flights) ? data.flights : [];
    const leg = pickLeg_(list, f.origin);
    if (leg) { const st = parseStatus_(leg); maybeAlert_(f, st); writeStatus_(f.key, st); updated++; }
    else { writeStatus_(f.key, { status: 'Unverified', updated: new Date() }); }

    Utilities.sleep(1100); // respect ~1 request/second
  }

  console.log('Status refresh: ' + targets.length + ' near-term flight(s), ' + calls + ' API call(s), ' + updated + ' updated.');
}

/**
 * Email yourself when a flight's status meaningfully changes — a new delay,
 * cancellation, boarding, or gate change. Compares the new reading against
 * what was stored, and only fires on a real transition (so a flight that
 * stays "Delayed" each hour doesn't re-notify).
 */
function maybeAlert_(f, st) {
  if (!cfgBool('ALERTS_ENABLED')) return;
  const oldInfo = statusInfo_({ liveStatus: f.liveStatus, delayMin: f.delayMin });
  const newInfo = statusInfo_({ liveStatus: st.status, delayMin: st.delay });
  const oldLabel = oldInfo ? oldInfo.label : '';
  const newLabel = newInfo ? newInfo.label : '';
  const gateChanged = st.gate && f.liveGate && st.gate !== f.liveGate;
  const notable = newInfo && (newInfo.cls === 'warn' || newInfo.cls === 'crit' || newInfo.cls === 'accent');
  if (!((newLabel && newLabel !== oldLabel && notable) || gateChanged)) return;

  try {
    const to = Session.getEffectiveUser().getEmail();
    if (!to) return;
    const subject = '✈ ' + f.flightNo + ' ' + f.origin + '→' + f.dest + ': ' + newLabel +
      (gateChanged ? ' · gate ' + st.gate : '');
    const body = [
      f.flightNo + '   ' + f.origin + ' → ' + f.dest,
      (f.date || '') + (f.depart ? '  ·  ' + f.depart : ''),
      '',
      'Now: ' + newLabel,
      st.gate ? 'Gate: ' + st.gate : '',
      st.terminal ? 'Terminal: ' + st.terminal : '',
      '',
      '— Flug live update',
    ].filter(function (x) { return x !== ''; }).join('\n');
    GmailApp.sendEmail(to, subject, body);
    console.log('Alert emailed: ' + subject);
  } catch (e) { console.error('Alert email failed: ' + e); }
}

/** Log the live-status values stored for each flight (to verify the data). */
function checkStatus() {
  let any = 0;
  readFlights().forEach(function (f) {
    if (f.liveStatus || f.statusUpdated) {
      any++;
      console.log(f.flightNo + '  ' + f.origin + '→' + f.dest + '  ' + f.date +
        '  | status="' + f.liveStatus + '" delay=' + f.delayMin + ' gate=' + f.liveGate +
        ' updated=' + f.statusUpdated);
    }
  });
  console.log(any ? '(' + any + ' row(s) with stored status above)' : 'No stored status found yet — run refreshStatus.');
}

/** From the API's list of matching flights, pick the leg leaving our origin. */
function pickLeg_(list, origin) {
  for (let i = 0; i < list.length; i++) {
    const dep = list[i].departure || {};
    const ap = dep.airport || {};
    const iata = String(ap.iata || ap.iataCode || '').toUpperCase();
    if (!origin || iata === origin) return list[i];
  }
  return list.length ? list[0] : null;
}

function parseStatus_(leg) {
  const dep = leg.departure || {};
  const sched = apdbTime_(dep.scheduledTime);
  const rev = apdbTime_(dep.revisedTime) || apdbTime_(dep.runwayTime) || apdbTime_(dep.predictedTime);
  let delay = null;
  if (sched && rev) delay = Math.round((rev - sched) / 60000);
  return {
    status: String(leg.status || '').trim(),
    delay: delay,
    gate: String(dep.gate || '').trim(),
    terminal: String(dep.terminal || '').trim(),
    updated: new Date(),
  };
}

/** AeroDataBox time object -> Date. Fields look like {utc:"2026-08-24 16:45Z"}. */
function apdbTime_(t) {
  if (!t) return null;
  const s = t.utc || t.local;
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}
