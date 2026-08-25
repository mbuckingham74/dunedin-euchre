'use strict';

const MAX_NOTIFICATION_COPY_LENGTH = 800;

const DEFAULT_NOTIFICATION_COPY = Object.freeze({
  magic_link_message: 'Click the button below to sign in. This link expires in 15 minutes and can only be used once.',
  no_reply_notice: 'Please do not reply to this message. Replies to this message are routed to an unmonitored mailbox. If you have questions please call Pam at 937-701-3301.',
  invite_message: "It's time to RSVP for next month's game!",
  reminder_deadline_notice: 'Please make your RSVP decision by noon today. If you are having issues, please contact Pam at 937-701-3301.',
  reminder_message: "This is a reminder and last call for {{eventTitle}}. If you're planning to join us, please use your personal RSVP link below.",
  summary_message: "Here is the latest RSVP list for {{eventTitle}}."
});

const NOTIFICATION_COPY_FIELDS = Object.freeze([
  {
    key: 'magic_link_message',
    label: 'Admin sign-in message',
    description: 'Shown above the Sign In to Dashboard button.'
  },
  {
    key: 'no_reply_notice',
    label: 'No-reply notice',
    description: 'Shown near the top of RSVP invitations and reminder emails.'
  },
  {
    key: 'invite_message',
    label: 'RSVP invitation message',
    description: 'The main sentence guests see before the event details.'
  },
  {
    key: 'reminder_deadline_notice',
    label: 'Reminder deadline notice',
    description: 'The bold red message shown first in reminder emails.'
  },
  {
    key: 'reminder_message',
    label: 'Reminder message',
    description: 'The main reminder paragraph. You can use {{eventTitle}}.'
  },
  {
    key: 'summary_message',
    label: 'Event-day summary message',
    description: 'Shown above the Coming and Declined tables. You can use {{eventTitle}}.'
  }
]);

function renderNotificationCopy(template, variables = {}) {
  return String(template || '').replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(variables, key)
      ? String(variables[key] ?? '')
      : match
  ));
}

module.exports = {
  DEFAULT_NOTIFICATION_COPY,
  MAX_NOTIFICATION_COPY_LENGTH,
  NOTIFICATION_COPY_FIELDS,
  renderNotificationCopy
};
