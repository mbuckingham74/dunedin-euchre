'use strict';

function normalizeAddress(value) {
  const normalized = (value || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');

  return normalized || '';
}

function buildMapQuery(address) {
  return normalizeAddress(address).replace(/\n+/g, ', ');
}

function buildMapEmbedUrl(address) {
  const query = buildMapQuery(address);
  return query
    ? `https://www.google.com/maps?output=embed&q=${encodeURIComponent(query)}&z=14`
    : '';
}

function buildMapLinkUrl(address) {
  const query = buildMapQuery(address);
  return query
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
    : '';
}

function updateSavedLocationPreview(select) {
  const preview = select.form.querySelector('[data-location-preview]');
  if (!preview) return;

  const option = select.options[select.selectedIndex];
  const hasSelection = Boolean(select.value && option);
  const nameEl = preview.querySelector('[data-location-preview-name]');
  const addressEl = preview.querySelector('[data-location-preview-address]');
  const linkEl = preview.querySelector('[data-location-preview-link]');
  const photoWrap = preview.querySelector('[data-location-preview-photo-wrap]');
  const photoEl = preview.querySelector('[data-location-preview-photo]');
  const mapEl = preview.querySelector('[data-location-preview-map]');

  preview.hidden = !hasSelection;
  if (!hasSelection) return;

  const { name, address, photo, mapEmbed, mapLink } = option.dataset;
  nameEl.textContent = name || '';
  addressEl.textContent = address || '';

  if (mapLink) {
    linkEl.href = mapLink;
    linkEl.hidden = false;
  } else {
    linkEl.hidden = true;
  }

  if (photo) {
    photoEl.src = photo;
    photoWrap.hidden = false;
  } else {
    photoEl.removeAttribute('src');
    photoWrap.hidden = true;
  }

  if (mapEmbed) {
    mapEl.src = mapEmbed;
    mapEl.hidden = false;
  } else {
    mapEl.removeAttribute('src');
    mapEl.hidden = true;
  }
}

function updateAddressPreview(input) {
  const preview = input.form.querySelector('[data-address-preview]');
  if (!preview) return;

  const address = normalizeAddress(input.value);
  const textEl = preview.querySelector('[data-address-preview-text]');
  const linkEl = preview.querySelector('[data-address-preview-link]');
  const mapEl = preview.querySelector('[data-address-preview-map]');

  if (!address) {
    preview.hidden = true;
    mapEl.removeAttribute('src');
    linkEl.hidden = true;
    return;
  }

  const mapLink = buildMapLinkUrl(address);
  const mapEmbed = buildMapEmbedUrl(address);

  textEl.textContent = address;
  linkEl.href = mapLink;
  linkEl.hidden = !mapLink;
  mapEl.src = mapEmbed;
  preview.hidden = false;
}

function revealLocationCreateForm(button) {
  const formCardId = button.getAttribute('aria-controls');
  if (!formCardId) return;

  const formCard = document.getElementById(formCardId);
  if (!formCard) return;

  formCard.hidden = false;
  button.setAttribute('aria-expanded', 'true');

  formCard.scrollIntoView({
    behavior: 'smooth',
    block: 'start'
  });

  const nameInput = formCard.querySelector('[data-location-create-name]');
  if (nameInput) {
    nameInput.focus();
  }
}

// Copy-to-clipboard for RSVP links
document.querySelectorAll('.btn-copy').forEach(btn => {
  btn.addEventListener('click', async () => {
    const text = btn.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 2000);
    }
  });
});

document.querySelectorAll('[data-location-select]').forEach(select => {
  updateSavedLocationPreview(select);
  select.addEventListener('change', () => updateSavedLocationPreview(select));
});

document.querySelectorAll('[data-location-address-input]').forEach(input => {
  updateAddressPreview(input);
  input.addEventListener('input', () => updateAddressPreview(input));
});

document.querySelectorAll('[data-location-form-toggle]').forEach(button => {
  const formCardId = button.getAttribute('aria-controls');
  const formCard = formCardId ? document.getElementById(formCardId) : null;

  if (!formCard) return;

  button.setAttribute('aria-expanded', String(!formCard.hidden));
  button.addEventListener('click', () => revealLocationCreateForm(button));
});
