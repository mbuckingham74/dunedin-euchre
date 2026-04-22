'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const db = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { sendMagicLink, sendRsvpInvite, buildRsvpInviteEmail, formatEventDate, formatTime } = require('../services/email');
const {
  buildMonthlyEventHistory,
  getArrivalNotes,
  getEventTitle,
  isEventPublished,
  isPublicRosterVisible,
  parsePublicSlugInput
} = require('../services/events');
const { buildPublicEventPath, buildRsvpPath } = require('../services/links');
const {
  buildPartyResponseView,
  getIndividualCounts,
  getParticipantPartyMembers,
  getPartyMembersValidationError,
  parsePartyMembersInput,
  serializeNames
} = require('../services/party');
const {
  isPublicSlugConflictError,
  listEventPublicSlugs,
  reserveEventPublicSlug
} = require('../services/public-slugs');
const {
  applyManagedLocation,
  applyManagedLocations,
  buildLocationMapEmbedUrl,
  buildLocationMapLinkUrl,
  normalizeLocationAddress
} = require('../services/locations');
const { getUploadsDir } = require('../services/uploads');

const router = express.Router();

const BASE_URL = process.env.BASE_URL || 'https://dunedin-euchre.com';
const ADMIN_EMAILS = (process.env.ADMIN_EMAIL || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const TEST_EVENT_PREFIX = '[TEST]';
const DEFAULT_TESTING_PARTICIPANT_EMAIL = 'mikebuckingham@gmail.com';
const uploadsDir = getUploadsDir();

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ── File upload (location images) ────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${file.fieldname}-${Date.now()}-${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  }
});

const locationUpload = upload.fields([
  { name: 'location_image', maxCount: 1 }
]);

// ── Rate limit magic link requests ───────────────────────────
const magicLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many requests. Please wait 15 minutes and try again.'
});

// ── Helpers ──────────────────────────────────────────────────
const EVENT_SELECT_FIELDS = `
  e.*,
  l.name AS managed_location_name,
  l.address AS managed_location_address,
  l.location_image AS managed_location_image,
  l.map_embed_url AS managed_map_embed_url,
  l.map_link_url AS managed_map_link_url
`;

function getMostRecentEvent() {
  return listProductionEvents()[0] || null;
}

function getEventById(eventId) {
  return applyManagedLocation(db.prepare(`
    SELECT ${EVENT_SELECT_FIELDS}
    FROM events e
    LEFT JOIN locations l ON l.id = e.location_id
    WHERE e.id = ?
  `).get(eventId));
}

function listEvents() {
  return applyManagedLocations(db.prepare(`
    SELECT ${EVENT_SELECT_FIELDS}
    FROM events e
    LEFT JOIN locations l ON l.id = e.location_id
    ORDER BY e.event_date DESC, e.id DESC
  `).all());
}

function listProductionEvents() {
  return listEvents().filter(event => !isTestEvent(event));
}

function listTestingEvents() {
  return listEvents().filter(isTestEvent);
}

function listEventsWithResponseStats() {
  return listEvents()
    .slice()
    .sort((left, right) => (
      left.event_date.localeCompare(right.event_date) ||
      Number(left.id) - Number(right.id)
    ))
    .map(event => {
      const { counts } = getRosterWithCounts(event.id);
      return {
        ...event,
        yes_count: counts.yes,
        maybe_count: counts.maybe,
        no_count: counts.no,
        response_count: counts.yes + counts.maybe + counts.no
      };
    });
}

function listLocations() {
  return db.prepare(`
    SELECT *
    FROM locations
    ORDER BY name ASC, id ASC
  `).all();
}

function listLocationsWithEventCounts() {
  return db.prepare(`
    SELECT
      l.*,
      COUNT(e.id) AS event_count
    FROM locations l
    LEFT JOIN events e ON e.location_id = l.id
    GROUP BY l.id
    ORDER BY l.name ASC, l.id ASC
  `).all().map(row => ({
    ...row,
    event_count: Number(row.event_count || 0)
  }));
}

function getLocationById(locationId) {
  return db.prepare('SELECT * FROM locations WHERE id = ?').get(locationId);
}

function getDashboardEvent(requestedEventId) {
  if (requestedEventId) {
    const event = getEventById(requestedEventId);
    return event && !isTestEvent(event) ? event : null;
  }
  return getMostRecentEvent();
}

function parseEventId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseLocationId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseParticipantId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

function normalizeText(value) {
  const trimmed = (value || '').trim();
  return trimmed ? trimmed : null;
}

function normalizeParticipantInput(body) {
  const name = (body.name || '').trim();
  const email = normalizeEmail(body.email);
  const partyMembers = parsePartyMembersInput(body.party_members, name);

  return {
    name,
    email,
    partyMembers,
    partyMembersJson: serializeNames(partyMembers)
  };
}

function normalizeEventInput(body) {
  const publicSlug = parsePublicSlugInput(body.public_slug);

  return {
    title: normalizeText(body.title),
    public_slug: publicSlug.value,
    public_slug_error: publicSlug.error,
    event_date: (body.event_date || '').trim(),
    location_id: parseLocationId(body.location_id),
    location_name: normalizeText(body.location_name),
    location_address: normalizeLocationAddress(body.location_address),
    start_time: (body.start_time || '').trim(),
    end_time: (body.end_time || '').trim(),
    arrival_notes: normalizeText(body.arrival_notes),
    is_published: body.is_published ? 1 : 0,
    show_public_roster: body.show_public_roster ? 1 : 0
  };
}

