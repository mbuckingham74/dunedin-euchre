'use strict';

const { randomUUID } = require('node:crypto');
const db = require('../db/database');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function createDeliveryAttempt(details = {}) {
  if (details.purpose === 'invitation' && details.eventId && details.participantId) {
    const unresolved = db.prepare(`
      SELECT delivery_key
      FROM email_delivery_history
      WHERE provider = 'smtp2go'
        AND purpose = 'invitation'
        AND event_id = ?
        AND participant_id = ?
        AND delivery_status IN ('sending', 'ambiguous')
      ORDER BY id DESC
      LIMIT 1
    `).get(details.eventId, details.participantId);

    if (unresolved) {
      const error = new Error(
        'The previous invitation result is uncertain. Check delivery status before sending it again.'
      );
      error.name = 'email_delivery_ambiguous_error';
      error.deliveryKey = unresolved.delivery_key;
      throw error;
    }
  }

  const deliveryKey = randomUUID();
  db.prepare(`
    INSERT INTO email_delivery_history (
      delivery_key,
      provider,
      purpose,
      event_id,
      participant_id,
      recipient_email,
      subject,
      delivery_status
    )
    VALUES (?, 'smtp2go', ?, ?, ?, ?, ?, 'sending')
  `).run(
    deliveryKey,
    String(details.purpose || 'other'),
    details.eventId || null,
    details.participantId || null,
    normalizeEmail(details.recipientEmail),
    String(details.subject || '')
  );

  return { deliveryKey };
}

function markDeliveryAccepted(deliveryKey, result = {}) {
  const providerMessageId = String(result.providerMessageId || '').trim();
  if (!providerMessageId) {
    throw new Error('A provider message ID is required to record an accepted email.');
  }

  db.prepare(`
    UPDATE email_delivery_history
    SET provider_message_id = ?,
        delivery_status = 'accepted',
        last_event = NULL,
        sent_at = COALESCE(?, sent_at, datetime('now')),
        last_error = NULL,
        updated_at = datetime('now')
    WHERE delivery_key = ?
  `).run(providerMessageId, result.sentAt || null, deliveryKey);
}

function markDeliveryFailed(deliveryKey, error) {
  const ambiguous = Boolean(error && error.ambiguous);
  db.prepare(`
    UPDATE email_delivery_history
    SET delivery_status = ?,
        last_error = ?,
        updated_at = datetime('now')
    WHERE delivery_key = ?
  `).run(
    ambiguous ? 'ambiguous' : 'failed',
    String(error && error.message || 'Email send failed').slice(0, 1000),
    deliveryKey
  );
}

function listInvitationDeliveries(eventId, recipientEmails = []) {
  const normalizedRecipients = [...new Set(recipientEmails.map(normalizeEmail).filter(Boolean))];
  if (normalizedRecipients.length === 0) return [];

  const recipients = new Set(normalizedRecipients);
  return db.prepare(`
    SELECT *
    FROM email_delivery_history
    WHERE purpose = 'invitation'
      AND event_id = ?
    ORDER BY COALESCE(sent_at, created_at) DESC, id DESC
  `).all(eventId).filter(record => recipients.has(normalizeEmail(record.recipient_email)));
}

function listEventInvitationDeliveries(eventId) {
  return db.prepare(`
    SELECT *
    FROM email_delivery_history
    WHERE purpose = 'invitation' AND event_id = ?
    ORDER BY COALESCE(sent_at, created_at) DESC, id DESC
  `).all(eventId);
}

function updateDeliveryFromActivity(deliveryRowId, activity = {}) {
  const providerMessageId = String(activity.providerMessageId || '').trim() || null;
  const lastEvent = String(activity.event || '').trim().toLowerCase() || null;
  const eventDate = activity.date || null;
  const deliveryStatus = lastEvent || (providerMessageId ? 'processed' : 'ambiguous');

  db.prepare(`
    UPDATE email_delivery_history
    SET provider_message_id = COALESCE(?, provider_message_id),
        delivery_status = ?,
        last_event = ?,
        last_event_at = COALESCE(?, last_event_at),
        sent_at = COALESCE(sent_at, ?),
        last_error = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    providerMessageId,
    deliveryStatus,
    lastEvent,
    eventDate,
    eventDate,
    deliveryRowId
  );
}

module.exports = {
  createDeliveryAttempt,
  listEventInvitationDeliveries,
  listInvitationDeliveries,
  markDeliveryAccepted,
  markDeliveryFailed,
  normalizeEmail,
  updateDeliveryFromActivity
};
