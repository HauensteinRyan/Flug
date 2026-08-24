/**
 * Flug — entry points.
 *
 * setup()          run once: seeds config, creates the Gmail label and the
 *                  recurring trigger.
 * runFlightScan()  the scheduled job (also fine to run manually).
 * backfill(days)   one-off: forward historical confirmations to Flighty
 *                  without posting them to Chat.
 * dryRun(days)     test: log what a scan WOULD do, with no side effects.
 * sendTestMessage() (in Chat.js) verify the webhook.
 */

function setup() {
  // Seed script properties with the defaults so they're visible/editable
  // in Project Settings → Script Properties without touching code.
  const props = PropertiesService.getScriptProperties();
  for (const key in DEFAULTS) {
    if (props.getProperty(key) === null) props.setProperty(key, DEFAULTS[key]);
  }

  getOrCreateLabel_();

  // Recreate the time-based trigger.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runFlightScan') ScriptApp.deleteTrigger(t);
  });
  const minutes = cfgInt('SCAN_INTERVAL_MINUTES', 30);
  const builder = ScriptApp.newTrigger('runFlightScan').timeBased();
  if (minutes >= 60) {
    builder.everyHours(Math.max(1, Math.round(minutes / 60))).create();
  } else {
    // Apps Script only accepts 1, 5, 10, 15 or 30.
    const allowed = [1, 5, 10, 15, 30];
    const pick = allowed.reduce(function (best, v) {
      return Math.abs(v - minutes) < Math.abs(best - minutes) ? v : best;
    }, 30);
    builder.everyMinutes(pick).create();
  }

  console.log('Flug is set up. Scanning every ' + minutes + ' minutes.');
  if (!cfg('CHAT_WEBHOOK_URL')) {
    console.log('Note: CHAT_WEBHOOK_URL is empty — set it in Project Settings → ' +
      'Script Properties to get Google Chat notifications.');
  }
}

function runFlightScan() {
  scan_(cfgInt('SEARCH_WINDOW_DAYS', 4), {
    notifyChat: true,
    forward: cfgBool('FORWARD_TO_FLIGHTY'),
    calendar: cfgBool('ADD_TO_CALENDAR'),
    store: cfgBool('STORE_FLIGHTS'),
  });
}

/**
 * Fill the Flights sheet from your booking history (default: last 365 days).
 * Idempotent — safe to run repeatedly; re-parsing an email updates its rows
 * rather than duplicating them. Run once after setup to populate the app.
 */
function syncNow(days) {
  const window = days || 365;
  const threads = GmailApp.search(buildSearchQuery(window), 0, 100);
  const cutoff = new Date(Date.now() - window * 24 * 60 * 60 * 1000);
  let added = 0, segs = 0, emails = 0;

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      if (message.getDate() < cutoff) return;
      const subject = message.getSubject() || '';
      if (/^fwd:/i.test(subject)) return;
      const parsed = parseFlightInfo(subject, message.getPlainBody() || '');
      const meta = classifyMessage(message, parsed);
      if (!meta || !meta.bookingConfirmation) return;
      const flights = extractFlights(message);
      if (!flights.length) return;
      emails++; segs += flights.length;
      try { added += upsertFlights(flights); } catch (e) { console.error('Store failed: ' + e); }
    });
  });

  console.log('Synced ' + emails + ' booking email(s), ' + segs + ' segment(s); ' + added + ' new row(s).');
  flightSheetUrl();
}

/**
 * Forward historical flight confirmations to Flighty (no Chat posts and no
 * calendar events — past flights shouldn't clutter either).
 * Run from the editor, e.g. backfill(365). With no argument: 180 days.
 * Gmail sending quotas apply (~100 recipients/day on consumer accounts),
 * so very large backfills may need to be run across multiple days.
 */
function backfill(days) {
  scan_(days || 180, { notifyChat: false, forward: true, calendar: false });
}

/**
 * Test run over the last N days (default 90): logs which emails would match
 * and what was parsed from them — no Chat posts, no Flighty forwards, no
 * calendar events, no labels, nothing marked processed. Run it as often as
 * you like; check the Execution log for the results.
 */
function dryRun(days) {
  scan_(days || 90, { notifyChat: false, forward: false, calendar: false, dryRun: true });
}

/**
 * Read-only diagnostic for the app build: scans recent confirmations and
 * logs the STRUCTURED flights extracted from each (flight #, airports,
 * times, confirmation code) plus whether they came from embedded schema.org
 * markup ('schema') or the text fallback ('text'). No writes, no side
 * effects. Use it to confirm data quality before building the Sheet + app.
 */
