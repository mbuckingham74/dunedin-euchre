'use strict';

const db = require('../db/database');
const { sendRsvpSummary } = require('./email');
const { applyManagedLocation } = require('./locations');
const { buildPartyResponseView } = require('./party');

const SUMMARY_TIME_ZONE = process.env.EVENT_RSVP_SUMMARY_TIMEZONE
  || process.env.EVENT_TIMEZONE
  || process.env.EVENT_REMINDER_TIMEZONE
  || 'America/New_York';
const SUMMARY_SEND_HOUR = parseHour(process.env.EVENT_RSVP_SUMMARY_HOUR, 16);
const SUMMARY_RECIPIENT_EMAIL = getFirstEmail(
  process.env.EVENT_RSVP_SUMMARY_EMAIL || process.env.ADMIN_EMAIL
);
const WORKER_POLL_MS = parsePositiveInteger(process.env.EVENT_RSVP_SUMMARY_POLL_MS, 60 * 1000);
const WORKER_BATCH_SIZE = parsePositiveInteger(process.env.EVENT_RSVP_SUMMARY_BATCH_SIZE, 5);

let workerTimer = null;
let workerRunning = false;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseHour(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : fallback;
}

function getFirstEmail(value) {
  return String(value || '')
    .split(',')
    .map(email => email.trim())
    .find(Boolean) || '';
}

function parseDateKey(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number);
  if (!year || !month || !day) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }

  return { year, month, day };
}

function getTimeZoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  return formatter.formatToParts(date).reduce((parts, part) => {
    if (part.type !== 'literal') {
      parts[part.type] = part.value;
    }
    return parts;
  }, {});
}

function getDateKeyInTimeZone(date, timeZone) {
  const parts = getTimeZoneParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getZonedIsoString(dateKey, hour, minute, timeZone) {
  const { year, month, day } = parseDateKey(dateKey);
  const targetEpoch = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = new Date(targetEpoch);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = getTimeZoneParts(guess, timeZone);
    const observedEpoch = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second || '0')
    );
    const adjustment = targetEpoch - observedEpoch;
    if (adjustment === 0) break;
    guess = new Date(guess.getTime() + adjustment);
  }

  return guess.toISOString();
}

function buildSummarySubject(event) {
  const title = (event && event.title ? event.title : '').trim() || 'Dunedin Euchre';
  return `RSVP list for ${title}`;
}

function getDefaultRsvpSummarySchedule(event, options = {}) {
  if (!event || !event.event_date) {
    throw new Error('An event date is required to schedule an RSVP summary.');
  }

  const timeZone = options.timeZone || SUMMARY_TIME_ZONE;
  const hour = Number.isInteger(options.hour) ? options.hour : SUMMARY_SEND_HOUR;
  const minute = Number.isInteger(options.minute) ? options.minute : 0;

  return {
    timeZone,
    dateKey: event.event_date,
    scheduledAt: getZonedIsoString(event.event_date, hour, minute, timeZone)
  };
}

function isTestEvent(event) {
  return Boolean(event && String(event.title || '').trim().startsWith('[TEST]'));
}

function ensureScheduledRsvpSummaries(options = {}) {
  const recipientEmail = options.recipientEmail || SUMMARY_RECIPIENT_EMAIL;
  if (!recipientEmail) {
    return { scheduled: 0, recipientEmail: '', reason: 'No RSVP summary recipient is configured.' };
  }

  const referenceDate = options.referenceDate instanceof Date ? options.referenceDate : new Date();
  const timeZone = options.timeZone || SUMMARY_TIME_ZONE;
  const todayKey = getDateKeyInTimeZone(referenceDate, timeZone);
  const events = db.prepare(`
    SELECT *
    FROM events
    WHERE event_date >= ?
      AND is_published = 1
      AND TRIM(title) NOT LIKE '[TEST]%'
    ORDER BY event_date ASC, id ASC
  `).all(todayKey);
  const upsert = db.prepare(`
    INSERT INTO scheduled_rsvp_summaries (
      event_id,
      send_at,
      recipient_email,
      subject,
      status,
      resend_email_id,
      last_error,
      sent_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, datetime('now'))
    ON CONFLICT(event_id) DO UPDATE SET
      send_at = CASE
        WHEN scheduled_rsvp_summaries.status = 'sent' THEN scheduled_rsvp_summaries.send_at
        ELSE excluded.send_at
      END,
      recipient_email = CASE
        WHEN scheduled_rsvp_summaries.status = 'sent' THEN scheduled_rsvp_summaries.recipient_email
        ELSE excluded.recipient_email
      END,
      subject = CASE
        WHEN scheduled_rsvp_summaries.status = 'sent' THEN scheduled_rsvp_summaries.subject
        ELSE excluded.subject
      END,
      status = CASE
        WHEN scheduled_rsvp_summaries.status IN ('sent', 'processing', 'failed')
          THEN scheduled_rsvp_summaries.status
        ELSE 'pending'
      END,
      resend_email_id = CASE
        WHEN scheduled_rsvp_summaries.status = 'sent' THEN scheduled_rsvp_summaries.resend_email_id
        ELSE NULL
      END,
      last_error = CASE
        WHEN scheduled_rsvp_summaries.status = 'failed' THEN scheduled_rsvp_summaries.last_error
        ELSE NULL
      END,
      sent_at = CASE
        WHEN scheduled_rsvp_summaries.status = 'sent' THEN scheduled_rsvp_summaries.sent_at
        ELSE NULL
      END,
      updated_at = datetime('now')
  `);

  const transaction = db.transaction(() => {
    for (const event of events) {
      const schedule = getDefaultRsvpSummarySchedule(event, {
        timeZone,
        hour: options.hour,
        minute: options.minute
      });
      upsert.run(
        event.id,
        schedule.scheduledAt,
        recipientEmail,
        buildSummarySubject(event)
      );
    }
  });

  transaction();
  return { scheduled: events.length, recipientEmail, timeZone };
}

