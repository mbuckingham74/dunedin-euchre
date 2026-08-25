'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test_key';

const { buildRsvpUrl } = require('../services/links');
const {
  formatInviteDeliveryLabel,
  getEventInviteDeliveryStatus
} = require('../services/invite-status');

test('getEventInviteDeliveryStatus matches the invite email for the selected event link', async () => {
  const participant = {
    id: 66,
    name: 'Alice Lubowicz and Al',
    email: 'alubowicz1942@gmail.com'
  };
  const event = {
    id: 4,
    title: 'Dunedin Euchre Night',
    event_date: '2026-04-25',
    location_name: 'Manatee Recreation Center',
    location_address: '1512 Hillborough Trail\nThe Villages, FL 32163',
    start_time: '18:00',
    end_time: '20:30',
    arrival_notes: 'BYOB and snacks are optional'
  };
  const correctLink = buildRsvpUrl('https://dunedin-euchre.com', participant, event);

  const delivery = await getEventInviteDeliveryStatus([participant], event, {
    apiKey: 're_test_key',
    baseUrl: 'https://dunedin-euchre.com',
    listEmails: async () => ({
      has_more: false,
      data: [
        {
          id: 'email-wrong-event',
          from: 'admin@dunedin-euchre.com',
          to: ['alubowicz1942@gmail.com'],
          subject: 'Dunedin Euchre – RSVP for Dunedin Euchre Night',
          created_at: '2026-04-20 10:00:00+00',
          last_event: 'delivered'
        },
        {
          id: 'email-correct-event',
          from: 'Do_Not_Reply@dunedin-euchre.com',
          to: ['alubowicz1942@gmail.com'],
          subject: 'Dunedin Euchre – RSVP for Dunedin Euchre Night',
          created_at: '2026-04-22 23:41:49+00',
          last_event: 'delivered'
        }
      ]
    }),
    getEmail: async emailId => (
      emailId === 'email-correct-event'
        ? {
          id: emailId,
          last_event: 'delivered',
          html: correctLink,
          text: ''
        }
        : {
          id: emailId,
          last_event: 'delivered',
          html: 'https://dunedin-euchre.com/rsvp/eyJ2IjoxLCJwaWQiOjY2LCJlaWQiOjN9.1f5Fb0FCBmcleYqrGrAZXduaeiBOogCK6Nf5q-r416Q',
          text: ''
        }
    )
  });

  assert.equal(delivery.available, true);
  assert.deepEqual(delivery.summary, {
    delivered: 1,
    pending: 0,
    issue: 0,
    missing: 0
  });
  assert.equal(delivery.statuses[0].emailId, 'email-correct-event');
  assert.equal(delivery.statuses[0].label, 'Delivered');
});

test('getEventInviteDeliveryStatus marks participants as missing when no matching email exists', async () => {
  const participant = {
    id: 47,
    name: 'Mike Buckingham',
    email: 'mikebuckingham@gmail.com'
  };
  const event = {
    id: 4,
    title: 'Dunedin Euchre Night',
    event_date: '2026-04-25',
    location_name: 'Manatee Recreation Center',
    location_address: '1512 Hillborough Trail\nThe Villages, FL 32163',
    start_time: '18:00',
    end_time: '20:30',
    arrival_notes: 'BYOB and snacks are optional'
  };

  const delivery = await getEventInviteDeliveryStatus([participant], event, {
    apiKey: 're_test_key',
    baseUrl: 'https://dunedin-euchre.com',
    listEmails: async () => ({
      has_more: false,
      data: []
    }),
    getEmail: async () => {
      throw new Error('getEmail should not be called when there are no candidates');
    }
  });

  assert.deepEqual(delivery.summary, {
    delivered: 0,
    pending: 0,
    issue: 0,
    missing: 1
  });
  assert.equal(delivery.statuses[0].group, 'missing');
  assert.equal(delivery.statuses[0].label, 'Missing');
  assert.equal(delivery.statuses[0].sentAt, null);
});

test('formatInviteDeliveryLabel normalizes provider events for display', () => {
  assert.equal(formatInviteDeliveryLabel('delivered', true), 'Delivered');
  assert.equal(formatInviteDeliveryLabel('rate_limited', true), 'Rate Limited');
  assert.equal(formatInviteDeliveryLabel(null, false), 'Missing');
});