function previewFlights(days) {
  const window = days || 120;
  const threads = GmailApp.search(buildSearchQuery(window), 0, 60);
  const cutoff = new Date(Date.now() - window * 24 * 60 * 60 * 1000);
  let clean = 0, weak = 0, emails = 0, segs = 0;
  const seenSubjects = {};

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      if (message.getDate() < cutoff) return;
      const subject = message.getSubject() || '';
      if (/^fwd:/i.test(subject)) return; // skip your own forwards
      const parsed = parseFlightInfo(subject, message.getPlainBody() || '');
      const meta = classifyMessage(message, parsed);
      if (!meta || !meta.bookingConfirmation) return;

      const flights = extractFlights(message);
      if (!flights.length) return;
      emails++;

      flights.forEach(function (f) {
        segs++;
        // schema markup and the Delta layout parser are both "clean";
        // the generic text fallback is "weak" (often missing times/airports).
        if (f.source === 'schema' || f.source === 'delta') clean++; else weak++;
        console.log(
          '[' + f.source + '] ' + (f.flightNo || '??') + '  ' +
          (f.origin || '???') + ' → ' + (f.dest || '???') + '  ' +
          (f.dateStr || '') + ' ' + (f.depTimeStr || '') +
          (f.arrTimeStr ? '–' + f.arrTimeStr : '') +
          (f.confirmation ? '  conf=' + f.confirmation : '') +
          '   « ' + subject.slice(0, 38)
        );
      });
    });
  });

  console.log('---');
  console.log('Preview: ' + emails + ' booking email(s), ' + segs + ' segment(s) — ' +
    clean + ' cleanly parsed, ' + weak + ' weak (text fallback).');
  if (segs && clean / segs >= 0.8) {
    console.log('Looks great — ready to build the Sheet + app.');
  } else if (segs) {
    console.log('Some still weak — paste this log and I will tune before building further.');
  }
}

/**
 * One-off inspector: finds your most recent booking confirmation and reports
 * which structured markers it carries (JSON-LD, microdata) plus a short
 * excerpt of the itinerary text — so extraction can be built to the real
 * format. Read-only. The excerpt contains your own flight itinerary text.
 */
function inspectEmail(which) {
  const threads = GmailApp.search(buildSearchQuery(180), 0, 40);
  const n = which || 1;
  let found = 0;

  for (let t = 0; t < threads.length; t++) {
    const messages = threads[t].getMessages();
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const subject = message.getSubject() || '';
      if (/^fwd:/i.test(subject)) continue;
      const parsed = parseFlightInfo(subject, message.getPlainBody() || '');
      const meta = classifyMessage(message, parsed);
      if (!meta || !meta.bookingConfirmation) continue;

      found++;
      if (found < n) continue;

      const html = (function () { try { return message.getBody() || ''; } catch (e) { return ''; } })();
      const textBody = message.getPlainBody() || '';
      const low = html.toLowerCase();
      function has(s) { return low.indexOf(s) !== -1 ? 'YES' : 'no'; }

      console.log('Subject: ' + subject);
      console.log('Markers — ld+json:' + has('ld+json') +
        '  FlightReservation:' + has('flightreservation') +
        '  itemtype:' + has('itemtype') +
        '  itemprop:' + has('itemprop') +
        '  schema.org:' + has('schema.org'));
      console.log('Sizes — html:' + html.length + '  text:' + textBody.length);

      // Excerpt of the plain-text itinerary around the first flight number.
      let start = textBody.search(/\b[A-Z]{2}\s?\d{2,4}\b/);
      if (start < 0) start = 0;
      start = Math.max(0, start - 120);
      const excerpt = textBody.slice(start, start + 1800)
        .replace(/\r/g, '').replace(/\n{3,}/g, '\n\n');
      console.log('--- itinerary text excerpt ---');
      console.log(excerpt);
      console.log('--- end excerpt ---');
      return;
    }
  }
  console.log('No booking confirmation #' + n + ' found in the last 180 days.');
}

/**
 * Diagnostic: list ALL recent airline mail (not just what passes the filter)
 * and show how each is classified and how many segments it yields — so a
 * missing trip's email is easy to spot. Read-only.
 */
