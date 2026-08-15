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
  });
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

      meta.eventsCreated = 0;
      if (opts.calendar && meta.kind === 'confirmation') {
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
