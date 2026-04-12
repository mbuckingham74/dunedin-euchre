'use strict';

const MAX_PARTY_MEMBERS = 8;

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function splitNames(value) {
  return String(value || '')
    .split(/[\n,;]+/)
    .map(normalizeName)
    .filter(Boolean);
}

function uniqueNames(names) {
  const seen = new Set();
  const result = [];

  for (const name of Array.isArray(names) ? names : []) {
    const normalized = normalizeName(name);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function parseStoredNames(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return uniqueNames(value);
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return uniqueNames(parsed);
    }
  } catch (error) {
    // Fall through to plain-text parsing for legacy or hand-edited values.
  }

  return uniqueNames(splitNames(value));
}

function parsePartyMembersInput(value, fallbackName = '') {
  const parsed = uniqueNames(splitNames(value));
  if (parsed.length > 0) return parsed;

  const fallback = normalizeName(fallbackName);
  return fallback ? [fallback] : [];
}

function getPartyMembersValidationError(partyMembers) {
  if (!Array.isArray(partyMembers) || partyMembers.length === 0) {
    return 'At least one party member name is required.';
  }

  if (partyMembers.length > MAX_PARTY_MEMBERS) {
    return `Party members are limited to ${MAX_PARTY_MEMBERS} names per invite.`;
  }

  return null;
}

function serializeNames(names) {
  return JSON.stringify(uniqueNames(names));
}

function getParticipantPartyMembers(participant) {
  const stored = parseStoredNames(participant && participant.party_members);
  if (stored.length > 0) return stored;

  const fallback = normalizeName(participant && participant.name);
  return fallback ? [fallback] : [];
}

function sanitizeSelectedAttendees(participant, selectedNames) {
  const partyMembers = getParticipantPartyMembers(participant);
  const allowed = new Set(partyMembers.map(name => name.toLowerCase()));

  return uniqueNames(selectedNames).filter(name => allowed.has(name.toLowerCase()));
}

function getSelectedAttendeeNames(response, participant) {
  if (!response || response.status !== 'yes') return [];

  const selected = sanitizeSelectedAttendees(participant, parseStoredNames(response.attendee_names));
  return selected.length > 0 ? selected : getParticipantPartyMembers(participant);
}

function buildPartyResponseView(record) {
  const partyMembers = getParticipantPartyMembers(record);
  const attendeeNames = getSelectedAttendeeNames(record, record);
  const attendeeKeys = new Set(attendeeNames.map(name => name.toLowerCase()));

  let maybeNames = [];
  let declinedNames = [];
  let pendingNames = [];

  if (!record || !record.status) {
    pendingNames = partyMembers.slice();
  } else if (record.status === 'maybe') {
    maybeNames = partyMembers.slice();
  } else if (record.status === 'no') {
    declinedNames = partyMembers.slice();
  } else if (record.status === 'yes') {
    declinedNames = partyMembers.filter(name => !attendeeKeys.has(name.toLowerCase()));
  }

  return {
    ...record,
    party_members: serializeNames(partyMembers),
    partyMembers,
    partySize: partyMembers.length,
    attendeeNames,
    maybeNames,
    declinedNames,
    pendingNames
  };
}

function expandRosterIndividuals(roster) {
  const expanded = [];

  for (const entry of Array.isArray(roster) ? roster : []) {
    for (const name of entry.attendeeNames || []) {
      expanded.push({ name, status: 'yes' });
    }
    for (const name of entry.maybeNames || []) {
      expanded.push({ name, status: 'maybe' });
    }
    for (const name of entry.declinedNames || []) {
      expanded.push({ name, status: 'no' });
    }
  }

  return expanded;
}

function getIndividualCounts(roster) {
  const counts = { yes: 0, maybe: 0, no: 0, pending: 0, invited: 0, responded: 0 };

  for (const entry of Array.isArray(roster) ? roster : []) {
    counts.yes += entry.attendeeNames.length;
    counts.maybe += entry.maybeNames.length;
    counts.no += entry.declinedNames.length;
    counts.pending += entry.pendingNames.length;
    counts.invited += entry.partySize;
  }

  counts.responded = counts.invited - counts.pending;
  return counts;
}

function formatNameList(names) {
  const normalized = uniqueNames(names);
  if (normalized.length === 0) return '';
  if (normalized.length === 1) return normalized[0];
  if (normalized.length === 2) return `${normalized[0]} and ${normalized[1]}`;
  return `${normalized.slice(0, -1).join(', ')}, and ${normalized[normalized.length - 1]}`;
}

module.exports = {
  MAX_PARTY_MEMBERS,
  buildPartyResponseView,
  expandRosterIndividuals,
  formatNameList,
  getIndividualCounts,
  getParticipantPartyMembers,
  getPartyMembersValidationError,
  getSelectedAttendeeNames,
  parsePartyMembersInput,
  parseStoredNames,
  sanitizeSelectedAttendees,
  serializeNames
};
