'use strict';

const { buildRsvpInviteEmail } = require('./email');
const { buildRsvpUrl } = require('./links');

const RESEND_API_BASE_URL = 'https://api.resend.com';
const RESEND_EMAIL_PAGE_SIZE = parsePositiveInteger(process.env.RESEND_EMAIL_PAGE_SIZE, 100);
const RESEND_EMAIL_MAX_PAGES = parsePositiveInteger(process.env.RESEND_EMAIL_MAX_PAGES, 3);
const INVITE_FROM = process.env.FROM_EMAIL || 'admin@dunedin-euchre.com';

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function getApiKey(options = {}) {
  return options.apiKey || process.env.RESEND_API_KEY || null;
}

function getFetchImpl(options = {}) {
  return options.fetchImpl || fetch;
}

async function resendRequest(path, options = {}) {
  const apiKey = getApiKey(options);
  if (!apiKey) {
    throw new Error('Missing RESEND_API_KEY.');
  }

  const fetchImpl = getFetchImpl(options);
  const response = await fetchImpl(`${RESEND_API_BASE_URL}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  if (!response.ok) {
    let message = `Resend request failed with status ${response.status}.`;

    try {
      const error = await response.json();
      if (error && error.message) {
        message = error.message;
      }
    } catch (parseError) {
      // Keep the default message when the error body is not JSON.
    }

    const failure = new Error(message);
    failure.statusCode = response.status;
    throw failure;
  }

  return response.json();
}

async function listResendEmails(options = {}) {
  const searchParams = new URLSearchParams();
  searchParams.set('limit', String(options.limit || RESEND_EMAIL_PAGE_SIZE));
  if (options.before) {
    searchParams.set('before', options.before);
  }
  if (options.after) {
    searchParams.set('after', options.after);
  }

  return resendRequest(`/emails?${searchParams.toString()}`, options);
}

async function getResendEmail(emailId, options = {}) {
  return resendRequest(`/emails/${emailId}`, options);
}

function getInviteDeliveryGroup(lastEvent) {
  const normalizedEvent = String(lastEvent || '').trim().toLowerCase();
  if (!normalizedEvent) return 'pending';

  if (['delivered', 'opened', 'clicked'].includes(normalizedEvent)) {
    return 'delivered';
  }

  if (['bounced', 'complained', 'canceled'].includes(normalizedEvent)) {
    return 'issue';
  }

  return 'pending';
}

function formatInviteDeliveryLabel(lastEvent, hasMatch) {
  if (!hasMatch) return 'Missing';

  const normalizedEvent = String(lastEvent || '').trim().toLowerCase();
  if (!normalizedEvent) return 'Sent';

  return normalizedEvent
    .split(/[_\s-]+/)
    .map(segment => segment ? `${segment[0].toUpperCase()}${segment.slice(1)}` : '')
    .join(' ');
}

async function getEventInviteDeliveryStatus(participants, event, options = {}) {
  const roster = Array.isArray(participants) ? participants : [];
  const baseUrl = options.baseUrl || process.env.BASE_URL || 'https://dunedin-euchre.com';
  const checkedAt = new Date().toISOString();
  const apiKey = getApiKey(options);

  const defaultStatuses = roster.map(participant => ({
    participant,
    sentAt: null,
    emailId: null,
    lastEvent: null,
    group: 'missing',
    label: 'Missing'
  }));

  if (!apiKey || roster.length === 0 || !event) {
    return {
      available: Boolean(apiKey),
      checkedAt,
      summary: {
        delivered: 0,
        pending: 0,
        issue: 0,
        missing: defaultStatuses.length
      },
      statuses: defaultStatuses,
      error: apiKey ? null : 'Resend status is unavailable until RESEND_API_KEY is configured.'
    };
  }

  const expectedByEmail = new Map(roster.map(participant => ([
    normalizeEmail(participant.email),
    {
      participant,
      expectedLink: buildRsvpUrl(baseUrl, participant, event)
    }
  ])));
  const expectedSubject = buildRsvpInviteEmail(roster[0], event).subject;
  const matchedByEmail = new Map();
  const candidateSummaries = [];
  let before = null;
  let pageCount = 0;

  while (pageCount < (options.maxPages || RESEND_EMAIL_MAX_PAGES)) {
    const page = await (options.listEmails || listResendEmails)({
      ...options,
      before,
      limit: options.limit || RESEND_EMAIL_PAGE_SIZE
    });
    const emails = Array.isArray(page && page.data) ? page.data : [];
    if (emails.length === 0) break;

    for (const email of emails) {
      if (email.from !== INVITE_FROM || email.subject !== expectedSubject) {
        continue;
      }

      const recipients = Array.isArray(email.to) ? email.to : [];
      if (!recipients.some(address => expectedByEmail.has(normalizeEmail(address)))) {
        continue;
      }

      candidateSummaries.push(email);
    }

    pageCount += 1;
    if (!page.has_more || emails.length === 0) {
      break;
    }

    before = emails[emails.length - 1].id;
    if (!before) {
      break;
    }
  }

  for (const summary of candidateSummaries) {
    const recipients = (Array.isArray(summary.to) ? summary.to : [])
      .map(normalizeEmail)
      .filter(address => expectedByEmail.has(address) && !matchedByEmail.has(address));
    if (recipients.length === 0) {
      continue;
    }

    const detail = await (options.getEmail || getResendEmail)(summary.id, options);
    const html = String(detail && detail.html || '');
    const text = String(detail && detail.text || '');

    for (const recipientEmail of recipients) {
      const expected = expectedByEmail.get(recipientEmail);
      if (!expected) continue;

      if (!html.includes(expected.expectedLink) && !text.includes(expected.expectedLink)) {
        continue;
      }

      matchedByEmail.set(recipientEmail, {
        emailId: summary.id,
        sentAt: summary.created_at || detail.created_at || null,
        lastEvent: detail.last_event || summary.last_event || null
      });
    }

    if (matchedByEmail.size === expectedByEmail.size) {
      break;
    }
  }

  const summary = {
    delivered: 0,
    pending: 0,
    issue: 0,
    missing: 0
  };

  const statuses = roster.map(participant => {
    const match = matchedByEmail.get(normalizeEmail(participant.email)) || null;
    const group = match ? getInviteDeliveryGroup(match.lastEvent) : 'missing';
    const label = formatInviteDeliveryLabel(match && match.lastEvent, Boolean(match));

    summary[group] += 1;

    return {
      participant,
      sentAt: match ? match.sentAt : null,
      emailId: match ? match.emailId : null,
      lastEvent: match ? match.lastEvent : null,
      group,
      label
    };
  });

  return {
    available: true,
    checkedAt,
    summary,
    statuses,
    error: null
  };
}

module.exports = {
  formatInviteDeliveryLabel,
  getEventInviteDeliveryStatus,
  getInviteDeliveryGroup,
  getResendEmail,
  listResendEmails
};
