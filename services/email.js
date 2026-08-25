'use strict';

const { Resend } = require('resend');
const { buildRsvpUrl } = require('./links');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.FROM_EMAIL || 'admin@dunedin-euchre.com';
const ROSTER_FROM = process.env.ROSTER_FROM_EMAIL || 'Do_Not_Reply@dunedin-euchre.com';
const ROSTER_EMAIL_NOTICE = 'Please do not reply to this message. Replies to this message are routed to an unmonitored mailbox. If you have questions please call Pam at 937-701-3301-555-1212.';
const REMINDER_DEADLINE_NOTICE = 'Please make your RSVP decision by noon today. If you are having issues, please contact Pam at 937-701-3301.';
const BASE_URL = process.env.BASE_URL || 'https://dunedin-euchre.com';
const RESEND_MAX_RETRIES = parsePositiveInteger(process.env.RESEND_MAX_RETRIES, 3);
const RESEND_RETRY_DELAY_MS = parsePositiveInteger(process.env.RESEND_RETRY_DELAY_MS, 1000);

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getStatusCode(error) {
  const statusCode = Number(error && (error.statusCode || error.status));
  return Number.isInteger(statusCode) ? statusCode : null;
}

function normalizeResendError(error) {
  if (error instanceof Error) {
    return error;
  }

  const normalized = new Error(
    error && error.message
      ? error.message
      : 'Unable to send email with Resend.'
  );
  normalized.name = error && error.name ? error.name : 'resend_error';

  const statusCode = getStatusCode(error);
  if (statusCode) {
    normalized.statusCode = statusCode;
  }

  return normalized;
}

function isRetryableResendError(error) {
  const statusCode = getStatusCode(error);
  return statusCode === 429 || statusCode >= 500 || error.name === 'application_error';
}

function getRetryDelayMs(attempt, error) {
  const multiplier = getStatusCode(error) === 429 ? attempt + 1 : 2 ** attempt;
  return RESEND_RETRY_DELAY_MS * multiplier;
}

async function sendEmail(payload, options = {}) {
  const send = options.send || (message => resend.emails.send(message));
  const wait = options.sleep || sleep;
  const maxRetries = options.maxRetries ?? RESEND_MAX_RETRIES;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await send(payload);

      if (!response || !response.error) {
        return response ? response.data : null;
      }

      throw normalizeResendError(response.error);
    } catch (error) {
      const normalizedError = normalizeResendError(error);
      if (attempt >= maxRetries || !isRetryableResendError(normalizedError)) {
        throw normalizedError;
      }

      await wait(getRetryDelayMs(attempt, normalizedError));
    }
  }
}

async function sendMagicLink(toEmail, token) {
  const link = `${BASE_URL}/admin/auth/${token}`;
  await sendEmail({
    from: FROM,
    to: toEmail,
    subject: 'Your Dunedin Euchre admin sign-in link',
    html: `
      <div style="font-family: Georgia, serif; max-width: 480px; margin: 0 auto; padding: 32px; color: #1e293b;">
        <h2 style="margin: 0 0 24px; font-size: 22px;">Dunedin Euchre &mdash; Admin Sign In</h2>
        <p style="font-size: 17px; line-height: 1.6; margin: 0 0 28px;">
          Click the button below to sign in. This link expires in <strong>15 minutes</strong> and can only be used once.
        </p>
        <a href="${link}" style="display:inline-block; background:#2563eb; color:#fff; font-size:17px; font-weight:600; padding:14px 28px; border-radius:6px; text-decoration:none;">
          Sign In to Dashboard
        </a>
        <p style="font-size: 14px; color: #64748b; margin: 28px 0 0;">
          If you didn't request this link, you can safely ignore this email.
        </p>
        <p style="font-size: 13px; color: #94a3b8; margin: 8px 0 0;">
          ${link}
        </p>
      </div>
    `
  });
}

