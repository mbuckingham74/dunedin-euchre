'use strict';

// DOM refs
const statusBtns  = document.querySelectorAll('.btn-status');
const submitBtn   = document.getElementById('submit-btn');
const commentInput = document.getElementById('comment-input');
const charCount   = document.getElementById('char-count');
const feedback    = document.getElementById('rsvp-feedback');
const rosterList  = document.getElementById('roster-list');
const rosterCounts = document.getElementById('roster-counts');

let pendingStatus = selectedStatus; // set from inline script in template

// ── Character counter ─────────────────────────────────────
if (commentInput) {
  commentInput.addEventListener('input', () => {
    charCount.textContent = commentInput.value.length;
  });
}

// ── Status button selection ───────────────────────────────
statusBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const s = btn.dataset.status;
    pendingStatus = s;
    statusBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    submitBtn.disabled = false;
  });
});

// ── Form submission ───────────────────────────────────────
submitBtn.addEventListener('click', async () => {
  if (!pendingStatus) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';
  setFeedback('', '');

  try {
    const resp = await fetch(RSVP_POST_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: pendingStatus,
        comment: commentInput ? commentInput.value : ''
      })
    });

    const data = await resp.json();

    if (!resp.ok || data.error) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit RSVP';
      setFeedback(data.error || 'Something went wrong. Please try again.', 'error');
      return;
    }

    // ── Success ───────────────────────────────────────────
    changesLeft = MAX_CHANGES - data.changesUsed;
    selectedStatus = pendingStatus;

    // Flash the submit button green
    submitBtn.classList.add('submitted');
    submitBtn.textContent = '✓ Saved!';

    const labelMap = { yes: '✓ Yes, I\'ll be there', no: '✕ Can\'t make it', maybe: '? Not sure yet' };
    setFeedback('Your response has been saved.', 'success');

    // Update current-rsvp display
    const cur = document.getElementById('current-rsvp');
    if (cur) {
      cur.querySelector('.current-status').textContent =
        pendingStatus === 'yes' ? '✓ Yes' : pendingStatus === 'no' ? '✕ No' : '? Maybe';
      cur.querySelector('.current-status').className =
        'current-status status-' + pendingStatus;
    }

    // Update changes note
    const note = document.getElementById('changes-note');
    if (note) {
      if (changesLeft <= 0) {
        note.textContent = "You've reached the maximum number of changes for this event.";
        note.classList.add('limit-reached');
        statusBtns.forEach(b => b.disabled = true);
        if (commentInput) commentInput.disabled = true;
        submitBtn.disabled = true;
      } else {
        note.innerHTML = `You can change your answer up to <strong>${changesLeft}</strong> more time${changesLeft === 1 ? '' : 's'}.`;
      }
    }

    // After 2 seconds, restore submit button (unless at limit)
    setTimeout(() => {
      if (changesLeft > 0) {
        submitBtn.classList.remove('submitted');
        submitBtn.textContent = 'Update RSVP';
        submitBtn.disabled = true; // re-disable until they pick again
      }
    }, 2000);

    // Re-render roster
    renderRoster(data.roster, MY_PID);

  } catch (err) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit RSVP';
    setFeedback('Network error. Please try again.', 'error');
  }
});

function setFeedback(msg, type) {
  feedback.textContent = msg;
  feedback.className = 'rsvp-feedback ' + (type === 'success' ? 'feedback-success' : type === 'error' ? 'feedback-error' : '');
}

// ── Roster rendering ──────────────────────────────────────
function renderRoster(roster, myPid) {
  if (!rosterList) return;

  const counts = { yes: 0, no: 0, maybe: 0, none: 0 };
  const items = roster.map(p => {
    if (p.status) counts[p.status]++;
    else counts.none++;

    const isMine = p.id === myPid;
    const statusHtml = p.status === 'yes'
      ? '<span class="status-pill pill-yes">✓ Yes</span>'
      : p.status === 'no'
        ? '<span class="status-pill pill-no">✕ No</span>'
        : p.status === 'maybe'
          ? '<span class="status-pill pill-maybe">? Maybe</span>'
          : '<span class="status-pill pill-none">—</span>';

    const commentHtml = p.comment
      ? `<span class="roster-comment">"${escHtml(p.comment)}"</span>`
      : '';

    const youBadge = isMine ? '<span class="you-badge">You</span>' : '';

    return `<li class="roster-item roster-${p.status || 'none'}${isMine ? ' roster-mine' : ''}" data-pid="${p.id}">
      <span class="roster-name">${escHtml(p.name)}${youBadge}</span>
      <span class="roster-status">${statusHtml}</span>
      ${commentHtml}
    </li>`;
  });

  rosterList.innerHTML = items.join('');

  // Update count badges
  if (rosterCounts) {
    rosterCounts.innerHTML =
      `<span class="count-badge count-yes" title="Yes">${counts.yes} Yes</span>` +
      `<span class="count-badge count-maybe" title="Maybe">${counts.maybe} Maybe</span>` +
      `<span class="count-badge count-no" title="No">${counts.no} No</span>` +
      `<span class="count-badge count-none" title="Not yet responded">${counts.none} Pending</span>`;
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
