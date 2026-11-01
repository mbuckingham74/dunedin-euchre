'use strict';

const { listEventInvitationDeliveries, updateDeliveryFromActivity } = require('./email-delivery-history');

const SMTP2GO_API_BASE_URL = 'https://api.smtp2go.com/v3';
const SMTP2GO_ACTIVITY_PAGE_SIZE = 1000;
const SMTP2GO_ACTIVITY_MAX_PAGES = 20;
const INVITE_FROM = process.env.ROSTER_FROM_EMAIL || 'Do_Not_Reply@dunedin-euchre.com';
const DELIVERY_HEADER = 'X-Dunedin-Delivery-ID';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function toIsoUtc(value) {
  if (!value) return new Date(0).toISOString();
  const text = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function getInviteDeliveryGroup(lastEvent, deliveryStatus = null) {
  const normalizedEvent = String(lastEvent || deliveryStatus || '').trim().toLowerCase();
  if (!normalizedEvent) return 'pending';

  if (['delivered', 'opened', 'clicked', 'resubscribed'].includes(normalizedEvent)) {
    return 'delivered';
  }

  if ([
    'bounced',
    'soft-bounced',
    'hard-bounced',
    'complained',
    'spam',
    'rejected',
    'unsubscribed',
    'canceled',
    'failed'
  ].includes(normalizedEvent)) {
    return 'issue';
  }

  return 'pending';
}

function formatInviteDeliveryLabel(lastEvent, hasMatch, deliveryStatus = null) {
  if (!hasMatch) return 'Missing';

  const normalizedEvent = String(lastEvent || deliveryStatus || '').trim().toLowerCase();
  if (!normalizedEvent) return 'Accepted';
  if (normalizedEvent === 'ambiguous' || normalizedEvent === 'sending') return 'Delivery Unknown';

  return normalizedEvent
    .split(/[_\s-]+/)
    .map(segment => segment ? `${segment[0].toUpperCase()}${segment.slice(1)}` : '')
    .join(' ');
}

function getFetchImpl(options = {}) {
  return options.fetchImpl || fetch;
}

async function searchSmtp2goActivity(filters, options = {}) {
  const apiKey = options.apiKey || process.env.SMTP2GO_API_KEY || null;
  if (!apiKey) {
    throw new Error('SMTP2GO activity is unavailable until SMTP2GO_API_KEY is configured.');
  }

  const fetchImpl = getFetchImpl(options);
  const baseUrl = String(
    options.baseUrl || process.env.SMTP2GO_API_BASE_URL || SMTP2GO_API_BASE_URL
  ).replace(/\/+$/, '');
  const requestOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Smtp2go-Api-Key': apiKey
    },
    body: JSON.stringify(filters)
  };
  const timeoutMs = Number.parseInt(options.timeoutMs || process.env.SMTP2GO_REQUEST_TIMEOUT_MS || '15000', 10);
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' && timeoutMs > 0) {
    requestOptions.signal = AbortSignal.timeout(timeoutMs);
  }

  const response = await fetchImpl(`${baseUrl}/activity/search`, requestOptions);
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error('SMTP2GO activity returned a response that was not valid JSON.');
  }

  if (!response.ok || body?.data?.error) {
    const message = body?.data?.error || body?.error || `SMTP2GO activity failed with status ${response.status}.`;
    const failure = new Error(message);
    failure.statusCode = response.status;
    throw failure;
  }

  return body.data || {};
}

async function listSmtp2goActivityForSubject(records, options = {}) {
  const bySubject = new Map();
  for (const record of records) {
    if (record.provider !== 'smtp2go') continue;
    const subject = String(record.subject || '').trim();
    if (!subject) continue;
    const group = bySubject.get(subject) || [];
    group.push(record);
    bySubject.set(subject, group);
  }

  const allEvents = [];
  for (const [subject, subjectRecords] of bySubject) {
    const startDate = subjectRecords
      .map(record => toIsoUtc(record.sent_at || record.created_at))
      .sort()[0];
    let continueToken = null;

    for (let page = 0; page < (options.maxPages || SMTP2GO_ACTIVITY_MAX_PAGES); page += 1) {
      const filters = {
        start_date: startDate,
        end_date: new Date().toISOString(),
        search_subject: subject,
        search_sender: options.sender || INVITE_FROM,
        event_types: [
          'processed', 'delivered', 'soft-bounced', 'hard-bounced', 'rejected',
          'spam', 'unsubscribed', 'resubscribed', 'opened', 'clicked'
        ],
        custom_headers: [DELIVERY_HEADER],
        only_latest_by_sent: true,
        limit: options.limit || SMTP2GO_ACTIVITY_PAGE_SIZE
      };
      if (continueToken) filters.continue_token = continueToken;

      const result = await (options.searchActivity || searchSmtp2goActivity)(filters, options);
      allEvents.push(...(Array.isArray(result.events) ? result.events : []));
      continueToken = result.continue_token || null;
      if (!continueToken) break;
    }
  }

  return allEvents;
}

