#!/usr/bin/env node
'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../db/database');
const { getEventInviteDeliveryStatus } = require('../services/invite-status');
const { applyManagedLocation } = require('../services/locations');
const { getEventTitle } = require('../services/events');
const { scheduleEventReminder } = require('../services/reminders');

const BASE_URL = process.env.BASE_URL || 'https://dunedin-euchre.com';

async function main(options) {
  const event = getEvent(options);
  const participants = listActiveParticipants();

  if (participants.length === 0) {
    throw new Error('No active participants were found.');
  }

  const delivery = await getEventInviteDeliveryStatus(participants, event, {
    baseUrl: BASE_URL
  });
  const recipients = getReminderRecipients(delivery.statuses, options);

  if (recipients.length === 0) {
    throw new Error('No eligible prior invite recipients were found for this event.');
  }

  printPlan(event, recipients, delivery, options);

  if (!options.confirm) {
    console.log('');
    console.log('Dry run only. No reminder was queued. Re-run with --confirm to queue it in SQLite.');
    return;
  }

  const result = await scheduleEventReminder(event, participants, {
    scheduledAt: options.scheduledAt,
    subject: options.subject,
    includeIssue: options.includeIssue,
    delivery,
    baseUrl: BASE_URL
  });

  console.log('');
  console.log(
    `Queued ${result.recipients.length} reminder email${result.recipients.length === 1 ? '' : 's'} `
      + `in SQLite for ${result.schedule.scheduledAt}.`
  );
  console.log('The application worker will send them at the scheduled time.');
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
    } else if (argument === '--include-issue') {
      options.includeIssue = true;
    } else if (argument === '--event-id') {
      options.eventId = parsePositiveInteger(readValue(args, ++index, argument), null);
    } else if (argument === '--event-date') {
      options.eventDate = readValue(args, ++index, argument);
    } else if (argument === '--scheduled-at') {
      options.scheduledAt = readValue(args, ++index, argument);
    } else if (argument === '--subject') {
      options.subject = readValue(args, ++index, argument);
    } else if (argument === '--help') {
      printHelp();
      return null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
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
  if (scheduleDate.getTime() <= Date.now()) {
    throw new Error('--scheduled-at must be in the future.');
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
    const event = getEventById(options.eventId);
    if (!event) throw new Error(`Event ${options.eventId} was not found.`);
    return event;
  }

  const matches = listEventsByDate(options.eventDate);
  if (matches.length === 0) throw new Error(`No event was found for ${options.eventDate}.`);
  if (matches.length > 1) {
    throw new Error(`Multiple events were found for ${options.eventDate}. Re-run with --event-id.`);
  }
  return matches[0];
}

function getEventById(eventId) {
  return applyManagedLocation(db.prepare(`
    SELECT e.*, l.name AS managed_location_name, l.address AS managed_location_address,
           l.location_image AS managed_location_image, l.map_embed_url AS managed_map_embed_url,
           l.map_link_url AS managed_map_link_url
    FROM events e
    LEFT JOIN locations l ON l.id = e.location_id
    WHERE e.id = ?
  `).get(eventId));
}

function listEventsByDate(eventDate) {
  return db.prepare(`
    SELECT e.*, l.name AS managed_location_name, l.address AS managed_location_address,
           l.location_image AS managed_location_image, l.map_embed_url AS managed_map_embed_url,
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
  console.log(`Scheduled for: ${new Date(options.scheduledAt).toISOString()}`);
  console.log(`Recipients to queue: ${recipients.length}`);
  console.log(`Matched original invite recipients: ${delivery.statuses.filter(status => status.emailId).length}`);
  if (delivery.error) console.log(`Live delivery refresh warning: ${delivery.error}`);
  if (!options.includeIssue && excludedIssues.length > 0) {
    console.log(`Skipping issue statuses: ${excludedIssues.length}`);
  }
  if (missing.length > 0) {
    console.log(`No original invitation found in local delivery history: ${missing.length}`);
  }
}

function printHelp() {
  console.log('Usage: npm run schedule:reminder -- --event-date YYYY-MM-DD --scheduled-at ISO_DATE [--subject "Subject"] [--confirm]');
  console.log('       npm run schedule:reminder -- --event-id 7 --scheduled-at ISO_DATE [--subject "Subject"] [--confirm]');
  console.log('Without --confirm, the command prints a dry run. With --confirm, it queues in SQLite; SMTP2GO sends only when due.');
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options) {
      main(options).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
      }).finally(() => {
        db.close();
      });
    } else {
      db.close();
    }
  } catch (error) {
    console.error(error.message);
    db.close();
    process.exitCode = 1;
  }
}

module.exports = { getReminderRecipients, parseArgs };
