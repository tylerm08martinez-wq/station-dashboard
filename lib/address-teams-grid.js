'use strict';

// Address Catcher "Copy for Teams" grid builder (issue #450, slice 4 of
// #446). Mirrors lib/dsw-teams-grid.js's HTML-table-on-the-clipboard +
// plain-text fallback pattern verbatim: Teams does NOT render Markdown, so a
// raw "| a | b |" table pastes as literal pipes -- unreadable. A real HTML
// table on the clipboard (text/html) pastes as a true bordered grid in Teams
// chat; a plain-text version rides along for clipboards/apps that don't take
// HTML. See lib/dsw-teams-grid.js for the prior-art rationale in full; this
// module does not repeat it, only what differs.
//
// Columns (per #450's AC): Tracking # -> Scanned Area -> Mainly Assigned
// Area -> On truck? -> Recipient -> Address, tracking number FIRST as plain
// selectable digits (no inner markup) so a teammate can double-click it,
// copy it, and reply in Teams chat with it.
//
// FILTERING IS THIS MODULE'S JOB, not the caller's: buildTeamsGrid() takes
// the FULL match list -- lib/address-match.js's matchInbound() output, or
// address-catcher.html's matchCache.matches straight off the page -- and
// filters to misroute === true internally (see misrouteOnly() below). "One
// row per misrouted package only, not the full worklist, not
// correctly-routed packages in the same group" is therefore a property this
// module's OWN unit tests can assert directly, rather than something every
// caller has to re-derive and could get wrong. The filter operates per
// PACKAGE (one match object per package), so a group with some misrouted and
// some correctly-routed members contributes only its misrouted members.
//
// Loaded/urgent marking: a misrouted package with a van-scan time
// (`onTruck`, already computed by matchInbound from VAN_SCAN_TIME1 -- see
// that module) gets the same "⚠️ Loaded" label + red row shading
// lib/dsw-teams-grid.js uses for its own on-truck rows -- one visual
// language for "already loaded, go pull it off the truck" across both
// tools.
//
// Input row shape: one of lib/address-match.js's matchInbound() match
// objects -- { trackingId, ibWorkArea, workArea, onTruck, recipient,
// address, misroute, ... }. `recipient` and `address` are matchInbound's
// #450 passthrough additions (rec.firmName / rec.address from the inbound
// record) -- see that module's own comment for why they're now on the match
// shape; this module does no computation of its own on them, same
// passthrough discipline the rest of the match pipeline already follows.
//
// Dual-loadable, no build step (mirrors lib/dsw-teams-grid.js):
// - Browser: window.AddressTeamsGrid
// - Node: require('./lib/address-teams-grid')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AddressTeamsGrid = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const PURPLE = '#4D148C';    // FedEx purple — matches lib/dsw-teams-grid.js / the dashboard header.
  const LOADED_BG = '#fde2e1'; // red shading for already-loaded (urgent) rows — matches lib/dsw-teams-grid.js.

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function onTruckLabel(row) { return row.onTruck ? '⚠️ Loaded' : 'Not yet'; }

  const HEADERS = ['Tracking #', 'Scanned Area', 'Mainly Assigned Area', 'On truck?', 'Recipient', 'Address'];

  function titleLine(rows, date) {
    return 'Misroute Pull List — ' + date + ' (' + rows.length + ')';
  }

  // misrouteOnly(matches) -> match[]. The ONE filtering point in this
  // module — buildHtml/buildText both read from its output, so the HTML
  // grid and the plain-text fallback can never drift on which packages they
  // include. Preserves the input's original order.
  function misrouteOnly(matches) {
    return (Array.isArray(matches) ? matches : []).filter(function (m) { return !!(m && m.misroute); });
  }

  function buildHtml(rows, date) {
    const cell = 'border:1px solid #ccc;padding:6px 10px';
    const th = function (label, align) {
      return '<th style="' + cell + ';text-align:' + (align || 'left') + '">' + esc(label) + '</th>';
    };
    const head =
      '<tr style="background:' + PURPLE + ';color:#fff">' +
        th('Tracking #') + th('Scanned Area') + th('Mainly Assigned Area') + th('On truck?', 'center') +
        th('Recipient') + th('Address') +
      '</tr>';
    const body = rows.map(function (r) {
      const rowStyle = r.onTruck ? ' style="background:' + LOADED_BG + '"' : '';
      const td = function (content, align) {
        return '<td style="' + cell + (align ? ';text-align:' + align : '') + '">' + content + '</td>';
      };
      return '<tr' + rowStyle + '>' +
        // Tracking #: plain digits, no inner markup, so double-click selects it whole.
        td(esc(r.trackingId)) +
        td(esc(r.ibWorkArea)) +
        td(esc(r.workArea)) +
        td(esc(onTruckLabel(r)), 'center') +
        td(esc(r.recipient)) +
        td(esc(r.address)) +
      '</tr>';
    }).join('');
    return '<p style="font-family:Segoe UI,Arial,sans-serif;font-weight:600">' + esc(titleLine(rows, date)) + '</p>' +
      '<table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif;font-size:13px">' +
      '<thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }

  function buildText(rows, date) {
    const lines = [titleLine(rows, date)];
    for (const r of rows) {
      lines.push([r.trackingId, r.ibWorkArea, r.workArea, onTruckLabel(r), r.recipient, r.address]
        .map(function (v) { return String(v == null ? '' : v); }).join('  |  '));
    }
    return lines.join('\n');
  }

  // buildTeamsGrid(matches, date) -> { html, text }. `matches` is the FULL
  // match list — matchInbound()'s output, or address-catcher.html's
  // matchCache.matches — NOT pre-filtered by the caller; this function
  // filters to misroute === true internally (misrouteOnly() above). `date`
  // is a preformatted day string (e.g. M/D/YYYY).
  function buildTeamsGrid(matches, date) {
    const rows = misrouteOnly(matches);
    return { html: buildHtml(rows, date), text: buildText(rows, date) };
  }

  return { buildTeamsGrid: buildTeamsGrid, misrouteOnly: misrouteOnly };
});