function buildRsvpInviteEmail(participant, event) {
  const link = buildRsvpUrl(BASE_URL, participant, event);
  const dateStr = formatEventDate(event.event_date);
  const eventTitle = (event.title || '').trim() || `Dunedin Euchre on ${dateStr}`;
  const arrivalNotes = (event.arrival_notes || event.notes || '').trim();
  const subject = `Dunedin Euchre – RSVP for ${eventTitle}`;
  const html = `
    <div style="font-family: Georgia, serif; max-width: 520px; margin: 0 auto; padding: 32px; color: #1e293b;">
      <p style="font-family: Arial, sans-serif; font-size: 13px; line-height: 1.5; color: #64748b; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px 14px; margin: 0 0 24px;">
        ${ROSTER_EMAIL_NOTICE}
      </p>
      <h2 style="margin: 0 0 8px; font-size: 24px;">Dunedin Euchre</h2>
      <p style="font-size: 15px; color: #64748b; margin: 0 0 28px;">Monthly Tournament</p>

      <p style="font-size: 17px; line-height: 1.6; margin: 0 0 20px;">
        Hi ${participant.name.split(' ')[0]},
      </p>
      <p style="font-size: 17px; line-height: 1.6; margin: 0 0 24px;">
        It's time to RSVP for next month's game!
      </p>

      <table style="width:100%; border-collapse:collapse; margin: 0 0 24px; font-size:17px;">
        <tr>
          <td style="padding: 8px 12px 8px 0; color:#64748b; white-space:nowrap; vertical-align:top;">Event</td>
          <td style="padding: 8px 0; font-weight:600;">${eventTitle}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px 8px 0; color:#64748b; white-space:nowrap; vertical-align:top;">Date</td>
          <td style="padding: 8px 0; font-weight:600;">${dateStr}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px 8px 0; color:#64748b; white-space:nowrap; vertical-align:top;">Location</td>
          <td style="padding: 8px 0; font-weight:600;">${event.location_name}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px 8px 0; color:#64748b; white-space:nowrap; vertical-align:top;">Time</td>
          <td style="padding: 8px 0; font-weight:600;">${formatTime(event.start_time)} – ${formatTime(event.end_time)}</td>
        </tr>
        ${event.location_address ? `
        <tr>
          <td style="padding: 8px 12px 8px 0; color:#64748b; white-space:nowrap; vertical-align:top;">Address</td>
          <td style="padding: 8px 0;">${event.location_address.replace(/\n/g, '<br>')}</td>
        </tr>` : ''}
        ${arrivalNotes ? `
        <tr>
          <td style="padding: 8px 12px 8px 0; color:#64748b; white-space:nowrap; vertical-align:top;">Event notes</td>
          <td style="padding: 8px 0;">${arrivalNotes}</td>
        </tr>` : ''}
      </table>

      <a href="${link}" style="display:inline-block; background:#16a34a; color:#fff; font-size:18px; font-weight:600; padding:16px 32px; border-radius:6px; text-decoration:none;">
        RSVP Now &rarr;
      </a>

      <p style="font-size: 15px; color: #64748b; margin: 24px 0 8px;">
        You can see who else is coming right on the RSVP page — no sign-in required.
      </p>
      <p style="font-size: 13px; color: #94a3b8; margin: 4px 0 0;">
        Your personal link: ${link}
      </p>
    </div>
  `;

  return { subject, html };
}