function getEventValidationError(eventInput) {
  if (!(
    eventInput.title &&
    eventInput.event_date &&
    (eventInput.location_id || eventInput.location_name) &&
    eventInput.start_time &&
    eventInput.end_time
  )) {
    return 'Title, date, location, and start/end time are required.';
  }

  return eventInput.public_slug_error || null;
}

function getParticipantValidationError(participantInput) {
  if (!participantInput.name || !participantInput.email) {
    return 'Name and email are required.';
  }

  return getPartyMembersValidationError(participantInput.partyMembers);
}

function normalizeLocationInput(body) {
  const address = normalizeLocationAddress(body.address);

  return {
    name: normalizeText(body.name),
    address,
    map_embed_url: buildLocationMapEmbedUrl(address),
    map_link_url: buildLocationMapLinkUrl(address)
  };
}

function getLocationValidationError(locationInput) {
  if (!(locationInput.name && locationInput.address)) {
    return 'Location name and address are required.';
  }

  return null;
}

function resolveEventLocationDetails(eventInput, existingEvent = null) {
  if (eventInput.location_id) {
    const location = getLocationById(eventInput.location_id);
    if (!location) {
      return { error: 'That saved location no longer exists. Choose another one.' };
    }

    return {
      location_id: location.id,
      location_name: location.name,
      location_address: normalizeLocationAddress(location.address),
      location_image: location.location_image || null,
      map_embed_url: location.map_embed_url || null,
      map_link_url: location.map_link_url || null
    };
  }

  const fallbackAddress = eventInput.location_address || (existingEvent ? existingEvent.location_address : null);

  return {
    location_id: existingEvent ? existingEvent.location_id : null,
    location_name: eventInput.location_name || (existingEvent ? existingEvent.location_name : null),
    location_address: fallbackAddress,
    location_image: existingEvent ? existingEvent.location_image : null,
    map_embed_url: buildLocationMapEmbedUrl(fallbackAddress) || (existingEvent ? existingEvent.map_embed_url : null),
    map_link_url: buildLocationMapLinkUrl(fallbackAddress) || (existingEvent ? existingEvent.map_link_url : null)
  };
}

function isPublicSlugUniqueConstraint(error) {
  return Boolean(error && (
    error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
  ));
}

function getUploadedFilename(files, fieldName) {
  return files && files[fieldName] && files[fieldName][0]
    ? files[fieldName][0].filename
    : null;
}

function getUploadedFilenames(files) {
  if (!files) return [];

  return Object.values(files)
    .flat()
    .map(file => file && file.filename)
    .filter(Boolean);
}

