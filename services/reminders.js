'use strict';

const db = require('../db/database');
const { buildRsvpReminderEmail, sendRsvpReminder } = require('./email');
const {
  getEventInviteDeliveryStatus,
  getResendEmail,
  listResendEmails
} = require('./invite-status');
const { applyManagedLocation } = require('./locations');

const REMINDER_KIND = 'day_before_9am_pacific';
const REMINDER_TIME_ZONE = process.env.EVENT_REMINDER_TIMEZONE || 'America/New_York';
const REMINDER_SEND_HOUR = parsePositiveInteger(process.env.EVENT_REMINDER_HOUR, 9);
const DEFAULT_BASE_URL = process.env.BASE_URL || 'https://dunedin-euchre.com';
const WORKER_POLL_MS = parsePositiveInteger(process.env.EVENT_REMINDER_POLL_MS, 60 * 1000);
const WORKER_BATCH_SIZE = parsePositiveInteger(process.env.EVENT_REMINDER_BATCH_SIZE, 10);

let workerTimer = null;
let workerRunning = false;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDateKey(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number);
  if (!year || !month || !day) {
    throw new Error(`Invalid date key: ${dateKey}`);
  }

  return { year, month, day };
}

function formatDateKeyUtc(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function getPreviousDateKey(dateKey) {
  const { year, month, day } = parseDateKey(dateKey);
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  date.setUTCDate(date.getUTCDate() - 1);
  return formatDateKeyUtc(date);
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

function getDefaultReminderSchedule(event, options = {}) {
  if (!event || !event.event_date) {
    throw new Error('An event date is required to schedule reminder emails.');
  }

  const timeZone = options.timeZone || REMINDER_TIME_ZONE;
  const hour = Number.isInteger(options.hour) ? options.hour : REMINDER_SEND_HOUR;
  const minute = Number.isInteger(options.minute) ? options.minute : 0;
  const reminderDateKey = getPreviousDateKey(event.event_date);
  const scheduledAt = getZonedIsoString(reminderDateKey, hour, minute, timeZone);

  return {
    kind: REMINDER_KIND,
    timeZone,
    reminderDateKey,
    scheduledAt
  };
}

function buildReminderSubject(event) {
  const fallbackTitle = event && event.event_date
    ? `Dunedin Euchre on ${event.event_date}`
    : 'Dunedin Euchre Night';
  const title = (event && event.title ? event.title : '').trim() || fallbackTitle;
  return `Reminder and Last Call for ${title}`;
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, args, options = {}) {
  const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : 5;

  for (let attempt = 0; ; attempt += 1) {
    try {
      if (attempt > 0) {
        await wait(500 * (attempt + 1));
      }

      return await fn(...args);
    } catch (error) {
      if (!(error && error.statusCode === 429) || attempt >= maxRetries) {
        throw error;
      }
    }
  }
}

function getEligibleReminderRecipients(delivery) {
  return delivery.statuses
    .filter(status => status && status.emailId && status.group !== 'issue')
    .map(status => status.participant);
}

async function scheduleEventReminder(event, participants, options = {}) {
  const roster = Array.isArray(participants) ? participants : [];
  const schedule = getDefaultReminderSchedule(event, options);
  const subject = options.subject || buildReminderSubject(event);
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const delivery = await getEventInviteDeliveryStatus(roster, event, {
    baseUrl,
    maxPages: options.maxPages || 10,
    listEmails: innerOptions => withRetry(listResendEmails, [innerOptions]),
    getEmail: (emailId, innerOptions) => withRetry(getResendEmail, [emailId, innerOptions])
  });
  const recipients = getEligibleReminderRecipients(delivery);

  if (recipients.length === 0) {
    throw new Error('No reminder recipients were found for this event.');
  }

  const upsertReminder = db.prepare(`
    INSERT INTO scheduled_reminders (
      event_id,
      participant_id,
      kind,
      send_at,
      subject,
      status,
      resend_email_id,
      last_error,
      sent_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, datetime('now'))
    ON CONFLICT(event_id, participant_id, kind) DO UPDATE SET
      send_at = excluded.send_at,
      subject = excluded.subject,
      status = CASE
        WHEN scheduled_reminders.status = 'sent' THEN scheduled_reminders.status
        ELSE 'pending'
      END,
      resend_email_id = CASE
        WHEN scheduled_reminders.status = 'sent' THEN scheduled_reminders.resend_email_id
        ELSE NULL
      END,
      last_error = CASE
        WHEN scheduled_reminders.status = 'sent' THEN scheduled_reminders.last_error
        ELSE NULL
      END,
      sent_at = CASE
        WHEN scheduled_reminders.status = 'sent' THEN scheduled_reminders.sent_at
        ELSE NULL
      END,
      updated_at = datetime('now')
  `);

  const transaction = db.transaction(() => {
    for (const participant of recipients) {
      upsertReminder.run(event.id, participant.id, REMINDER_KIND, schedule.scheduledAt, subject);
    }
  });

  transaction();

  const summary = getEventReminderSummary(event.id);
  return {
    delivery,
    recipients,
    schedule,
    subject,
    summary
  };
}

function getEventReminderSummary(eventId) {
  const rows = db.prepare(`
    SELECT status, send_at, COUNT(*) AS count
    FROM scheduled_reminders
    WHERE event_id = ? AND kind = ?
    GROUP BY status, send_at
    ORDER BY send_at ASC, status ASC
  `).all(eventId, REMINDER_KIND);

  const summary = {
    total: 0,
    pending: 0,
    processing: 0,
    sent: 0,
    failed: 0,
    canceled: 0,
    scheduledAt: null
  };

  for (const row of rows) {
    summary.total += Number(row.count || 0);
    summary[row.status] += Number(row.count || 0);
    if (!summary.scheduledAt && row.send_at) {
      summary.scheduledAt = row.send_at;
    }
  }

  return summary;
}

function getReminderStatusLabel(summary) {
  if (!summary || summary.total === 0) {
    return 'No reminder scheduled yet.';
  }

  if (summary.sent > 0 && summary.sent === summary.total) {
    return 'Reminder batch already sent.';
  }

  if (summary.pending > 0 || summary.processing > 0) {
    return 'Reminder batch queued.';
  }

  if (summary.failed > 0) {
    return 'Reminder batch needs attention.';
  }

  return 'Reminder batch recorded.';
}

function formatReminderTimestamp(timestamp, options = {}) {
  if (!timestamp) return 'Not scheduled';

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Not scheduled';

  return date.toLocaleString('en-US', {
    timeZone: options.timeZone || REMINDER_TIME_ZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  });
}

function getReminderProcessingBatch(limit = WORKER_BATCH_SIZE) {
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT *
    FROM scheduled_reminders
    WHERE kind = ?
      AND status = 'pending'
      AND send_at <= ?
    ORDER BY send_at ASC, id ASC
    LIMIT ?
  `).all(REMINDER_KIND, now, limit);

  const markProcessing = db.prepare(`
    UPDATE scheduled_reminders
    SET status = 'processing',
        updated_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `);

  return rows.filter(row => markProcessing.run(row.id).changes === 1);
}

function getParticipantById(participantId) {
  return db.prepare(`
    SELECT *
    FROM participants
    WHERE id = ?
  `).get(participantId);
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

async function processScheduledReminders(options = {}) {
  if (workerRunning) return;
  workerRunning = true;

  try {
    const batch = getReminderProcessingBatch(options.limit);

    for (const row of batch) {
      const participant = getParticipantById(row.participant_id);
      const event = getEventById(row.event_id);

      if (!participant || !event || !Number(participant.active)) {
        db.prepare(`
          UPDATE scheduled_reminders
          SET status = 'failed',
              last_error = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run('Participant or event is no longer available.', row.id);
        continue;
      }

      try {
        const response = await sendRsvpReminder(participant, event, {
          subject: row.subject
        });

        db.prepare(`
          UPDATE scheduled_reminders
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
          UPDATE scheduled_reminders
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

function startReminderWorker() {
  if (workerTimer || process.env.NODE_ENV === 'test') {
    return;
  }

  const run = () => {
    processScheduledReminders().catch(error => {
      console.error('Reminder worker failed:', error);
    });
  };

  workerTimer = setInterval(run, WORKER_POLL_MS);
  if (workerTimer.unref) {
    workerTimer.unref();
  }

  setTimeout(run, 1000).unref?.();
}

function stopReminderWorker() {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}

module.exports = {
  REMINDER_KIND,
  REMINDER_TIME_ZONE,
  buildReminderSubject,
  formatReminderTimestamp,
  getDefaultReminderSchedule,
  getEventReminderSummary,
  getReminderStatusLabel,
  processScheduledReminders,
  scheduleEventReminder,
  startReminderWorker,
  stopReminderWorker,
  __test__: {
    formatDateKeyUtc,
    getPreviousDateKey,
    getTimeZoneParts,
    getZonedIsoString,
    withRetry
  }
};
