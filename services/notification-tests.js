'use strict';

const {
  FROM,
  ROSTER_FROM,
  buildMagicLinkEmail,
  buildRsvpInviteEmail,
  buildRsvpReminderEmail,
  buildRsvpSummaryEmail,
  sendEmail
} = require('./email');
const { getNotificationCopy } = require('./notification-settings');

const BASE_URL = process.env.BASE_URL || 'https://dunedin-euchre.com';

const TEST_NOTIFICATION_NAMES = Object.freeze({
  'sign-in': 'admin sign-in link',
  invite: 'RSVP invitation',
  reminder: 'RSVP reminder',
  summary: 'event-day RSVP summary'
});

function addTestBanner(html) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;padding:16px 28px 0;background:#ffffff;">
      <p style="margin:0;padding:12px 14px;border:2px solid #f59e0b;border-radius:6px;background:#fffbeb;color:#92400e;font-size:15px;font-weight:700;text-align:center;">
        TEST MESSAGE &mdash; No action is required
      </p>
    </div>
    ${html}
  `;
}

function requireEvent(context) {
  if (!context.event) {
    throw new Error('Create an event before sending this test email.');
  }
  return context.event;
}

function requireParticipant(context) {
  if (!context.participant) {
    throw new Error('Add an active invitee before sending this test email.');
  }
  return context.participant;
}

function buildNotificationTestEmail(type, context = {}) {
  const copy = context.copy || getNotificationCopy();
  let email;
  let from;

  if (type === 'sign-in') {
    email = buildMagicLinkEmail('test-only', {
      copy,
      link: `${BASE_URL}/admin`
    });
    from = FROM;
  } else if (type === 'invite') {
    email = buildRsvpInviteEmail(requireParticipant(context), requireEvent(context), { copy });
    from = ROSTER_FROM;
  } else if (type === 'reminder') {
    email = buildRsvpReminderEmail(requireParticipant(context), requireEvent(context), { copy });
    from = ROSTER_FROM;
  } else if (type === 'summary') {
    email = buildRsvpSummaryEmail(requireEvent(context), context.roster || [], { copy });
    from = FROM;
  } else {
    throw new Error('Unknown notification test type.');
  }

  return {
    name: TEST_NOTIFICATION_NAMES[type],
    from,
    subject: `[TEST] ${email.subject}`,
    html: addTestBanner(email.html)
  };
}

async function sendNotificationTest(type, adminEmails, context = {}) {
  const recipients = [...new Set(
    (Array.isArray(adminEmails) ? adminEmails : [])
      .map(email => String(email || '').trim())
      .filter(Boolean)
  )];
  if (recipients.length === 0) {
    throw new Error('No admin email addresses are configured.');
  }

  const testEmail = buildNotificationTestEmail(type, context);
  const response = await sendEmail({
    from: testEmail.from,
    to: recipients,
    subject: testEmail.subject,
    html: testEmail.html
  });

  return {
    ...testEmail,
    recipients,
    response
  };
}

module.exports = {
  TEST_NOTIFICATION_NAMES,
  buildNotificationTestEmail,
  sendNotificationTest
};
