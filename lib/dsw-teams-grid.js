'use strict';

// DSW "Copy for Teams" grid builder (slice #275, PRD #273).
//
// WHY an HTML table and not Markdown: the Teams compose box does NOT render
// Markdown, so a "| Tracking | … |" table pastes as literal pipes — unreadable.
// A real HTML table on the clipboard (text/html) pastes as a true bordered grid
// in Teams chat, which is the whole point. We also return a plain-text version
// for clipboards/apps that don't take HTML.
//
// The grid is the TEAM's action surface: five columns only — Tracking # ·
// Today's Vision Label · On truck today? · Recipient · Address — with the
// tracking number first as plain selectable digits so a teammate can
// double-click it, copy it, and reply in chat ("…is a bad address, will pull").
// The rich audit columns stay on the DSW screen (lib/in-area-12 + dsw.html),
// not here.
//
// Dual-loadable, no build step (mirrors lib/in-area-12.js, lib/csv.js):
// - Browser: window.DswTeamsGrid
// - Node: require('./lib/dsw-teams-grid')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DswTeamsGrid = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const PURPLE = '#4D148C';  // FedEx purple — matches the dashboard header.
  const LOADED_BG = '#fde2e1'; // red shading for already-loaded (urgent) rows.

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Compose "STREET, CITY ST ZIP" from the row's separated label fields,
  // skipping any blank part so we never emit stray commas/spaces.
  function composeAddress(row) {
    const cityStateZip = [row.city, [row.state, row.zip].filter(Boolean).join(' ').trim()]
      .filter(Boolean).join(' ').trim();
    return [row.street, cityStateZip].filter(Boolean).join(', ');
  }

  function onTruckLabel(row) { return row.onTruck ? '⚠️ Loaded' : 'Not yet'; }

  const HEADERS = ["Tracking #", "Today's Vision Label", "On truck today?", "Recipient", "Address"];

  function titleLine(rows, date) {
    return 'Recurring In-Area 12s — ' + date + ' (' + rows.length + ')';
  }

  function buildHtml(rows, date) {
    const cell = 'border:1px solid #ccc;padding:6px 10px';
    const th = function (label, align) {
      return '<th style="' + cell + ';text-align:' + (align || 'left') + '">' + esc(label) + '</th>';
    };
    const head =
      '<tr style="background:' + PURPLE + ';color:#fff">' +
        th('Tracking #') + th("Today's Vision Label") + th('On truck today?', 'center') +
        th('Recipient') + th('Address') +
      '</tr>';
    const body = rows.map(function (r) {
      const rowStyle = r.onTruck ? ' style="background:' + LOADED_BG + '"' : '';
      const td = function (content, align) {
        return '<td style="' + cell + (align ? ';text-align:' + align : '') + '">' + content + '</td>';
      };
      return '<tr' + rowStyle + '>' +
        // Tracking #: plain digits, no inner markup, so double-click selects it whole.
        td(esc(r.tracking)) +
        td(esc(r.todaysVisionLabel)) +
        td(esc(onTruckLabel(r)), 'center') +
        td(esc(r.recipient)) +
        td(esc(composeAddress(r))) +
      '</tr>';
    }).join('');
    return '<p style="font-family:Segoe UI,Arial,sans-serif;font-weight:600">' + esc(titleLine(rows, date)) + '</p>' +
      '<table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif;font-size:13px">' +
      '<thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }

  function buildText(rows, date) {
    const lines = [titleLine(rows, date)];
    for (const r of rows) {
      lines.push([r.tracking, r.todaysVisionLabel, onTruckLabel(r), r.recipient, composeAddress(r)]
        .map(function (v) { return String(v == null ? '' : v); }).join('  |  '));
    }
    return lines.join('\n');
  }

  // buildTeamsGrid(rows, date) -> { html, text }. `rows` are the flagged records
  // from lib/in-area-12 (need tracking, todaysVisionLabel, onTruck, recipient,
  // street/city/state/zip). `date` is a preformatted day string (e.g. M/D/YYYY).
  function buildTeamsGrid(rows, date) {
    const list = Array.isArray(rows) ? rows : [];
    return { html: buildHtml(list, date), text: buildText(list, date) };
  }

  return { buildTeamsGrid: buildTeamsGrid, composeAddress: composeAddress };
});
