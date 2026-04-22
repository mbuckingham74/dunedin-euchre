'use strict';

const statusBtns = Array.from(document.querySelectorAll('.btn-status'));
const submitBtn = document.getElementById('submit-btn');
const commentInput = document.getElementById('comment-input');
const charCount = document.getElementById('char-count');
const feedback = document.getElementById('rsvp-feedback');
const rosterList = document.getElementById('roster-list');
const rosterCounts = document.getElementById('roster-counts');
const attendeeSelector = document.getElementById('attendee-selector');
const attendeeCheckboxes = Array.from(document.querySelectorAll('.attendee-checkbox'));
const isHouseholdInvite = PARTY_MEMBERS.length > 1;
const isPairInvite = PARTY_MEMBERS.length === 2;

let canEdit = CAN_EDIT;
let pendingMode = getModeFromState(selectedStatus, INITIAL_ATTENDEE_NAMES);
const initialState = {
  mode: pendingMode,
  comment: commentInput ? commentInput.value : '',
  attendeeNames: normalizeNameList(INITIAL_ATTENDEE_NAMES)
};

if (commentInput) {
  commentInput.addEventListener('input', () => {
    charCount.textContent = commentInput.value.length;
    updateSubmitState();
  });
}

statusBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    pendingMode = btn.dataset.mode || '';
    setActiveStatusButton(pendingMode);

    if (pendingMode === 'yes-some' && attendeeCheckboxes.length > 0 && getSelectedAttendeeNames().length === 0) {
      attendeeCheckboxes.forEach(checkbox => {
        checkbox.checked = true;
      });
    }

    syncAttendeeSelector();
    updateSubmitState();
  });
});

attendeeCheckboxes.forEach(checkbox => {
  checkbox.addEventListener('change', updateSubmitState);
});

submitBtn.addEventListener('click', async () => {
  if (!canEdit || !pendingMode) return;

  const pendingStatus = getStatusForMode(pendingMode);
  const attendeeNames = getPendingAttendeeNames(pendingMode);
  if (hasInvalidPartialSelection()) {
    setFeedback('Choose who can attend and leave anyone else unchecked.', 'error');
    updateSubmitState();
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving...';
  setFeedback('', '');

  try {
    const resp = await fetch(RSVP_POST_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: pendingStatus,
        comment: commentInput ? commentInput.value : '',
        attendeeNames
      })
    });

    const data = await resp.json();

    if (!resp.ok || data.error) {
      if (resp.status === 409) {
        lockEditing(data.error || 'RSVP changes are now closed.');
      } else {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save RSVP';
      }

      setFeedback(data.error || 'Something went wrong. Please try again.', 'error');
      return;
    }

    initialState.mode = pendingMode;
    initialState.comment = commentInput ? commentInput.value : '';
    initialState.attendeeNames = normalizeNameList(attendeeNames);
    selectedStatus = pendingStatus;

    submitBtn.classList.add('submitted');
    submitBtn.textContent = 'Saved';
    setFeedback('Your response has been saved.', 'success');
    renderCurrentResponse(pendingStatus, initialState.attendeeNames);
    renderRoster(data.roster, MY_PID);

    setTimeout(() => {
      submitBtn.classList.remove('submitted');
      submitBtn.textContent = 'Save RSVP';
      updateSubmitState();
    }, 1500);
  } catch (error) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Save RSVP';
    setFeedback('Network error. Please try again.', 'error');
  }
});

setActiveStatusButton(pendingMode);
syncAttendeeSelector();
updateSubmitState();

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

function updateSubmitState() {
  if (!submitBtn) return;

  if (!canEdit || !pendingMode) {
    submitBtn.disabled = true;
    return;
  }

  if (hasInvalidPartialSelection()) {
    submitBtn.disabled = true;
    return;
  }

  submitBtn.disabled = !hasChanges();
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
  feedback.textContent = message;
  feedback.className = `rsvp-feedback ${type === 'success' ? 'feedback-success' : type === 'error' ? 'feedback-error' : ''}`;
}

function lockEditing(message) {
  canEdit = false;
  statusBtns.forEach(button => {
    button.disabled = true;
  });
  attendeeCheckboxes.forEach(checkbox => {
    checkbox.disabled = true;
  });
  if (commentInput) {
    commentInput.disabled = true;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'RSVP Closed';

  const note = document.getElementById('changes-note');
  if (note) {
    note.classList.add('limit-reached');
    note.textContent = message;
  }
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
