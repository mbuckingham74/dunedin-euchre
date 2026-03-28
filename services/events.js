'use strict';

const { formatEventDate } = require('./email');

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

function isEventPublished(event) {
  return Boolean(event && Number(event.is_published));
}

module.exports = {
  getArrivalNotes,
  getEventTitle,
  isEventPublished
};
