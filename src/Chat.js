/**
 * Google Chat notifications via an incoming webhook
 * (Chat space → Apps & integrations → Webhooks).
 */

function postToChat(message, parsed, meta) {
  const url = cfg('CHAT_WEBHOOK_URL');
  if (!url) return;

  const subject = message.getSubject() || '(no subject)';
  const gmailLink = 'https://mail.google.com/mail/u/0/#all/' + message.getId();

  const widgets = [];
  function field(icon, label, value) {
    if (!value) return;
    widgets.push({
      decoratedText: {
        startIcon: { knownIcon: icon },
        topLabel: label,
        text: String(value),
        wrapText: true,
      },
    });
  }

  field('AIRPLANE', 'Flight(s)', parsed.flights.join(', '));
  field('MAP_PIN', 'Route', parsed.route);
  field('INVITE', 'Date(s)', parsed.dates.join(' · '));
  field('CONFIRMATION_NUMBER_ICON', 'Confirmation code', parsed.confirmationCode);
  if (meta.forwarded) {
    field('EMAIL', 'Flighty', 'Forwarded to Flighty for import');
  }
  if (meta.eventsCreated) {
    field('EVENT_SEAT', 'Calendar', meta.eventsCreated + ' event(s) added to Google Calendar');
  }
  widgets.push({
    buttonList: {
      buttons: [{ text: 'Open email in Gmail', onClick: { openLink: { url: gmailLink } } }],
    },
  });

  const title = (meta.kind === 'update' ? '🔔 Flight update — ' : '✈️ New flight — ') +
    (meta.airline || 'Unknown airline');

  const payload = {
    // Plain-text fallback drives the push-notification preview.
    text: title + ': ' + subject,
    cardsV2: [{
      cardId: 'flug-' + message.getId(),
      card: {
        header: { title: title, subtitle: subject },
        sections: [{ widgets: widgets }],
      },
    }],
  };

  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() >= 300) {
    console.error('Chat webhook returned ' + resp.getResponseCode() + ': ' + resp.getContentText());
  }
}

/** Run manually to verify the webhook is wired up. */
function sendTestMessage() {
  const url = cfg('CHAT_WEBHOOK_URL');
  if (!url) throw new Error('Set the CHAT_WEBHOOK_URL script property (or default in Config) first.');
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ text: '✈️ Flug is connected — flight confirmations will show up here.' }),
  });
}
