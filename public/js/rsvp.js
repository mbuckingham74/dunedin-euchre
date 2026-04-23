'use strict';

const statusBtns = Array.from(document.querySelectorAll('.btn-status'));
const commentInput = document.getElementById('comment-input');
const charCount = document.getElementById('char-count');
const feedback = document.getElementById('rsvp-feedback');
const rosterList = document.getElementById('roster-list');
const rosterCounts = document.getElementById('roster-counts');
const attendeeSelector = document.getElementById('attendee-selector');
const attendeeCheckboxes = Array.from(document.querySelectorAll('.attendee-checkbox'));
const autoSaveNote = document.getElementById('autosave-note');
const confirmationModal = document.getElementById('rsvp-confirmation-modal');
const confirmationBox = document.getElementById('rsvp-confirmation-box');
const confirmationBadge = document.getElementById('rsvp-confirmation-badge');
const confirmationTitle = document.getElementById('rsvp-confirmation-title');
const confirmationDetail = document.getElementById('rsvp-confirmation-detail');
const confirmationCloseBtn = document.getElementById('rsvp-confirmation-close');
const isHouseholdInvite = PARTY_MEMBERS.length > 1;
const isPairInvite = PARTY_MEMBERS.length === 2;
const COMMENT_SAVE_DELAY_MS = 700;
const CONFIRMATION_MODAL_DELAY_MS = 1600;
const CONFIRMATION_THEMES = ['theme-yes', 'theme-no', 'theme-maybe'];

let canEdit = CAN_EDIT;
let pendingMode = getModeFromState(selectedStatus, INITIAL_ATTENDEE_NAMES);
const initialState = {
  mode: pendingMode,
  comment: commentInput ? commentInput.value : '',
  attendeeNames: normalizeNameList(INITIAL_ATTENDEE_NAMES)
};

let saveInFlight = false;
let queuedSaveOptions = null;
let commentSaveTimer = 0;
let confirmationHideTimer = 0;

if (commentInput) {
  commentInput.addEventListener('input', () => {
    updateCharacterCount();
    hideConfirmationModal();
    scheduleCommentSave();
  });

  commentInput.addEventListener('blur', () => {
    flushCommentSave();
  });
}

statusBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    if (!canEdit) return;

    hideConfirmationModal();
    pendingMode = btn.dataset.mode || '';
    setActiveStatusButton(pendingMode);
    syncAttendeeSelector();

    if (hasInvalidPartialSelection()) {
      setFeedback('Choose who can attend and leave anyone else unchecked.', 'pending');
      return;
    }

    requestSave({ reason: 'selection', showConfirmation: true });
  });
});

attendeeCheckboxes.forEach(checkbox => {
  checkbox.addEventListener('change', () => {
    if (!canEdit) return;

    hideConfirmationModal();
    if (hasInvalidPartialSelection()) {
      setFeedback('Choose who can attend and leave anyone else unchecked.', 'pending');
      return;
    }

    requestSave({ reason: 'selection', showConfirmation: true });
  });
});

if (confirmationModal) {
  confirmationModal.addEventListener('click', event => {
    if (event.target === confirmationModal) {
      hideConfirmationModal();
    }
  });
}

if (confirmationCloseBtn) {
  confirmationCloseBtn.addEventListener('click', () => {
    hideConfirmationModal();
  });
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    hideConfirmationModal();
  }
});

setActiveStatusButton(pendingMode);
syncAttendeeCheckboxes(initialState.attendeeNames);
syncAttendeeSelector();
updateCharacterCount();

function scheduleCommentSave() {
  clearCommentSaveTimer();

  if (!canEdit || !pendingMode || !hasChanges()) {
    return;
  }

  commentSaveTimer = window.setTimeout(() => {
    commentSaveTimer = 0;
    requestSave({ reason: 'comment', showConfirmation: false });
  }, COMMENT_SAVE_DELAY_MS);
}

function flushCommentSave() {
  if (!commentSaveTimer) return;

  clearCommentSaveTimer();
  requestSave({ reason: 'comment', showConfirmation: false });
}

