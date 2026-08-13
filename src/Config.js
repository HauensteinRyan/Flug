/**
 * Flug — flight info organizer.
 *
 * Configuration. Every value below is a default; you can override any of
 * them without editing code by adding a Script Property with the same name
 * (Apps Script editor → Project Settings → Script Properties).
 */
const DEFAULTS = {
  // Incoming-webhook URL of the Google Chat space to notify.
  // Chat space → space name menu → "Apps & integrations" → "Webhooks".
  // Leave empty to disable Chat notifications.
  CHAT_WEBHOOK_URL: '',

  // Forward matched confirmation emails to Flighty's email-import address.
  // Your Gmail address must be linked to your Flighty account
  // (Flighty app → Settings → Import Flights → Email Forwarding).
  FORWARD_TO_FLIGHTY: 'true',
  FLIGHTY_ADDRESS: 'track@my.flightyapp.com',

  // Create Google Calendar events for detected flights.
  ADD_TO_CALENDAR: 'true',
  // Calendar to add events to: empty = your default calendar, or a calendar
  // ID (Google Calendar → calendar settings → "Integrate calendar") to keep
  // flights in their own calendar.
  CALENDAR_ID: '',
  // Event length in hours when a departure time was parsed from the email.
  // (When no time is found, an all-day event is created instead.)
  FLIGHT_EVENT_HOURS: '3',

  // How far back (days) each scan looks. Already-processed messages are
  // remembered and skipped, so a small overlap window is all that's needed.
  SEARCH_WINDOW_DAYS: '4',

  // Minutes between automatic scans. Apps Script only allows
  // 1, 5, 10, 15 or 30 minutes, or whole hours (60, 120, ...).
  SCAN_INTERVAL_MINUTES: '30',

  // Extra sender domains or addresses to treat as airlines/booking sites,
  // comma separated. Example: 'navan.com, mycorporatetravel.example'
  EXTRA_SENDERS: '',
};

// Gmail label applied to processed threads (visual marker only; dedupe is
// tracked by message ID, so relabeling/removing the label is harmless).
const PROCESSED_LABEL = 'Flug/Processed';

// Script-property key holding recently processed message IDs.
const PROCESSED_IDS_KEY = 'FLUG_PROCESSED_IDS';
const MAX_TRACKED_IDS = 750;

/** Read a config value: Script Property if set, otherwise the default. */
function cfg(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v !== null && v !== '' ? v : (DEFAULTS[key] || '');
}

function cfgBool(key) {
  return String(cfg(key)).trim().toLowerCase() === 'true';
}

function cfgInt(key, fallback) {
  const n = parseInt(cfg(key), 10);
  return isNaN(n) ? fallback : n;
}
