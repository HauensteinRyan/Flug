/**
 * Live aircraft positions from the OpenSky Network (free, no key). While a
 * flight is airborne, look up its position by callsign within the route's
 * bounding box and store it, so the globe can show a live plane marker.
 *
 * Best-effort: OpenSky is ADS-B coverage, so a plane over open ocean or a
 * low-coverage area may not appear. Runs every ~5 minutes but does nothing
 * (and makes no request) unless a flight is currently in the air.
 */

// IATA -> ICAO callsign prefix for building OpenSky callsigns ("DL"->"DAL").
const AIRLINE_ICAO = {
  DL: 'DAL', UA: 'UAL', AA: 'AAL', WN: 'SWA', AS: 'ASA', B6: 'JBU', NK: 'NKS',
  F9: 'FFT', HA: 'HAL', G4: 'AAY', AC: 'ACA', WS: 'WJA', LH: 'DLH', LX: 'SWR',
  OS: 'AUA', SN: 'BEL', BA: 'BAW', AF: 'AFR', KL: 'KLM', IB: 'IBE', EI: 'EIN',
  AY: 'FIN', SK: 'SAS', AZ: 'ITY', TP: 'TAP', TK: 'THY', EK: 'UAE', QR: 'QTR',
  SQ: 'SIA', CX: 'CPA', NH: 'ANA', JL: 'JAL', KE: 'KAL', BR: 'EVA', QF: 'QFA',
  NZ: 'ANZ', LA: 'LAN', AV: 'AVA', CM: 'CMP', AM: 'AMX',
};

function refreshPositions() {
  const now = Date.now();
  const coords = (typeof AIRPORT_COORDS !== 'undefined') ? AIRPORT_COORDS : {};

  const inAir = readFlights().filter(function (f) {
    if (f.hidden || !f.flightNo || !f.origin || !f.dest || !f.departISO) return false;
    const dep = new Date(f.departISO).getTime();
    const arr = f.arriveISO ? new Date(f.arriveISO).getTime() : dep + 3 * 3600000;
    return !isNaN(dep) && now >= dep - 15 * 60000 && now <= arr + 30 * 60000;
  });
  if (!inAir.length) { console.log('No flights in the air right now — nothing to locate.'); return; }

  let found = 0;
  for (let i = 0; i < inAir.length; i++) {
    const f = inAir[i];
    const cs = callsign_(f.flightNo);
    const o = coords[f.origin], d = coords[f.dest];
    if (!cs || !o || !d) continue;

    const b = bbox_(o, d);
    const url = 'https://opensky-network.org/api/states/all?lamin=' + b.lamin +
      '&lomin=' + b.lomin + '&lamax=' + b.lamax + '&lomax=' + b.lomax;
    let resp;
    try { resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true }); }
    catch (e) { console.error('OpenSky fetch failed: ' + e); break; }
    if (resp.getResponseCode() >= 400) { console.warn('OpenSky ' + resp.getResponseCode() + ' — skipping (position kept).'); Utilities.sleep(1500); continue; }

    let data;
    try { data = JSON.parse(resp.getContentText()); } catch (e) { Utilities.sleep(1500); continue; }
    const states = (data && data.states) || [];
    let pos = null;
    for (let s = 0; s < states.length; s++) {
      const st = states[s];
      if (String(st[1] || '').trim().toUpperCase() === cs && st[8] !== true && st[5] != null && st[6] != null) {
        pos = [st[6], st[5]]; break; // [lat, lon]
      }
    }
    if (pos) { writePosition_(f.key, pos[0], pos[1]); found++; console.log('Located ' + f.flightNo + ' at ' + pos[0].toFixed(2) + ', ' + pos[1].toFixed(2)); }
    Utilities.sleep(1500);
  }
  console.log('Positions: ' + inAir.length + ' in-air candidate(s), ' + found + ' located.');
}

function callsign_(flightNo) {
  const m = String(flightNo).trim().match(/^([A-Z]{2})\s?(\d{1,4})$/);
  if (!m) return '';
  const icao = AIRLINE_ICAO[m[1]];
  return icao ? icao + parseInt(m[2], 10) : '';
}

function bbox_(o, d) {
  const m = 2.5; // degrees of margin around the route
  return {
    lamin: Math.min(o[0], d[0]) - m, lamax: Math.max(o[0], d[0]) + m,
    lomin: Math.min(o[1], d[1]) - m, lomax: Math.max(o[1], d[1]) + m,
  };
}