function clearCommentSaveTimer() {
  if (!commentSaveTimer) return;
  window.clearTimeout(commentSaveTimer);
  commentSaveTimer = 0;
}

function mergeSaveOptions(currentOptions, nextOptions) {
  if (!currentOptions) {
    return {
      reason: nextOptions.reason,
      showConfirmation: Boolean(nextOptions.showConfirmation)
    };
  }

  return {
    reason: nextOptions.reason || currentOptions.reason,
    showConfirmation: Boolean(currentOptions.showConfirmation || nextOptions.showConfirmation)
  };
}

async function requestSave(options) {
  clearCommentSaveTimer();

  if (!canEdit || !pendingMode) {
    return;
  }

  if (hasInvalidPartialSelection()) {
    setFeedback('Choose who can attend and leave anyone else unchecked.', 'pending');
    return;
  }

  if (!hasChanges()) {
    if (!options.showConfirmation) {
      setFeedback('', '');
    }
    return;
  }

  if (saveInFlight) {
    queuedSaveOptions = mergeSaveOptions(queuedSaveOptions, options);
    return;
  }

  const saveSnapshot = buildSaveSnapshot(options);
  saveInFlight = true;
  setFeedback(
    saveSnapshot.showConfirmation ? 'Saving your RSVP...' : 'Saving note...',
    'pending'
  );

  try {
    const resp = await fetch(RSVP_POST_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: saveSnapshot.status,
        comment: saveSnapshot.comment,
        attendeeNames: saveSnapshot.attendeeNames
      })
    });

    const data = await resp.json();

    if (!resp.ok || data.error) {
      if (resp.status === 409) {
        lockEditing(data.error || 'RSVP changes are now closed.');
      } else {
        setFeedback(data.error || 'Something went wrong. Please try again.', 'error');
      }
      return;
    }

    const savedAttendeeNames = normalizeNameList(data.attendeeNames || saveSnapshot.attendeeNames);
    initialState.mode = saveSnapshot.mode;
    initialState.comment = saveSnapshot.comment;
    initialState.attendeeNames = savedAttendeeNames;
    selectedStatus = saveSnapshot.status;

    syncAttendeeCheckboxes(saveSnapshot.status === 'yes' ? savedAttendeeNames : []);
    renderCurrentResponse(saveSnapshot.status, savedAttendeeNames);
    renderRoster(data.roster, MY_PID);

    const shouldShowConfirmation =
      saveSnapshot.showConfirmation &&
      !queuedSaveOptions &&
      snapshotMatchesCurrentState(saveSnapshot);

    if (shouldShowConfirmation) {
      showConfirmationModal(saveSnapshot.status, savedAttendeeNames);
    }

    if (!queuedSaveOptions && snapshotMatchesCurrentState(saveSnapshot)) {
      setFeedback(
        saveSnapshot.showConfirmation ? 'Saved just now.' : 'Note saved.',
        'success'
      );
    }
  } catch (error) {
    setFeedback('Network error. Please try again.', 'error');
  } finally {
    saveInFlight = false;
    processQueuedSave();
  }
}

function processQueuedSave() {
  if (!canEdit || !queuedSaveOptions) {
    return;
  }

  const nextOptions = queuedSaveOptions;
  queuedSaveOptions = null;
  requestSave(nextOptions);
}

function buildSaveSnapshot(options) {
  return {
    reason: options.reason,
    showConfirmation: Boolean(options.showConfirmation),
    mode: pendingMode,
    status: getStatusForMode(pendingMode),
    comment: commentInput ? commentInput.value : '',
    attendeeNames: normalizeNameList(getPendingAttendeeNames(pendingMode))
  };
}

function snapshotMatchesCurrentState(snapshot) {
  return snapshot.mode === pendingMode &&
    snapshot.comment === (commentInput ? commentInput.value : '') &&
    arraysEqual(snapshot.attendeeNames, normalizeNameList(getPendingAttendeeNames(pendingMode)));
}

