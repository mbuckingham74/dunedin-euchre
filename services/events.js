'use strict';

const { formatEventDate, formatTime } = require('./email');

function parseDateString(dateStr) {
  const [year, month, day] = (dateStr || '').split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 12);
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getMonthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1, 12);
}

function addMonths(date, monthCount) {
  return new Date(date.getFullYear(), date.getMonth() + monthCount, 1, 12);
}

function getFourthSaturdayDate(year, monthIndex) {
  const firstOfMonth = new Date(year, monthIndex, 1, 12);
  const firstSaturdayOffset = (6 - firstOfMonth.getDay() + 7) % 7;
  return new Date(year, monthIndex, 1 + firstSaturdayOffset + 21, 12);
}

function getFourthSaturdayDateKey(year, monthIndex) {
  return formatDateKey(getFourthSaturdayDate(year, monthIndex));
}

function normalizeReferenceDate(referenceDate) {
  if (referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())) {
    return new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate(), 12);
  }

  const parsed = parseDateString(referenceDate);
  if (parsed) return parsed;

  const fallback = new Date();
  return new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate(), 12);
}

function buildMonthlyEventHistory(events, options = {}) {
  const normalizedEvents = Array.isArray(events)
    ? events
      .filter(event => event && event.event_date)
      .slice()
      .sort((left, right) => (
        left.event_date.localeCompare(right.event_date) ||
        Number(left.id || 0) - Number(right.id || 0)
      ))
    : [];

  const monthsAhead = Number.isInteger(options.monthsAhead) && options.monthsAhead > 0
    ? options.monthsAhead
    : 12;

  const referenceDate = normalizeReferenceDate(options.referenceDate);
  const todayKey = formatDateKey(referenceDate);
  const currentMonth = getMonthStart(referenceDate);
  const currentScheduledDateKey = getFourthSaturdayDateKey(
    currentMonth.getFullYear(),
    currentMonth.getMonth()
  );
  const firstUpcomingMonth = currentScheduledDateKey >= todayKey
    ? currentMonth
    : addMonths(currentMonth, 1);
  const firstRecordedMonth = normalizedEvents.length > 0
    ? getMonthStart(parseDateString(normalizedEvents[0].event_date))
    : null;
  const startMonth = firstRecordedMonth && firstRecordedMonth < firstUpcomingMonth
    ? firstRecordedMonth
    : firstUpcomingMonth;
  const endMonth = addMonths(firstUpcomingMonth, monthsAhead - 1);
  const eventsByDate = new Map();

  for (const event of normalizedEvents) {
    if (!eventsByDate.has(event.event_date)) {
      eventsByDate.set(event.event_date, []);
    }
    eventsByDate.get(event.event_date).push(event);
  }

  const entries = [];
  for (let cursor = startMonth; cursor <= endMonth; cursor = addMonths(cursor, 1)) {
    const date = getFourthSaturdayDate(cursor.getFullYear(), cursor.getMonth());
    const dateKey = formatDateKey(date);
    const scheduledEvents = eventsByDate.get(dateKey) || [];

    entries.push({
      date,
      dateKey,
      formattedDate: formatEventDate(dateKey),
      hasEvent: scheduledEvents.length > 0,
      isPast: dateKey < todayKey,
      isToday: dateKey === todayKey,
      isUpcoming: dateKey >= todayKey,
      events: scheduledEvents,
      primaryEvent: scheduledEvents[0] || null
    });
  }

  return {
    entries,
    pastEntries: entries.filter(entry => entry.isPast),
    upcomingEntries: entries.filter(entry => entry.isUpcoming),
    todayKey,
    startDateKey: entries.length > 0 ? entries[0].dateKey : null,
    endDateKey: entries.length > 0 ? entries[entries.length - 1].dateKey : null
  };
}

function getEventTitle(event) {
  const title = (event && event.title ? event.title : '').trim();
  if (title) return title;

  if (event && event.event_date) {
    return `Dunedin Euchre on ${formatEventDate(event.event_date)}`;
  }

  return 'Dunedin Euchre';
}

function getArrivalNotes(event) {
  return (event && (event.arrival_notes || event.notes) ? (event.arrival_notes || event.notes) : '').trim();
}

function getEventClockParts(referenceDate = new Date(), timeZone = process.env.EVENT_TIMEZONE || 'America/New_York') {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

  const parts = formatter.formatToParts(referenceDate).reduce((accumulator, part) => {
    if (part.type !== 'literal') {
      accumulator[part.type] = part.value;
    }
    return accumulator;
  }, {});

  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    timeKey: `${parts.hour}:${parts.minute}`
  };
}

function hasEventStarted(event, options = {}) {
  if (!event || !event.event_date || !event.start_time) return false;

  const { dateKey, timeKey } = getEventClockParts(options.referenceDate, options.timeZone);
  if (event.event_date < dateKey) return true;
  if (event.event_date > dateKey) return false;

  return event.start_time <= timeKey;
}

function getEventStartLabel(event) {
  if (!event || !event.event_date || !event.start_time) return '';
  return `${formatEventDate(event.event_date)} at ${formatTime(event.start_time)}`;
}

function isEventPublished(event) {
  return Boolean(event && Number(event.is_published));
}

function isPublicRosterVisible(event) {
  return Boolean(event && Number(event.show_public_roster));
}

const MIN_PUBLIC_SLUG_LENGTH = 3;
const MAX_PUBLIC_SLUG_LENGTH = 80;
const RESERVED_PUBLIC_SLUGS = new Set([
  'admin',
  'e',
  'event',
  'events',
  'favicon-ico',
  'images',
  'js',
  'manifest-json',
  'public',
  'rsvp',
  'styles',
  'sw-js',
  'uploads'
]);

function normalizePublicSlug(value) {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;

  const ascii = trimmed
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

  const slug = ascii
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || null;
}

function parsePublicSlugInput(value) {
  const rawValue = (value || '').trim();
  if (!rawValue) {
    return { value: null, error: null };
  }

  const normalized = normalizePublicSlug(rawValue);
  if (!normalized) {
    return {
      value: null,
      error: 'Public URL slug must include at least one letter or number.'
    };
  }

  if (normalized.length < MIN_PUBLIC_SLUG_LENGTH || normalized.length > MAX_PUBLIC_SLUG_LENGTH) {
    return {
      value: null,
      error: `Public URL slug must be ${MIN_PUBLIC_SLUG_LENGTH}-${MAX_PUBLIC_SLUG_LENGTH} characters after cleanup.`
    };
  }

  if (/^\d+$/.test(normalized)) {
    return {
      value: null,
      error: 'Public URL slug cannot be only numbers.'
    };
  }

  if (RESERVED_PUBLIC_SLUGS.has(normalized)) {
    return {
      value: null,
      error: 'That public URL slug is reserved. Choose something more specific.'
    };
  }

  return { value: normalized, error: null };
}

module.exports = {
  buildMonthlyEventHistory,
  getFourthSaturdayDateKey,
  getArrivalNotes,
  getEventStartLabel,
  getEventTitle,
  hasEventStarted,
  isEventPublished,
  isPublicRosterVisible,
  normalizePublicSlug,
  parsePublicSlugInput
};
