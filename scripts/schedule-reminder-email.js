#!/usr/bin/env node
'use strict';

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../db/database');
const { sendRsvpReminder } = require('../services/email');
const {
  getEventInviteDeliveryStatus,
  getResendEmail,
  listResendEmails
} = require('../services/invite-status');
const { applyManagedLocation } = require('../services/locations');
const { getEventTitle } = require('../services/events');

const BULK_SENDS_PER_SECOND = parsePositiveInteger(process.env.RESEND_BULK_EMAILS_PER_SECOND, 4);
const BULK_DELAY_MS = Math.ceil(1000 / BULK_SENDS_PER_SECOND);
const BASE_URL = process.env.BASE_URL || 'https://dunedin-euchre.com';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const event = getEvent(options);
  const participants = listActiveParticipants();

  if (participants.length === 0) {
    throw new Error('No active participants were found.');
  }

  const delivery = await getEventInviteDeliveryStatus(participants, event, {
    baseUrl: BASE_URL,
    maxPages: 10,
    listEmails: options => withRetry(listResendEmails, [options]),
    getEmail: (emailId, options) => withRetry(getResendEmail, [emailId, options])
  });
  const recipients = getReminderRecipients(delivery.statuses, options);

  if (recipients.length === 0) {
    throw new Error('No eligible prior invite recipients were found for this event.');
  }

  printPlan(event, recipients, delivery, options);

  if (!options.confirm) {
    console.log('');
    console.log('Dry run only. Re-run with --confirm to schedule the reminder emails.');
    return;
  }

  const scheduled = [];
  const failed = [];

  for (const [index, participant] of recipients.entries()) {
    if (index > 0) {
      await wait(BULK_DELAY_MS);
    }

    try {
      const response = await sendRsvpReminder(participant, event, {
        subject: options.subject,
        scheduledAt: options.scheduledAt
      });

      scheduled.push({
        participant,
        id: response && response.id ? response.id : null
      });
      console.log(`Scheduled ${participant.email}${response && response.id ? ` (${response.id})` : ''}`);
    } catch (error) {
      failed.push({
        participant,
        error
      });
      console.error(`Failed ${participant.email}: ${error.message}`);
    }
  }

  console.log('');
  console.log(`Scheduled ${scheduled.length} reminder email${scheduled.length === 1 ? '' : 's'} for ${options.scheduledAt}.`);
  if (failed.length > 0) {
    console.log(`Failed: ${failed.length}`);
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = {
    confirm: false,
    includeIssue: false,
    eventId: null,
    eventDate: null,
    scheduledAt: null,
    subject: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--confirm') {
      options.confirm = true;
      continue;
    }

    if (argument === '--include-issue') {
      options.includeIssue = true;
      continue;
    }

    if (argument === '--event-id') {
      options.eventId = parsePositiveInteger(readValue(args, ++index, '--event-id'), null);
      continue;
    }

    if (argument === '--event-date') {
      options.eventDate = readValue(args, ++index, '--event-date');
      continue;
    }

    if (argument === '--scheduled-at') {
      options.scheduledAt = readValue(args, ++index, '--scheduled-at');
      continue;
    }

    if (argument === '--subject') {
      options.subject = readValue(args, ++index, '--subject');
      continue;
    }

    if (argument === '--help') {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!options.eventId && !options.eventDate) {
    throw new Error('Provide --event-id or --event-date.');
  }

  if (!options.scheduledAt) {
    throw new Error('Provide --scheduled-at in ISO 8601 format.');
  }

  const scheduleDate = new Date(options.scheduledAt);
  if (Number.isNaN(scheduleDate.getTime())) {
    throw new Error(`Invalid --scheduled-at value: ${options.scheduledAt}`);
  }

  return options;
}

function readValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return value;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getEvent(options) {
  if (options.eventId) {
    const byId = getEventById(options.eventId);
    if (!byId) {
      throw new Error(`Event ${options.eventId} was not found.`);
    }

    return byId;
  }

  const matches = listEventsByDate(options.eventDate);
  if (matches.length === 0) {
    throw new Error(`No event was found for ${options.eventDate}.`);
  }

  if (matches.length > 1) {
    throw new Error(`Multiple events were found for ${options.eventDate}. Re-run with --event-id.`);
  }

  return matches[0];
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

function listEventsByDate(eventDate) {
  return db.prepare(`
    SELECT
      e.*,
      l.name AS managed_location_name,
      l.address AS managed_location_address,
      l.location_image AS managed_location_image,
      l.map_embed_url AS managed_map_embed_url,
      l.map_link_url AS managed_map_link_url
    FROM events e
    LEFT JOIN locations l ON l.id = e.location_id
    WHERE e.event_date = ?
    ORDER BY e.id DESC
  `).all(eventDate).map(applyManagedLocation);
}

function listActiveParticipants() {
  return db.prepare(`
    SELECT id, name, email, rsvp_token, party_members
    FROM participants
    WHERE active = 1
    ORDER BY name ASC
  `).all();
}

function getReminderRecipients(statuses, options) {
  return statuses
    .filter(status => status && status.emailId)
    .filter(status => options.includeIssue || status.group !== 'issue')
    .map(status => status.participant);
}

function printPlan(event, recipients, delivery, options) {
  const excludedIssues = delivery.statuses.filter(status => status.group === 'issue');
  const missing = delivery.statuses.filter(status => status.group === 'missing');

  console.log(`Event: ${getEventTitle(event)} (${event.event_date})`);
  console.log(`Subject: ${options.subject || `Reminder and Last Call for ${getEventTitle(event)}`}`);
  console.log(`Scheduled for: ${options.scheduledAt}`);
  console.log(`Recipients to schedule: ${recipients.length}`);
  console.log(`Matched original invite recipients: ${delivery.statuses.filter(status => status.emailId).length}`);

  if (!options.includeIssue && excludedIssues.length > 0) {
    console.log(`Skipping issue statuses: ${excludedIssues.length}`);
  }

  if (missing.length > 0) {
    console.log(`No original invite found in Resend for: ${missing.length}`);
  }
}

function printHelp() {
  console.log('Usage: node scripts/schedule-reminder-email.js --event-date YYYY-MM-DD --scheduled-at ISO_DATE --subject "Subject line" [--confirm]');
  console.log('       node scripts/schedule-reminder-email.js --event-id 7 --scheduled-at ISO_DATE --subject "Subject line" [--confirm]');
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, args) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (attempt > 0) {
        await wait(500 * (attempt + 1));
      }

      return await fn(...args);
    } catch (error) {
      if (!(error && error.statusCode === 429) || attempt >= 5) {
        throw error;
      }
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