function updateCharacterCount() {
  if (charCount && commentInput) {
    charCount.textContent = commentInput.value.length;
  }
}

function showConfirmationModal(status, attendeeNames) {
  if (!confirmationModal || !confirmationBox || !confirmationBadge || !confirmationTitle || !confirmationDetail) {
    return;
  }

  const content = getConfirmationContent(status, attendeeNames);
  confirmationBox.classList.remove(...CONFIRMATION_THEMES);
  confirmationBox.classList.add(`theme-${content.theme}`);
  confirmationBadge.textContent = content.badge;
  confirmationTitle.textContent = content.title;
  confirmationDetail.textContent = content.detail;
  confirmationModal.style.display = 'flex';
  confirmationModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');

  if (confirmationHideTimer) {
    window.clearTimeout(confirmationHideTimer);
  }

  confirmationHideTimer = window.setTimeout(() => {
    hideConfirmationModal();
  }, CONFIRMATION_MODAL_DELAY_MS);
}

function hideConfirmationModal() {
  if (!confirmationModal) return;

  confirmationModal.style.display = 'none';
  confirmationModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');

  if (confirmationHideTimer) {
    window.clearTimeout(confirmationHideTimer);
    confirmationHideTimer = 0;
  }
}

function getConfirmationContent(status, attendeeNames) {
  const normalizedAttendeeNames = normalizeNameList(attendeeNames);
  const declinedNames = PARTY_MEMBERS.filter(name => !normalizedAttendeeNames.includes(name));

  if (status === 'yes') {
    if (!isHouseholdInvite) {
      return {
        theme: 'yes',
        badge: '✓',
        title: 'You\'re in',
        detail: 'Your RSVP has been saved.'
      };
    }

    return {
      theme: 'yes',
      badge: normalizedAttendeeNames.length === PARTY_MEMBERS.length ? '✓' : '◐',
      title: `${formatNameList(normalizedAttendeeNames)} ${normalizedAttendeeNames.length === 1 ? 'is' : 'are'} in`,
      detail: declinedNames.length > 0
        ? `${formatNameList(declinedNames)} ${declinedNames.length === 1 ? 'is' : 'are'} marked as not attending.`
        : 'Your RSVP has been saved.'
    };
  }

  if (status === 'no') {
    return {
      theme: 'no',
      badge: '✕',
      title: isHouseholdInvite ? 'Marked as not attending' : 'Can\'t make it',
      detail: isHouseholdInvite
        ? `${formatNameList(PARTY_MEMBERS)} ${PARTY_MEMBERS.length === 1 ? 'won\'t' : 'won\'t'} be attending.`
        : 'Your RSVP has been saved.'
    };
  }

  return {
    theme: 'maybe',
    badge: '?',
    title: isHouseholdInvite ? 'Marked as maybe' : 'Not sure yet',
    detail: isHouseholdInvite
      ? `${formatNameList(PARTY_MEMBERS)} ${PARTY_MEMBERS.length === 1 ? 'is' : 'are'} still deciding.`
      : 'Your RSVP has been saved.'
  };
}

function getStatusForMode(mode) {
  if (
    mode === 'yes' ||
    mode === 'yes-all' ||
    mode === 'yes-first' ||
    mode === 'yes-second' ||
    mode === 'yes-some'
  ) {
    return 'yes';
  }
  return mode || '';
}

function getModeFromState(status, attendeeNames) {
  const normalizedAttendeeNames = normalizeNameList(attendeeNames);
  if (status !== 'yes') return status || '';
  if (!isHouseholdInvite) return 'yes';
  if (isPairInvite) {
    if (normalizedAttendeeNames.length === 1) {
      if (normalizedAttendeeNames[0] === PARTY_MEMBERS[0]) return 'yes-first';
      if (normalizedAttendeeNames[0] === PARTY_MEMBERS[1]) return 'yes-second';
    }
    return 'yes-all';
  }
  if (normalizedAttendeeNames.length > 0 && normalizedAttendeeNames.length < PARTY_MEMBERS.length) {
    return 'yes-some';
  }
  return 'yes-all';
}