function removeUploadedFile(filename) {
  if (!filename) return;

  const filepath = path.join(uploadsDir, filename);
  try {
    fs.unlinkSync(filepath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Unable to remove upload ${filename}:`, error.message);
    }
  }
}

function cleanupUploadedFiles(files) {
  for (const filename of getUploadedFilenames(files)) {
    removeUploadedFile(filename);
  }
}

function countUploadedFileReferences(filename, options = {}) {
  if (!filename) return 0;

  const locationRef = options.excludeLocationId
    ? db.prepare(`
      SELECT COUNT(*) AS count
      FROM locations
      WHERE location_image = ? AND id != ?
    `).get(filename, options.excludeLocationId)
    : db.prepare(`
      SELECT COUNT(*) AS count
      FROM locations
      WHERE location_image = ?
    `).get(filename);

  const eventRef = db.prepare(`
    SELECT COUNT(*) AS count
    FROM events
    WHERE location_image = ?
  `).get(filename);

  return Number(locationRef.count || 0) + Number(eventRef.count || 0);
}

function removeUploadedFileIfUnused(filename, options = {}) {
  if (!filename) return;

  if (countUploadedFileReferences(filename, options) === 0) {
    removeUploadedFile(filename);
  }
}

function countEventMapImageReferences(filename, options = {}) {
  if (!filename) return 0;

  const row = options.excludeEventId
    ? db.prepare(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE map_image = ? AND id != ?
    `).get(filename, options.excludeEventId)
    : db.prepare(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE map_image = ?
    `).get(filename);

  return Number(row.count || 0);
}

function removeEventMapImageIfUnused(filename, options = {}) {
  if (!filename) return;

  if (countEventMapImageReferences(filename, options) === 0) {
    removeUploadedFile(filename);
  }
}

function resolveUpdatedImage(existingFilename, uploadedFilename, removeRequested) {
  const nextFilename = uploadedFilename || (removeRequested ? null : existingFilename);
  const replacedFilename = existingFilename && existingFilename !== nextFilename
    ? existingFilename
    : null;

  return { nextFilename, replacedFilename };
}

function getParticipantByEmail(email) {
  return db.prepare('SELECT * FROM participants WHERE email = ? COLLATE NOCASE').get(email);
}

function getParticipantById(participantId) {
  return db.prepare(`
    SELECT *
    FROM participants
    WHERE id = ? AND active = 1
  `).get(participantId);
}

function getRosterWithCounts(eventId) {
  const roster = db.prepare(`
    SELECT p.id, p.name, p.email, p.rsvp_token, p.party_members,
           r.status, r.comment, r.change_count, r.responded_at, r.updated_at, r.attendee_names
    FROM participants p
    LEFT JOIN responses r ON r.participant_id = p.id AND r.event_id = ?
    WHERE p.active = 1
    ORDER BY p.name ASC
  `).all(eventId).map(buildPartyResponseView);

  const individualCounts = getIndividualCounts(roster);
  const counts = {
    yes: individualCounts.yes,
    no: individualCounts.no,
    maybe: individualCounts.maybe,
    none: individualCounts.pending
  };

  return { roster, counts };
}

function listActiveParticipants() {
  return db.prepare(`
    SELECT id, name, email, created_at, party_members
    FROM participants
    WHERE active = 1
    ORDER BY name ASC
  `).all();
}

function getInvitePreviewParticipant(participants, participantId) {
  const parsedParticipantId = parseParticipantId(participantId);
  if (!parsedParticipantId) {
    return participants[0] || null;
  }

  return participants.find(entry => entry.id === parsedParticipantId) || participants[0] || null;
}

function listRecentResponses(roster, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? options.limit
    : 5;

  return (Array.isArray(roster) ? roster : [])
    .filter(entry => entry && entry.status)
    .slice()
    .sort((left, right) => (
      String(right.updated_at || '').localeCompare(String(left.updated_at || '')) ||
      String(left.name || '').localeCompare(String(right.name || ''))
    ))
    .slice(0, limit);
}

function buildDashboardRedirect(eventId) {
  return eventId ? `/admin/dashboard?eventId=${eventId}` : '/admin/dashboard';
}

function buildParticipantsRedirect(eventId) {
  return eventId ? `/admin/participants?eventId=${eventId}` : '/admin/participants';
}

function buildEventsRedirect(options = {}) {
  const searchParams = new URLSearchParams();
  if (options.createDate) {
    searchParams.set('createDate', options.createDate);
  }

  const query = searchParams.toString();
  return query ? `/admin/events?${query}` : '/admin/events';
}

function buildEventsCreateRedirect(dateKey) {
  return `${buildEventsRedirect({ createDate: dateKey })}#scheduled-${dateKey}`;
}

function shouldReturnToEvents(body) {
  return body && body.return_to === 'events';
}

function shouldReturnToTesting(body) {
  return body && body.return_to === 'testing';
}

function buildTestingRedirect(eventId, participantId) {
  const searchParams = new URLSearchParams();
  const normalizedEventId = parseEventId(eventId);
  const normalizedParticipantId = parseParticipantId(participantId);

  if (normalizedEventId) {
    searchParams.set('eventId', String(normalizedEventId));
  }
  if (normalizedParticipantId) {
    searchParams.set('participantId', String(normalizedParticipantId));
  }

  const query = searchParams.toString();
  return query ? `/admin/testing?${query}` : '/admin/testing';
}

function getDateKeyInTimeZone(referenceDate = new Date(), timeZone = process.env.EVENT_TIMEZONE || 'America/New_York') {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(referenceDate).reduce((accumulator, part) => {
    if (part.type !== 'literal') {
      accumulator[part.type] = part.value;
    }
    return accumulator;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getSafeTestEventDate(sourceEventDate) {
  const todayKey = getDateKeyInTimeZone();
  if (sourceEventDate && sourceEventDate > todayKey) {
    return sourceEventDate;
  }

  return getDateKeyInTimeZone(new Date(Date.now() + 14 * 24 * 60 * 60 * 1000));
}

function isTestEvent(event) {
  return Boolean(event && String(event.title || '').trim().startsWith(TEST_EVENT_PREFIX));
}

function buildTestEventTitle(event) {
  const sourceTitle = event
    ? getEventTitle(event).replace(/^\[TEST\]\s*/i, '').trim()
    : 'Dunedin Euchre Night';
  return `${TEST_EVENT_PREFIX} ${sourceTitle}`;
}

function getTestingEvent(allEvents, requestedEventId) {
  if (requestedEventId) {
    const event = getEventById(requestedEventId);
    return event && isTestEvent(event) ? event : null;
  }

  const testEvent = allEvents.find(isTestEvent);
  return testEvent || allEvents[0] || null;
}

function getTestingParticipant(requestedParticipantId) {
  const participantId = parseParticipantId(requestedParticipantId);
  if (participantId) return getParticipantById(participantId);

  const participants = listActiveParticipants();
  if (participants.length === 0) {
    return null;
  }

  const preferredParticipant = participants.find(participant => (
    normalizeEmail(participant.email) === DEFAULT_TESTING_PARTICIPANT_EMAIL
  ));
  const selectedParticipant = preferredParticipant || participants[0];
  return getParticipantById(selectedParticipant.id);
}

// ── GET /admin ───────────────────────────────────────────────
router.get('/', (req, res) => {
  if (req.session && req.session.adminAuthenticated) {
    return res.redirect('/admin/dashboard');
  }
  res.render('admin/login', { error: null, sent: false });
});

// ── POST /admin/request-link ─────────────────────────────────
router.post('/request-link', magicLinkLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);

  // Always show "sent" regardless of whether email matches (no enumeration)
  if (!ADMIN_EMAILS.includes(email)) {
    return res.render('admin/login', { error: null, sent: true });
  }

  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO admin_tokens (token, expires_at, used) VALUES (?, ?, 0)')
    .run(token, expiresAt);

  try {
    await sendMagicLink(email, token);
  } catch (err) {
    console.error('Failed to send magic link:', err);
  }

  res.render('admin/login', { error: null, sent: true });
});

// ── GET /admin/auth/:token ───────────────────────────────────
router.get('/auth/:token', (req, res) => {
  const row = db.prepare(`
    SELECT * FROM admin_tokens
    WHERE token = ? AND used = 0 AND expires_at > datetime('now')
  `).get(req.params.token);

  if (!row) {
    return res.render('admin/login', {
      error: 'This sign-in link has expired or already been used. Please request a new one.',
      sent: false
    });
  }

  db.prepare('UPDATE admin_tokens SET used = 1 WHERE token = ?').run(row.token);

  req.session.adminAuthenticated = true;

  res.redirect('/admin/dashboard');
});

// ── GET /admin/dashboard ─────────────────────────────────────
router.get('/dashboard', requireAdmin, (req, res) => {
  const requestedEventId = parseEventId(req.query.eventId);
  const allEvents = listProductionEvents();
  const locations = listLocationsWithEventCounts();
  const requestedRawEvent = requestedEventId ? getEventById(requestedEventId) : null;
  if (requestedRawEvent && isTestEvent(requestedRawEvent)) {
    return res.redirect(buildTestingRedirect(requestedRawEvent.id));
  }
  const event = requestedEventId
    ? requestedRawEvent
    : (allEvents[0] || null);
  const inviteParticipants = listActiveParticipants();

  if (requestedEventId && !event) {
    return res.status(404).send('<h1 style="font-family:sans-serif;padding:2rem">Event not found.</h1>');
  }

  let roster = [];
  let counts = { yes: 0, no: 0, maybe: 0, none: 0 };
  let publicSlugHistory = [];
  let previousPublicSlugs = [];
  let recentResponses = [];

  if (event) {
    ({ roster, counts } = getRosterWithCounts(event.id));
    publicSlugHistory = listEventPublicSlugs(event.id);
    previousPublicSlugs = publicSlugHistory.filter(entry => !Number(entry.is_current));
    recentResponses = listRecentResponses(roster, { limit: 5 });
  }

  const dashboardSchedule = buildMonthlyEventHistory(allEvents, { monthsAhead: 3 });
  const upcomingDashboardEntries = dashboardSchedule.upcomingEntries.slice(0, 3);
  const rosterPreview = inviteParticipants.slice(0, 5);
  const locationHighlights = locations
    .slice()
    .sort((left, right) => (
      Number(right.event_count || 0) - Number(left.event_count || 0) ||
      left.name.localeCompare(right.name)
    ))
    .slice(0, 3);

  res.render('admin/dashboard', {
    event,
    roster,
    counts,
    locations,
    inviteParticipants,
    rosterPreview,
    locationHighlights,
    recentResponses,
    upcomingDashboardEntries,
    publicSlugHistory,
    previousPublicSlugs,
    allEvents,
    selectedEventId: event ? event.id : null,
    formatEventDate,
    formatTime,
    getEventTitle,
    getArrivalNotes,
    isEventPublished,
    isPublicRosterVisible,
    buildPublicEventPath,
    baseUrl: BASE_URL,
    defaultTestEmail: ADMIN_EMAILS[0] || '',
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ── GET /admin/testing ───────────────────────────────────────
router.get('/testing', requireAdmin, (req, res) => {
  const requestedEventId = parseEventId(req.query.eventId);
  const requestedParticipantId = parseParticipantId(req.query.participantId);
  const allEvents = listTestingEvents();
  const sourceEvents = listProductionEvents();
  const locations = listLocations();
  const inviteParticipants = listActiveParticipants();
  const event = getTestingEvent(allEvents, requestedEventId);
  const participant = getTestingParticipant(requestedParticipantId);
  const testEvents = allEvents;

  if (requestedEventId && !event) {
    const rawEvent = getEventById(requestedEventId);
    if (rawEvent && !isTestEvent(rawEvent)) {
      req.session.flash = 'Start by creating or selecting a [TEST] event in the testing workspace.';
      return res.redirect(buildTestingRedirect(null, requestedParticipantId));
    }
    return res.status(404).send('<h1 style="font-family:sans-serif;padding:2rem">Event not found.</h1>');
  }

  if (requestedParticipantId && !participant) {
    return res.status(404).send('<h1 style="font-family:sans-serif;padding:2rem">Participant not found.</h1>');
  }

  res.render('admin/testing', {
    event,
    participant,
    allEvents: testEvents,
    sourceEvents,
    locations,
    testEvents,
    inviteParticipants,
    buildPublicEventPath,
    buildRsvpPath,
    formatEventDate,
    formatTime,
    getArrivalNotes,
    getEventTitle,
    getParticipantPartyMembers,
    isEventPublished,
    isTestEvent,
    baseUrl: BASE_URL,
    defaultTestEmail: ADMIN_EMAILS[0] || '',
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ── GET /admin/locations ────────────────────────────────────
router.get('/locations', requireAdmin, (req, res) => {
  res.render('admin/locations', {
    locations: listLocationsWithEventCounts(),
    flash: req.session.flash || null,
    showCreateForm: Boolean(req.session.showLocationCreateForm)
  });
  delete req.session.flash;
  delete req.session.showLocationCreateForm;
});

// ── POST /admin/locations ───────────────────────────────────
router.post('/locations', requireAdmin, locationUpload, (req, res) => {
  const locationInput = normalizeLocationInput(req.body);
  const uploadedLocationImage = getUploadedFilename(req.files, 'location_image');
  const validationError = getLocationValidationError(locationInput);

  if (validationError) {
    cleanupUploadedFiles(req.files);
    req.session.flash = validationError;
    req.session.showLocationCreateForm = true;
    return res.redirect('/admin/locations');
  }

  try {
    db.prepare(`
      INSERT INTO locations (
        name,
        address,
        location_image,
        map_embed_url,
        map_link_url
      )
      VALUES (?, ?, ?, ?, ?)
    `).run(
      locationInput.name,
      locationInput.address,
      uploadedLocationImage,
      locationInput.map_embed_url,
      locationInput.map_link_url
    );
  } catch (error) {
    cleanupUploadedFiles(req.files);
    if (isPublicSlugUniqueConstraint(error)) {
      req.session.flash = 'That saved location already exists.';
      req.session.showLocationCreateForm = true;
      return res.redirect('/admin/locations');
    }
    throw error;
  }

  req.session.flash = 'Location saved.';
  delete req.session.showLocationCreateForm;
  res.redirect('/admin/locations');
});

// ── POST /admin/locations/:id/update ────────────────────────
router.post('/locations/:id/update', requireAdmin, locationUpload, (req, res) => {
  const existing = getLocationById(req.params.id);
  if (!existing) {
    cleanupUploadedFiles(req.files);
    req.session.flash = 'Location not found.';
    return res.redirect('/admin/locations');
  }

  const locationInput = normalizeLocationInput(req.body);
  const validationError = getLocationValidationError(locationInput);
  if (validationError) {
    cleanupUploadedFiles(req.files);
    req.session.flash = validationError;
    return res.redirect('/admin/locations');
  }

  const uploadedLocationImage = getUploadedFilename(req.files, 'location_image');
  const locationImageUpdate = resolveUpdatedImage(
    existing.location_image,
    uploadedLocationImage,
    Boolean(req.body.remove_location_image)
  );

  try {
    db.prepare(`
      UPDATE locations
      SET name = ?,
          address = ?,
          location_image = ?,
          map_embed_url = ?,
          map_link_url = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      locationInput.name,
      locationInput.address,
      locationImageUpdate.nextFilename,
      locationInput.map_embed_url,
      locationInput.map_link_url,
      existing.id
    );
  } catch (error) {
    cleanupUploadedFiles(req.files);
    if (isPublicSlugUniqueConstraint(error)) {
      req.session.flash = 'That saved location already exists.';
      return res.redirect('/admin/locations');
    }
    throw error;
  }

  if (locationImageUpdate.replacedFilename) {
    removeUploadedFileIfUnused(locationImageUpdate.replacedFilename);
  }

  req.session.flash = 'Location updated.';
  res.redirect('/admin/locations');
});

// ── POST /admin/locations/:id/delete ────────────────────────
router.post('/locations/:id/delete', requireAdmin, (req, res) => {
  const existing = getLocationById(req.params.id);
  if (!existing) {
    req.session.flash = 'Location not found.';
    return res.redirect('/admin/locations');
  }

  db.prepare('DELETE FROM locations WHERE id = ?').run(existing.id);
  removeUploadedFileIfUnused(existing.location_image);

  req.session.flash = 'Location deleted.';
  res.redirect('/admin/locations');
});

// ── GET /admin/roster ────────────────────────────────────────
router.get('/roster', requireAdmin, (req, res) => {
  res.render('admin/roster', {
    inviteParticipants: listActiveParticipants().map(participant => ({
      ...participant,
      partyMembers: getParticipantPartyMembers(participant)
    }))
  });
});

// ── POST /admin/event ─────────────────────────────────────────
router.post('/event', requireAdmin, (req, res) => {
  const eventInput = normalizeEventInput(req.body);
  const returnToEvents = shouldReturnToEvents(req.body);

  const validationError = getEventValidationError(eventInput);
  if (validationError) {
    req.session.flash = validationError;
    return res.redirect(returnToEvents
      ? buildEventsCreateRedirect(eventInput.event_date)
      : '/admin/dashboard');
  }

  const locationDetails = resolveEventLocationDetails(eventInput);
  if (locationDetails.error) {
    req.session.flash = locationDetails.error;
    return res.redirect(returnToEvents
      ? buildEventsCreateRedirect(eventInput.event_date)
      : '/admin/dashboard');
  }

  try {
    const result = db.transaction(() => {
      const created = db.prepare(`
        INSERT INTO events (
          title,
          public_slug,
          event_date,
          location_id,
          location_name,
          location_address,
          location_image,
          map_image,
          map_embed_url,
          map_link_url,
          start_time,
          end_time,
          arrival_notes,
          notes,
          is_published,
          show_public_roster
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventInput.title,
        eventInput.public_slug,
        eventInput.event_date,
        locationDetails.location_id,
        locationDetails.location_name,
        locationDetails.location_address,
        locationDetails.location_image,
        null,
        locationDetails.map_embed_url,
        locationDetails.map_link_url,
        eventInput.start_time,
        eventInput.end_time,
        eventInput.arrival_notes,
        eventInput.arrival_notes,
        eventInput.is_published,
        eventInput.show_public_roster
      );

      reserveEventPublicSlug(created.lastInsertRowid, eventInput.public_slug);
      return created;
    })();

    req.session.flash = 'Event created successfully.';
    return res.redirect(returnToEvents
      ? `${buildEventsRedirect()}#scheduled-${eventInput.event_date}`
      : buildDashboardRedirect(result.lastInsertRowid));
  } catch (error) {
    if (isPublicSlugConflictError(error) || isPublicSlugUniqueConstraint(error)) {
      req.session.flash = 'That public URL slug is already in use, including any older redirected event links.';
      return res.redirect(returnToEvents
        ? buildEventsCreateRedirect(eventInput.event_date)
        : '/admin/dashboard');
    }
    throw error;
  }
});

// ── POST /admin/event/:id/update ─────────────────────────────
router.post('/event/:id/update', requireAdmin, (req, res) => {
  const existing = getEventById(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Event not found.' });
  }

  const eventInput = normalizeEventInput(req.body);
  const validationError = getEventValidationError(eventInput);
  if (validationError) {
    req.session.flash = validationError;
    return res.redirect(buildDashboardRedirect(existing.id));
  }

  const locationDetails = resolveEventLocationDetails(eventInput, existing);
  if (locationDetails.error) {
    req.session.flash = locationDetails.error;
    return res.redirect(buildDashboardRedirect(existing.id));
  }

  try {
    db.transaction(() => {
      db.prepare(`
        UPDATE events
        SET title = ?,
            public_slug = ?,
            event_date = ?,
            location_id = ?,
            location_name = ?,
            location_address = ?,
            location_image = ?,
            map_embed_url = ?,
            map_link_url = ?,
            start_time = ?,
            end_time = ?,
            arrival_notes = ?,
            notes = ?,
            is_published = ?,
            show_public_roster = ?
        WHERE id = ?
      `).run(
        eventInput.title,
        eventInput.public_slug,
        eventInput.event_date,
        locationDetails.location_id,
        locationDetails.location_name,
        locationDetails.location_address,
        locationDetails.location_image,
        locationDetails.map_embed_url,
        locationDetails.map_link_url,
        eventInput.start_time,
        eventInput.end_time,
        eventInput.arrival_notes,
        eventInput.arrival_notes,
        eventInput.is_published,
        eventInput.show_public_roster,
        existing.id
      );

      reserveEventPublicSlug(existing.id, eventInput.public_slug);
    })();
  } catch (error) {
    if (isPublicSlugConflictError(error) || isPublicSlugUniqueConstraint(error)) {
      req.session.flash = 'That public URL slug is already in use, including any older redirected event links.';
      return res.redirect(buildDashboardRedirect(existing.id));
    }
    throw error;
  }

  req.session.flash = 'Event updated.';
  res.redirect(buildDashboardRedirect(existing.id));
});

// ── POST /admin/event/:id/delete ─────────────────────────────
router.post('/event/:id/delete', requireAdmin, (req, res) => {
  const existing = getEventById(req.params.id);
  if (!existing) {
    req.session.flash = 'Event not found.';
    return res.redirect('/admin/dashboard');
  }

  db.transaction(() => {
    db.prepare('DELETE FROM responses WHERE event_id = ?').run(existing.id);
    db.prepare('DELETE FROM event_public_slugs WHERE event_id = ?').run(existing.id);
    db.prepare('DELETE FROM events WHERE id = ?').run(existing.id);
  })();

  removeUploadedFileIfUnused(existing.location_image);
  removeEventMapImageIfUnused(existing.map_image, { excludeEventId: existing.id });

  req.session.flash = 'Event deleted.';
  res.redirect('/admin/dashboard');
});

// ── GET /admin/participants ───────────────────────────────────
router.get('/participants', requireAdmin, (req, res) => {
  const participants = db.prepare(
    'SELECT * FROM participants ORDER BY active DESC, name ASC'
  ).all().map(participant => ({
    ...participant,
    partyMembers: getParticipantPartyMembers(participant),
    partyMembersInput: getParticipantPartyMembers(participant).join('\n')
  }));

  const requestedEventId = parseEventId(req.query.eventId);
  const requestedRawEvent = requestedEventId ? getEventById(requestedEventId) : null;
  if (requestedRawEvent && isTestEvent(requestedRawEvent)) {
    return res.redirect(buildTestingRedirect(requestedRawEvent.id));
  }
  const selectedEvent = getDashboardEvent(requestedEventId);

  if (requestedEventId && !selectedEvent) {
    return res.status(404).send('<h1 style="font-family:sans-serif;padding:2rem">Event not found.</h1>');
  }

  res.render('admin/participants', {
    participants,
    selectedEvent,
    allEvents: listProductionEvents(),
    buildRsvpPath,
    buildPublicEventPath,
    getEventTitle,
    isEventPublished,
    baseUrl: BASE_URL,
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ── POST /admin/participants ──────────────────────────────────
router.post('/participants', requireAdmin, (req, res) => {
  const participantInput = normalizeParticipantInput(req.body);
  const selectedEventId = parseEventId(req.body.selected_event_id);

  const validationError = getParticipantValidationError(participantInput);
  if (validationError) {
    req.session.flash = validationError;
    return res.redirect(buildParticipantsRedirect(selectedEventId));
  }

  const existing = getParticipantByEmail(participantInput.email);
  if (existing) {
    if (existing.active) {
      req.session.flash = `${existing.name} already exists with that email.`;
      return res.redirect(buildParticipantsRedirect(selectedEventId));
    }

    db.prepare(`
      UPDATE participants
      SET name = ?, party_members = ?, active = 1
      WHERE id = ?
    `).run(participantInput.name, participantInput.partyMembersJson, existing.id);

    req.session.flash = `${participantInput.name} reactivated.`;
    return res.redirect(buildParticipantsRedirect(selectedEventId));
  }

  const token = uuidv4();
  db.prepare(`
    INSERT INTO participants (name, email, rsvp_token, party_members)
    VALUES (?, ?, ?, ?)
  `).run(
    participantInput.name,
    participantInput.email,
    token,
    participantInput.partyMembersJson
  );

  req.session.flash = `${participantInput.name} added.`;
  res.redirect(buildParticipantsRedirect(selectedEventId));
});

// ── POST /admin/participants/:id/update ───────────────────────
router.post('/participants/:id/update', requireAdmin, (req, res) => {
  const participantInput = normalizeParticipantInput(req.body);
  const selectedEventId = parseEventId(req.body.selected_event_id);

  const validationError = getParticipantValidationError(participantInput);
  if (validationError) {
    req.session.flash = validationError;
    return res.redirect(buildParticipantsRedirect(selectedEventId));
  }

  const existing = db.prepare('SELECT * FROM participants WHERE id = ?').get(req.params.id);
  if (!existing) {
    req.session.flash = 'Participant not found.';
    return res.redirect(buildParticipantsRedirect(selectedEventId));
  }

  const conflict = db.prepare(`
    SELECT * FROM participants
    WHERE email = ? COLLATE NOCASE AND id != ?
  `).get(participantInput.email, req.params.id);
  if (conflict) {
    req.session.flash = `${conflict.name} already uses that email.`;
    return res.redirect(buildParticipantsRedirect(selectedEventId));
  }

  db.prepare(`
    UPDATE participants
    SET name = ?, email = ?, party_members = ?
    WHERE id = ?
  `).run(
    participantInput.name,
    participantInput.email,
    participantInput.partyMembersJson,
    req.params.id
  );

  req.session.flash = 'Participant updated.';
  res.redirect(buildParticipantsRedirect(selectedEventId));
});

// ── POST /admin/participants/:id/delete ───────────────────────
router.post('/participants/:id/delete', requireAdmin, (req, res) => {
  const selectedEventId = parseEventId(req.body.selected_event_id);
  db.prepare('UPDATE participants SET active = 0 WHERE id = ?').run(req.params.id);
  req.session.flash = 'Participant removed.';
  res.redirect(buildParticipantsRedirect(selectedEventId));
});

// ── POST /admin/testing/create-event ────────────────────────
router.post('/testing/create-event', requireAdmin, (req, res) => {
  const participantId = parseParticipantId(req.body.participant_id);
  const sourceEventId = parseEventId(req.body.source_event_id);
  const locationId = parseLocationId(req.body.location_id);
  const sourceEvent = sourceEventId ? getEventById(sourceEventId) : null;
  const location = locationId ? getLocationById(locationId) : null;

  if (!sourceEvent && !location) {
    req.session.flash = 'Choose either a real event to clone or a saved location for a standalone [TEST] event.';
    return res.redirect(buildTestingRedirect(null, participantId));
  }

  let eventInput;
  if (sourceEvent) {
    eventInput = {
      title: buildTestEventTitle(sourceEvent),
      event_date: getSafeTestEventDate(sourceEvent.event_date),
      location_id: sourceEvent.location_id,
      location_name: sourceEvent.location_name,
      location_address: sourceEvent.location_address,
      location_image: sourceEvent.location_image,
      map_image: sourceEvent.map_image,
      map_embed_url: sourceEvent.map_embed_url,
      map_link_url: sourceEvent.map_link_url,
      start_time: sourceEvent.start_time,
      end_time: sourceEvent.end_time,
      arrival_notes: sourceEvent.arrival_notes,
      notes: sourceEvent.notes,
      is_published: 1,
      show_public_roster: sourceEvent.show_public_roster
    };
  } else {
    eventInput = {
      title: buildTestEventTitle(null),
      event_date: getSafeTestEventDate(null),
      location_id: location.id,
      location_name: location.name,
      location_address: normalizeLocationAddress(location.address),
      location_image: location.location_image || null,
      map_image: null,
      map_embed_url: location.map_embed_url || null,
      map_link_url: location.map_link_url || null,
      start_time: '18:00',
      end_time: '21:00',
      arrival_notes: 'Standalone test event created from the testing workspace.',
      notes: 'Standalone test event created from the testing workspace.',
      is_published: 1,
      show_public_roster: 1
    };
  }

  const result = db.prepare(`
    INSERT INTO events (
      title,
      public_slug,
      event_date,
      location_id,
      location_name,
      location_address,
      location_image,
      map_image,
      map_embed_url,
      map_link_url,
      start_time,
      end_time,
      arrival_notes,
      notes,
      is_published,
      show_public_roster
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventInput.title,
    null,
    eventInput.event_date,
    eventInput.location_id,
    eventInput.location_name,
    eventInput.location_address,
    eventInput.location_image,
    eventInput.map_image,
    eventInput.map_embed_url,
    eventInput.map_link_url,
    eventInput.start_time,
    eventInput.end_time,
    eventInput.arrival_notes,
    eventInput.notes,
    eventInput.is_published,
    eventInput.show_public_roster
  );

  req.session.flash = sourceEvent
    ? 'Test copy created from the selected real event.'
    : 'Standalone [TEST] event created from the testing workspace.';
  res.redirect(buildTestingRedirect(result.lastInsertRowid, participantId));
});

// ── POST /admin/testing/reset-event ─────────────────────────
router.post('/testing/reset-event', requireAdmin, (req, res) => {
  const event = getEventById(parseEventId(req.body.event_id));
  const participantId = parseParticipantId(req.body.participant_id);

  if (!event) {
    req.session.flash = 'Choose a test event to reset.';
    return res.redirect(buildTestingRedirect(null, participantId));
  }

  if (!isTestEvent(event)) {
    req.session.flash = 'Only events labeled [TEST] can be reset from the testing workspace.';
    return res.redirect(buildTestingRedirect(event.id, participantId));
  }

  db.prepare('DELETE FROM responses WHERE event_id = ?').run(event.id);
  req.session.flash = 'Responses cleared for the selected test event.';
  res.redirect(buildTestingRedirect(event.id, participantId));
});

// ── GET /admin/event/:id/preview ────────────────────────────
router.get('/event/:id/preview', requireAdmin, (req, res) => {
  const event = getEventById(req.params.id);
  if (!event) {
    return res.status(404).send('<h1 style="font-family:sans-serif;padding:2rem">Event not found.</h1>');
  }

  const participant = getParticipantById(parseParticipantId(req.query.participantId));
  if (!participant) {
    return res.status(404).send('<h1 style="font-family:sans-serif;padding:2rem">Participant not found.</h1>');
  }

  return res.redirect(buildRsvpPath(participant, event));
});

// ── GET /admin/event/:id/invite-review ───────────────────────
router.get('/event/:id/invite-review', requireAdmin, (req, res) => {
  const event = getEventById(req.params.id);
  if (!event) {
    return res.status(404).send('<h1 style="font-family:sans-serif;padding:2rem">Event not found.</h1>');
  }

  const inviteParticipants = listActiveParticipants();
  const previewParticipant = getInvitePreviewParticipant(inviteParticipants, req.query.participantId);
  if (!previewParticipant) {
    req.session.flash = 'Add at least one active participant before sending invites.';
    return res.redirect(buildDashboardRedirect(event.id));
  }

  const invitePreview = buildRsvpInviteEmail(previewParticipant, event);

  res.render('admin/invite-review', {
    event,
    inviteParticipants,
    previewParticipant,
    invitePreview,
    formatEventDate,
    formatTime,
    getEventTitle,
    isEventPublished,
    buildDashboardRedirect,
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ── GET /admin/event/:id/invite-review/render ────────────────
router.get('/event/:id/invite-review/render', requireAdmin, (req, res) => {
  const event = getEventById(req.params.id);
  if (!event) {
    return res.status(404).send('<h1 style="font-family:sans-serif;padding:2rem">Event not found.</h1>');
  }

  const inviteParticipants = listActiveParticipants();
  const previewParticipant = getInvitePreviewParticipant(inviteParticipants, req.query.participantId);
  if (!previewParticipant) {
    return res.status(404).send('<h1 style="font-family:sans-serif;padding:2rem">Participant not found.</h1>');
  }

  const invitePreview = buildRsvpInviteEmail(previewParticipant, event);
  res.type('html').send(invitePreview.html);
});

// ── POST /admin/event/:id/notify ─────────────────────────────
router.post('/event/:id/notify', requireAdmin, async (req, res) => {
  const event = getEventById(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const participants = db.prepare(
    'SELECT * FROM participants WHERE active = 1'
  ).all();

  let sent = 0;
  let failed = 0;
  for (const participant of participants) {
    try {
      await sendRsvpInvite(participant, event);
      sent++;
    } catch (err) {
      console.error(`Failed to email ${participant.email}:`, err.message);
      failed++;
    }
  }

  req.session.flash = `Invites sent: ${sent} delivered${failed ? `, ${failed} failed` : ''}.`;
  res.redirect(buildDashboardRedirect(event.id));
});

// ── POST /admin/event/:id/test-invite ───────────────────────
router.post('/event/:id/test-invite', requireAdmin, async (req, res) => {
  const event = getEventById(req.params.id);
  const participantId = parseParticipantId(req.body.participant_id);
  const redirectPath = shouldReturnToTesting(req.body)
    ? buildTestingRedirect(event ? event.id : null, participantId)
    : buildDashboardRedirect(event ? event.id : null);
  if (!event) {
    return res.status(404).send('<h1 style="font-family:sans-serif;padding:2rem">Event not found.</h1>');
  }

  const participant = getParticipantById(participantId);
  if (!participant) {
    req.session.flash = 'Choose an active participant to preview.';
    return res.redirect(redirectPath);
  }

  const testEmail = normalizeEmail(req.body.test_email);
  if (!testEmail || !testEmail.includes('@')) {
    req.session.flash = 'Enter a valid test email address.';
    return res.redirect(redirectPath);
  }

  try {
    await sendRsvpInvite({
      ...participant,
      email: testEmail
    }, event);
    req.session.flash = `Test invite sent to ${testEmail} for ${participant.name}.`;
  } catch (error) {
    console.error(`Failed to send test invite to ${testEmail}:`, error.message);
    req.session.flash = `Unable to send test invite to ${testEmail}.`;
  }

  res.redirect(redirectPath);
});

// ── GET /admin/stats ──────────────────────────────────────────
router.get('/stats', requireAdmin, (req, res) => {
  const events = listEvents();

  // Attendance rate per participant (yes responses / total events with a response)
  const attendance = db.prepare(`
    SELECT
      p.id,
      p.name,
      COUNT(r.id) AS total_responses,
      SUM(CASE WHEN r.status = 'yes' THEN 1 ELSE 0 END) AS yes_count,
      AVG(r.change_count) AS avg_changes
    FROM participants p
    LEFT JOIN responses r ON r.participant_id = p.id
    WHERE p.active = 1
    GROUP BY p.id, p.name
    ORDER BY p.name ASC
  `).all();

  const totalEvents = events.length;

  const stats = attendance.map(row => ({
    id: row.id,
    name: row.name,
    totalResponses: row.total_responses || 0,
    yesCount: row.yes_count || 0,
    attendanceRate: totalEvents > 0
      ? Math.round((row.yes_count || 0) / totalEvents * 100)
      : null,
    avgChanges: row.avg_changes === null ? null : Number(row.avg_changes.toFixed(1))
  }));

  res.render('admin/stats', { stats, totalEvents, events, formatEventDate });
});

// ── GET /admin/events ─────────────────────────────────────────
router.get('/events', requireAdmin, (req, res) => {
  const events = listEventsWithResponseStats().filter(event => !isTestEvent(event));
  const history = buildMonthlyEventHistory(events, { monthsAhead: 12 });
  const activeCreateDate = (req.query.createDate || '').trim() || null;

  res.render('admin/events', {
    ...history,
    activeCreateDate,
    locations: listLocations(),
    formatEventDate,
    formatTime,
    getEventTitle,
    isEventPublished,
    buildPublicEventPath,
    flash: req.session.flash || null
  });
  delete req.session.flash;
});

// ── GET /admin/logout ─────────────────────────────────────────
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

module.exports = router;
