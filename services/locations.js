'use strict';

const APPROXIMATE_MAP_ZOOM = 14;

function normalizeLocationText(value) {
  const trimmed = (value || '').trim();
  return trimmed ? trimmed : null;
}

function normalizeLocationAddress(value) {
  const normalized = (value || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');

  return normalized || null;
}

function buildLocationMapQuery(address) {
  return normalizeLocationAddress(address)
    ? normalizeLocationAddress(address).replace(/\n+/g, ', ')
    : null;
}

function buildLocationMapEmbedUrl(address) {
  const query = buildLocationMapQuery(address);
  if (!query) return null;

  return `https://www.google.com/maps?output=embed&q=${encodeURIComponent(query)}&z=${APPROXIMATE_MAP_ZOOM}`;
}

function buildLocationMapLinkUrl(address) {
  const query = buildLocationMapQuery(address);
  if (!query) return null;

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function applyManagedLocation(row) {
  if (!row) return row;

  const managedName = normalizeLocationText(row.managed_location_name);
  const managedAddress = normalizeLocationAddress(row.managed_location_address);
  const legacyAddress = normalizeLocationAddress(row.location_address);
  const resolvedAddress = managedAddress || legacyAddress;

  return {
    ...row,
    location_name: managedName || row.location_name,
    location_address: resolvedAddress,
    location_image: row.managed_location_image || row.location_image || null,
    map_embed_url: row.managed_map_embed_url || row.map_embed_url || null,
    map_link_url: row.managed_map_link_url || row.map_link_url || buildLocationMapLinkUrl(resolvedAddress)
  };
}

function applyManagedLocations(rows) {
  return Array.isArray(rows) ? rows.map(applyManagedLocation) : [];
}

module.exports = {
  applyManagedLocation,
  applyManagedLocations,
  buildLocationMapEmbedUrl,
  buildLocationMapLinkUrl,
  normalizeLocationAddress,
  normalizeLocationText
};