function buildRsvpReminderEmail(participant, event, options = {}) {
  const link = buildRsvpUrl(BASE_URL, participant, event);
  const dateStr = formatEventDate(event.event_date);
  const eventTitle = (event.title || '').trim() || `Dunedin Euchre on ${dateStr}`;
  const arrivalNotes = (event.arrival_notes || event.notes || '').trim();
  const subject = (options.subject || '').trim() || `Reminder and Last Call for ${eventTitle}`;
  const html = `
    <div style="font-family: Georgia, serif; max-width: 520px; margin: 0 auto; padding: 32px; color: #1e293b;">
      <p style="font-family: Arial, sans-serif; font-size: 16px; font-weight: 700; line-height: 1.5; color: #dc2626; margin: 0 0 20px;">
        <strong>${REMINDER_DEADLINE_NOTICE}</strong>
      </p>
      <p style="font-family: Arial, sans-serif; font-size: 13px; line-height: 1.5; color: #64748b; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px 14px; margin: 0 0 24px;">
        ${ROSTER_EMAIL_NOTICE}
      </p>
      <h2 style="margin: 0 0 8px; font-size: 24px;">Dunedin Euchre</h2>
      <p style="font-size: 15px; color: #64748b; margin: 0 0 28px;">Reminder and Last Call</p>

      <p style="font-size: 17px; line-height: 1.6; margin: 0 0 20px;">
        Hi ${participant.name.split(' ')[0]},
      </p>
      <p style="font-size: 17px; line-height: 1.6; margin: 0 0 24px;">
        This is a reminder and last call for <strong>${eventTitle}</strong>. If you're planning to join us,
        please use your personal RSVP link below.
      </p>

      <table style="width:100%; border-collapse:collapse; margin: 0 0 24px; font-size:17px;">
        <tr>
          <td style="padding: 8px 12px 8px 0; color:#64748b; white-space:nowrap; vertical-align:top;">Event</td>
          <td style="padding: 8px 0; font-weight:600;">${eventTitle}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px 8px 0; color:#64748b; white-space:nowrap; vertical-align:top;">Date</td>
          <td style="padding: 8px 0; font-weight:600;">${dateStr}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px 8px 0; color:#64748b; white-space:nowrap; vertical-align:top;">Location</td>
          <td style="padding: 8px 0; font-weight:600;">${event.location_name}</td>
        </tr>
        <tr>
          <td style="padding: 8px 12px 8px 0; color:#64748b; white-space:nowrap; vertical-align:top;">Time</td>
          <td style="padding: 8px 0; font-weight:600;">${formatTime(event.start_time)} – ${formatTime(event.end_time)}</td>
        </tr>
        ${event.location_address ? `
        <tr>
          <td style="padding: 8px 12px 8px 0; color:#64748b; white-space:nowrap; vertical-align:top;">Address</td>
          <td style="padding: 8px 0;">${event.location_address.replace(/\n/g, '<br>')}</td>
        </tr>` : ''}
        ${arrivalNotes ? `
        <tr>
          <td style="padding: 8px 12px 8px 0; color:#64748b; white-space:nowrap; vertical-align:top;">Event notes</td>
          <td style="padding: 8px 0;">${arrivalNotes}</td>
        </tr>` : ''}
      </table>

      <a href="${link}" style="display:inline-block; background:#ea580c; color:#fff; font-size:18px; font-weight:600; padding:16px 32px; border-radius:6px; text-decoration:none;">
        RSVP Now &rarr;
      </a>

      <p style="font-size: 15px; color: #64748b; margin: 24px 0 8px;">
        If you've already replied, you can use the same link to update your RSVP before the event starts.
      </p>
      <p style="font-size: 13px; color: #94a3b8; margin: 4px 0 0;">
        Your personal link: ${link}
      </p>
    </div>
  `;

  return { subject, html };
}

async function sendRsvpInvite(participant, event) {
  const invite = buildRsvpInviteEmail(participant, event);

  return sendEmail({
    from: ROSTER_FROM,
    to: participant.email,
    subject: invite.subject,
    html: invite.html
  });
}

async function sendRsvpReminder(participant, event, options = {}) {
  const reminder = buildRsvpReminderEmail(participant, event, options);

  return sendEmail({
    from: ROSTER_FROM,
    to: participant.email,
    subject: reminder.subject,
    html: reminder.html,
    scheduledAt: options.scheduledAt
  });
}

function formatEventDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function formatTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

module.exports = {
  buildRsvpReminderEmail,
  buildRsvpInviteEmail,
  sendEmail,
  sendMagicLink,
  sendRsvpInvite,
  sendRsvpReminder,
  ROSTER_FROM,
  ROSTER_EMAIL_NOTICE,
  REMINDER_DEADLINE_NOTICE,
  formatEventDate,
  formatTime,
  __test__: {
    getRetryDelayMs,
    isRetryableResendError,
    normalizeResendError,
    sendEmail,
    sleep
  }
};