function getSummaryProcessingBatch(options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : WORKER_BATCH_SIZE;
  const referenceDate = options.referenceDate instanceof Date ? options.referenceDate : new Date();
  const rows = db.prepare(`
    SELECT *
    FROM scheduled_rsvp_summaries
    WHERE status = 'pending'
      AND send_at <= ?
    ORDER BY send_at ASC, id ASC
    LIMIT ?
  `).all(referenceDate.toISOString(), limit);
  const markProcessing = db.prepare(`
    UPDATE scheduled_rsvp_summaries
    SET status = 'processing',
        updated_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `);

  return rows.filter(row => markProcessing.run(row.id).changes === 1);
}

function getEventById(eventId) {
  return applyManagedLocation(db.prepare(`
    SELECT
      e.*,
      l.name AS managed_location_name,
      l.address AS managed_location_address,
      l.location_image AS managed_location_image,
      l.map_embed_url AS managed_map_embed_url,
      l.map_link_url AS managed_map_link_url
    FROM events e
    LEFT JOIN locations l ON l.id = e.location_id
    WHERE e.id = ?
  `).get(eventId));
}

function getEventRoster(eventId) {
  return db.prepare(`
    SELECT p.id, p.name, p.email, p.rsvp_token, p.party_members,
           r.status, r.comment, r.change_count, r.responded_at, r.updated_at, r.attendee_names
    FROM participants p
    LEFT JOIN responses r ON r.participant_id = p.id AND r.event_id = ?
    WHERE p.active = 1
    ORDER BY p.name ASC
  `).all(eventId).map(buildPartyResponseView);
}

async function processScheduledRsvpSummaries(options = {}) {
  if (workerRunning) return;
  workerRunning = true;

  try {
    ensureScheduledRsvpSummaries(options);
    const batch = getSummaryProcessingBatch(options);
    const sendSummary = options.sendSummary || sendRsvpSummary;

    for (const row of batch) {
      const event = getEventById(row.event_id);

      if (!event || !Number(event.is_published) || isTestEvent(event)) {
        db.prepare(`
          UPDATE scheduled_rsvp_summaries
          SET status = 'canceled',
              last_error = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run('The event is no longer published or available.', row.id);
        continue;
      }

      try {
        const response = await sendSummary(
          row.recipient_email,
          event,
          getEventRoster(event.id),
          { subject: row.subject }
        );

        db.prepare(`
          UPDATE scheduled_rsvp_summaries
          SET status = 'sent',
              resend_email_id = ?,
              sent_at = ?,
              last_error = NULL,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(
          response && response.id ? response.id : null,
          new Date().toISOString(),
          row.id
        );
      } catch (error) {
        db.prepare(`
          UPDATE scheduled_rsvp_summaries
          SET status = 'failed',
              last_error = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(error.message, row.id);
      }
    }
  } finally {
    workerRunning = false;
  }
}

function startRsvpSummaryWorker() {
  if (workerTimer || process.env.NODE_ENV === 'test') {
    return;
  }

  if (!SUMMARY_RECIPIENT_EMAIL) {
    console.warn('RSVP summary worker is disabled because no recipient email is configured.');
    return;
  }

  const run = () => {
    processScheduledRsvpSummaries().catch(error => {
      console.error('RSVP summary worker failed:', error);
    });
  };

  workerTimer = setInterval(run, WORKER_POLL_MS);
  workerTimer.unref?.();
  setTimeout(run, 1000).unref?.();
}

function stopRsvpSummaryWorker() {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}

module.exports = {
  SUMMARY_RECIPIENT_EMAIL,
  SUMMARY_SEND_HOUR,
  SUMMARY_TIME_ZONE,
  buildSummarySubject,
  ensureScheduledRsvpSummaries,
  getDefaultRsvpSummarySchedule,
  processScheduledRsvpSummaries,
  startRsvpSummaryWorker,
  stopRsvpSummaryWorker,
  __test__: {
    getDateKeyInTimeZone,
    getFirstEmail,
    getTimeZoneParts,
    getZonedIsoString,
    isTestEvent,
    parseHour
  }
};