function diagnoseRecent(days) {
  const window = days || 14;
  const domains = Object.keys(AIRLINE_SENDERS)
    .concat(cfg('EXTRA_SENDERS').split(',').map(function (s) { return s.trim(); }).filter(String));
  const q = '-in:trash -in:spam -from:me newer_than:' + window + 'd from:(' + domains.join(' OR ') + ')';
  const threads = GmailApp.search(q, 0, 60);

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      const subject = message.getSubject() || '';
      if (/^fwd:/i.test(subject)) return;
      const parsed = parseFlightInfo(subject, message.getPlainBody() || '');
      const meta = classifyMessage(message, parsed);
      let tag;
      if (!meta) tag = 'SKIP    ';
      else if (meta.bookingConfirmation) tag = 'BOOKING ';
      else tag = 'seen    ';
      const segs = meta ? extractFlights(message) : [];
      const preview = segs.length ? ' [' + segs.map(function (s) {
        return (s.flightNo || '?') + ' ' + s.origin + '→' + s.dest + ' ' + (s.dateStr || '');
      }).join('; ') + ']' : '';
      console.log(tag + '| ' + Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), 'MMM d') +
        ' | ' + subject.slice(0, 46) + preview);
    });
  });
  console.log('--- (BOOKING = stored in app · seen = airline mail we ignore · SKIP = filtered out) ---');
}

function scan_(windowDays, opts) {
  const query = buildSearchQuery(windowDays);
  const threads = GmailApp.search(query, 0, 100);
  if (threads.length === 0) {
    console.log('No candidate emails found.');
    return;
  }

  const processed = loadProcessedIds_();
  const label = getOrCreateLabel_();
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  let handled = 0;

  threads.forEach(function (thread) {
    let threadMatched = false;

    thread.getMessages().forEach(function (message) {
      const id = message.getId();
      // Dry runs re-evaluate everything so tests aren't hidden by dedupe.
      if (processed.ids[id] && !opts.dryRun) return;
      if (message.getDate() < cutoff) return;
      const from = (message.getFrom() || '').toLowerCase();
      if (from.indexOf(me) !== -1) return; // our own forwards etc.

      const parsed = parseFlightInfo(message.getSubject() || '', message.getPlainBody() || '');
      const meta = classifyMessage(message, parsed);

      // Remember the ID either way so non-matches aren't rescored every run.
      processed.ids[id] = true;
      processed.order.push(id);
      if (!meta) return;

      meta.forwarded = false;
      if (opts.forward && meta.forwardable) {
        try {
          message.forward(cfg('FLIGHTY_ADDRESS'));
          meta.forwarded = true;
        } catch (e) {
          console.error('Forward to Flighty failed for "' + message.getSubject() + '": ' + e);
        }
      }

      meta.stored = 0;
      if (opts.store && meta.bookingConfirmation) {
        try {
          meta.stored = upsertFlights(extractFlights(message));
        } catch (e) {
          console.error('Store to sheet failed for "' + message.getSubject() + '": ' + e);
        }
      }

      meta.eventsCreated = 0;
      if (opts.calendar && meta.bookingConfirmation) {
        try {
          meta.eventsCreated = addToCalendar(message, parsed, meta);
        } catch (e) {
          console.error('Calendar update failed for "' + message.getSubject() + '": ' + e);
        }
      }

      if (opts.notifyChat) {
        try {
          postToChat(message, parsed, meta);
        } catch (e) {
          console.error('Chat notification failed for "' + message.getSubject() + '": ' + e);
        }
      }

      threadMatched = true;
      handled++;
      if (opts.dryRun) {
        console.log('WOULD process: [' + (meta.airline || '?') + '] "' + message.getSubject() +
          '" — kind=' + meta.kind + ', forwardable=' + meta.forwardable +
          ', parsed=' + JSON.stringify(parsed));
      } else {
        console.log('Processed: [' + (meta.airline || '?') + '] ' + message.getSubject() +
          (meta.forwarded ? ' (forwarded to Flighty)' : ''));
      }
    });

    if (threadMatched && !opts.dryRun) thread.addLabel(label);
  });

  if (!opts.dryRun) saveProcessedIds_(processed);
  console.log('Scan complete: ' + handled + ' flight email(s) handled, ' +
    threads.length + ' candidate thread(s) examined.');
}

// ---------------------------------------------------------------- helpers

function getOrCreateLabel_() {
  return GmailApp.getUserLabelByName(PROCESSED_LABEL) ||
    GmailApp.createLabel(PROCESSED_LABEL);
}

function loadProcessedIds_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROCESSED_IDS_KEY);
  const order = raw ? JSON.parse(raw) : [];
  const ids = {};
  order.forEach(function (id) { ids[id] = true; });
  return { ids: ids, order: order };
}

function saveProcessedIds_(processed) {
  const trimmed = processed.order.slice(-MAX_TRACKED_IDS);
  PropertiesService.getScriptProperties()
    .setProperty(PROCESSED_IDS_KEY, JSON.stringify(trimmed));
}

/** Clear dedupe memory (e.g. to re-test on the same emails). */
function resetProcessedIds() {
  PropertiesService.getScriptProperties().deleteProperty(PROCESSED_IDS_KEY);
}
