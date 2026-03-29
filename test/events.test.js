'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test_key';

const { buildMonthlyEventHistory, getFourthSaturdayDateKey } = require('../services/events');

test('getFourthSaturdayDateKey returns the fourth Saturday for a month', () => {
  assert.equal(getFourthSaturdayDateKey(2026, 2), '2026-03-28');
  assert.equal(getFourthSaturdayDateKey(2026, 3), '2026-04-25');
  assert.equal(getFourthSaturdayDateKey(2027, 1), '2027-02-27');
});

test('buildMonthlyEventHistory keeps tonight in upcoming and generates 12 scheduled months', () => {
  const history = buildMonthlyEventHistory([
    { id: 1, event_date: '2026-02-28', title: 'February Euchre' },
    { id: 2, event_date: '2026-03-28', title: 'March Euchre' },
    { id: 3, event_date: '2026-04-25', title: 'April Euchre' }
  ], {
    referenceDate: '2026-03-28',
    monthsAhead: 12
  });

  assert.equal(history.pastEntries.length, 1);
  assert.equal(history.pastEntries[0].dateKey, '2026-02-28');
  assert.equal(history.upcomingEntries.length, 12);
  assert.equal(history.upcomingEntries[0].dateKey, '2026-03-28');
  assert.equal(history.upcomingEntries[0].isToday, true);
  assert.equal(history.upcomingEntries[1].dateKey, '2026-04-25');
  assert.equal(history.upcomingEntries[11].dateKey, '2027-02-27');
});

test('buildMonthlyEventHistory shows missing scheduled months and moves past-today schedules forward', () => {
  const history = buildMonthlyEventHistory([
    { id: 1, event_date: '2026-01-24', title: 'January Euchre' },
    { id: 2, event_date: '2026-03-28', title: 'March Euchre' }
  ], {
    referenceDate: '2026-03-29',
    monthsAhead: 2
  });

  assert.deepEqual(
    history.pastEntries.map(entry => ({ dateKey: entry.dateKey, hasEvent: entry.hasEvent })),
    [
      { dateKey: '2026-01-24', hasEvent: true },
      { dateKey: '2026-02-28', hasEvent: false },
      { dateKey: '2026-03-28', hasEvent: true }
    ]
  );
  assert.deepEqual(
    history.upcomingEntries.map(entry => entry.dateKey),
    ['2026-04-25', '2026-05-23']
  );
});