function setActiveStatusButton(mode) {
  statusBtns.forEach(button => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });
}

function getSelectedAttendeeNames() {
  return attendeeCheckboxes
    .filter(checkbox => checkbox.checked)
    .map(checkbox => checkbox.value);
}

function syncAttendeeCheckboxes(attendeeNames) {
  if (attendeeCheckboxes.length === 0) return;

  const selectedNames = new Set(normalizeNameList(attendeeNames));
  attendeeCheckboxes.forEach(checkbox => {
    checkbox.checked = selectedNames.has(checkbox.value);
  });
}

function getPendingAttendeeNames(mode) {
  if (getStatusForMode(mode) !== 'yes') return [];
  if (!isHouseholdInvite) return PARTY_MEMBERS.slice();
  if (mode === 'yes-first') return [PARTY_MEMBERS[0]];
  if (mode === 'yes-second') return [PARTY_MEMBERS[1]];
  if (mode === 'yes-all') return PARTY_MEMBERS.slice();
  return getSelectedAttendeeNames();
}

function hasInvalidPartialSelection() {
  if (pendingMode !== 'yes-some' || !isHouseholdInvite || isPairInvite) return false;

  const selectedCount = getSelectedAttendeeNames().length;
  return selectedCount === 0 || selectedCount === PARTY_MEMBERS.length;
}

function syncAttendeeSelector() {
  if (!attendeeSelector) return;

  const showSelector = pendingMode === 'yes-some' && isHouseholdInvite && !isPairInvite;
  attendeeSelector.classList.toggle('party-selector-hidden', !showSelector);

  attendeeCheckboxes.forEach(checkbox => {
    checkbox.disabled = !canEdit || !showSelector;
  });
}

function hasChanges() {
  const currentComment = commentInput ? commentInput.value : '';
  const currentAttendeeNames = normalizeNameList(getPendingAttendeeNames(pendingMode));

  return pendingMode !== initialState.mode ||
    currentComment !== initialState.comment ||
    !arraysEqual(currentAttendeeNames, initialState.attendeeNames);
}

function normalizeNameList(names) {
  return (Array.isArray(names) ? names : [])
    .map(name => String(name || '').trim())
    .filter(Boolean)
    .slice()
    .sort((left, right) => left.localeCompare(right));
}