function resolveActivityRow(event, byMessageId, byDeliveryKey) {
  const messageId = String(event && event.email_id || '').trim();
  if (messageId && byMessageId.has(messageId)) return byMessageId.get(messageId);

  const headers = event && event.custom_headers && typeof event.custom_headers === 'object'
    ? event.custom_headers
    : {};
  const deliveryKey = String(
    headers[DELIVERY_HEADER] || headers[DELIVERY_HEADER.toLowerCase()] || ''
  ).trim();
  return deliveryKey ? byDeliveryKey.get(deliveryKey) || null : null;
}

async function getEventInviteDeliveryStatus(participants, event, options = {}) {
  const roster = Array.isArray(participants) ? participants : [];
  const checkedAt = new Date().toISOString();
  const defaultStatuses = roster.map(participant => ({
    participant,
    sentAt: null,
    emailId: null,
    lastEvent: null,
    group: 'missing',
    label: 'Missing'
  }));

  if (!event || roster.length === 0) {
    return {
      available: true,
      checkedAt,
      summary: { delivered: 0, pending: 0, issue: 0, missing: defaultStatuses.length },
      statuses: defaultStatuses,
      error: null
    };
  }

  let records = listEventInvitationDeliveries(event.id);
  let errorMessage = null;
  const smtpRecords = records.filter(record => record.provider === 'smtp2go');
  if (smtpRecords.length > 0) {
    if (!(options.apiKey || process.env.SMTP2GO_API_KEY)) {
      errorMessage = 'SMTP2GO activity is unavailable until SMTP2GO_API_KEY is configured.';
    } else {
      try {
        const events = await listSmtp2goActivityForSubject(smtpRecords, options);
        const byMessageId = new Map(smtpRecords
          .filter(record => record.provider_message_id)
          .map(record => [record.provider_message_id, record]));
        const byDeliveryKey = new Map(smtpRecords.map(record => [record.delivery_key, record]));
        for (const activity of events) {
          const row = resolveActivityRow(activity, byMessageId, byDeliveryKey);
          if (!row) continue;
          if (activity.recipient && normalizeEmail(activity.recipient) !== normalizeEmail(row.recipient_email)) {
            continue;
          }
          updateDeliveryFromActivity(row.id, {
            providerMessageId: activity.email_id,
            event: activity.event,
            date: activity.date
          });
        }
        records = listEventInvitationDeliveries(event.id);
      } catch (error) {
        errorMessage = error.message;
      }
    }
  }

  const latestByRecipient = new Map();
  for (const record of records) {
    const recipient = normalizeEmail(record.recipient_email);
    if (!recipient || latestByRecipient.has(recipient)) continue;
    latestByRecipient.set(recipient, record);
  }

  const summary = { delivered: 0, pending: 0, issue: 0, missing: 0 };
  const statuses = roster.map(participant => {
    const record = latestByRecipient.get(normalizeEmail(participant.email)) || null;
    const group = record
      ? getInviteDeliveryGroup(record.last_event, record.delivery_status)
      : 'missing';
    const label = formatInviteDeliveryLabel(
      record && record.last_event,
      Boolean(record),
      record && record.delivery_status
    );
    summary[group] += 1;

    return {
      participant,
      sentAt: record ? record.sent_at || record.created_at : null,
      emailId: record ? record.provider_message_id : null,
      lastEvent: record ? record.last_event || record.delivery_status : null,
      group,
      label,
      provider: record ? record.provider : null
    };
  });

  return {
    available: true,
    checkedAt,
    summary,
    statuses,
    error: errorMessage
  };
}

module.exports = {
  formatInviteDeliveryLabel,
  getEventInviteDeliveryStatus,
  getInviteDeliveryGroup,
  listSmtp2goActivityForSubject,
  searchSmtp2goActivity
};