function arraysEqual(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function renderCurrentResponse(status, attendeeNames) {
  const statusEl = document.getElementById('current-rsvp-status');
  const detailEl = document.getElementById('current-rsvp-detail');
  if (!statusEl || !detailEl) return;

  if (status === 'yes') {
    const attending = attendeeNames.length > 0 ? attendeeNames : PARTY_MEMBERS;
    const declined = PARTY_MEMBERS.filter(name => !attending.includes(name));
    statusEl.textContent = '✓ Yes';
    statusEl.className = 'current-status status-yes';
    detailEl.textContent = declined.length > 0
      ? `Coming: ${formatNameList(attending)}. Not attending: ${formatNameList(declined)}.`
      : `Coming: ${formatNameList(attending)}.`;
    return;
  }

  if (status === 'maybe') {
    statusEl.textContent = '? Maybe';
    statusEl.className = 'current-status status-maybe';
    detailEl.textContent = `Still deciding for ${formatNameList(PARTY_MEMBERS)}.`;
    return;
  }

  if (status === 'no') {
    statusEl.textContent = '✕ No';
    statusEl.className = 'current-status status-no';
    detailEl.textContent = `Not attending: ${formatNameList(PARTY_MEMBERS)}.`;
    return;
  }

  statusEl.textContent = 'No response yet';
  statusEl.className = 'current-status status-none';
  detailEl.textContent = 'You have not replied for this event yet.';
}

function setFeedback(message, type) {
  if (!feedback) return;

  feedback.textContent = message;
  feedback.className = `rsvp-feedback ${
    type === 'success'
      ? 'feedback-success'
      : type === 'error'
        ? 'feedback-error'
        : type === 'pending'
          ? 'feedback-pending'
          : ''
  }`;
}

function lockEditing(message) {
  hideConfirmationModal();
  canEdit = false;
  clearCommentSaveTimer();
  queuedSaveOptions = null;

  statusBtns.forEach(button => {
    button.disabled = true;
  });
  attendeeCheckboxes.forEach(checkbox => {
    checkbox.disabled = true;
  });
  if (commentInput) {
    commentInput.disabled = true;
  }

  if (autoSaveNote) {
    autoSaveNote.textContent = 'This RSVP is now locked.';
  }

  const note = document.getElementById('changes-note');
  if (note) {
    note.classList.add('limit-reached');
    note.textContent = message;
  }

  setFeedback(message, 'error');
}

function renderRoster(roster, myPid) {
  if (!rosterList) return;

  const counts = { yes: 0, no: 0, maybe: 0, none: 0 };
  const items = roster.map(entry => {
    counts.yes += (entry.attendeeNames || []).length;
    counts.no += (entry.declinedNames || []).length;
    counts.maybe += (entry.maybeNames || []).length;
    counts.none += (entry.pendingNames || []).length;

    const isMine = entry.id === myPid;
    const statusHtml = entry.status === 'yes'
      ? '<span class="status-pill pill-yes">✓ Yes</span>'
      : entry.status === 'no'
        ? '<span class="status-pill pill-no">✕ No</span>'
        : entry.status === 'maybe'
          ? '<span class="status-pill pill-maybe">? Maybe</span>'
          : '<span class="status-pill pill-none">—</span>';

    const detailHtml = getRosterDetail(entry)
      ? `<span class="roster-detail">${escHtml(getRosterDetail(entry))}</span>`
      : '';
    const commentHtml = entry.comment
      ? `<span class="roster-comment">"${escHtml(entry.comment)}"</span>`
      : '';
    const youBadge = isMine ? '<span class="you-badge">You</span>' : '';

    return `<li class="roster-item roster-${entry.status || 'none'}${isMine ? ' roster-mine' : ''}" data-pid="${entry.id}">
      <span class="roster-name">${escHtml(entry.name)}${youBadge}</span>
      <span class="roster-status">${statusHtml}</span>
      ${detailHtml}
      ${commentHtml}
    </li>`;
  });

  rosterList.innerHTML = items.join('');

  if (rosterCounts) {
    rosterCounts.innerHTML =
      `<span class="count-badge count-yes" title="Yes">${counts.yes} Yes</span>` +
      `<span class="count-badge count-maybe" title="Maybe">${counts.maybe} Maybe</span>` +
      `<span class="count-badge count-no" title="No">${counts.no} No</span>` +
      `<span class="count-badge count-none" title="Not yet responded">${counts.none} Pending</span>`;
  }
}

function getRosterDetail(entry) {
  const partyMembers = Array.isArray(entry.partyMembers) ? entry.partyMembers : [];
  const attendeeNames = Array.isArray(entry.attendeeNames) ? entry.attendeeNames : [];
  const declinedNames = Array.isArray(entry.declinedNames) ? entry.declinedNames : [];

  if (entry.status === 'yes') {
    let detail = `Coming: ${formatNameList(attendeeNames)}.`;
    if (declinedNames.length > 0) {
      detail += ` Not attending: ${formatNameList(declinedNames)}.`;
    }
    return detail;
  }

  if (entry.status === 'maybe') {
    return `Still deciding for ${formatNameList(partyMembers)}.`;
  }

  if (entry.status === 'no') {
    return `Not attending: ${formatNameList(partyMembers)}.`;
  }

  if (partyMembers.length > 1) {
    return `Waiting on ${formatNameList(partyMembers)}.`;
  }

  return '';
}

function formatNameList(names) {
  const normalized = (Array.isArray(names) ? names : []).filter(Boolean);
  if (normalized.length === 0) return '';
  if (normalized.length === 1) return normalized[0];
  if (normalized.length === 2) return `${normalized[0]} and ${normalized[1]}`;
  return `${normalized.slice(0, -1).join(', ')}, and ${normalized[normalized.length - 1]}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
