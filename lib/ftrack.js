'use strict';

// FTrack deep links (issue #517).
//
// Dual-loadable with no build step:
// - Browser: window.FTrack
// - Node: require('./lib/ftrack')
//
// One tracking number in, one FedEx FTrack package-detail URL out. The link is
// built from the tracking number alone — it never depends on an FTRACK column
// being present in a report export. Reachable on the FedEx network only, so it
// always opens in a new tab and never replaces a tool the user is working in.
//
// Extracted from address-catcher.html's inline ftrackUrl so every surface that
// renders a tracking number (Address Catcher, IBNO Coder, NVS Builder chips)
// links the same way. Print output stays plain — paper can't click.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FTrack = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FTRACK_BASE = 'http://ftrack.gss.ground.fedex.com:8085/cgi-bin/PKG621CL?IIWEBI=&IIFORM=01&IITMSD=N&IICNT1=Y&IITRAKS=';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ftrackUrl(trk) -> the FTrack deep link, or '' when there is no tracking
  // number to link. Callers render nothing on '' rather than a dead link.
  function ftrackUrl(trk) {
    const t = String(trk == null ? '' : trk).trim();
    if (!t) return '';
    return FTRACK_BASE + encodeURIComponent(t);
  }

  // ftrackLink(trk, opts) -> the ready-to-inject anchor HTML, or '' when there
  // is no tracking number. opts.className overrides the default class so a tool
  // can keep its established styling hook (e.g. address-catcher's
  // .history-ftrack); opts.text overrides the label for tight surfaces.
  function ftrackLink(trk, opts) {
    const url = ftrackUrl(trk);
    if (!url) return '';
    const o = opts || {};
    const cls = o.className == null ? 'ftrack-link' : String(o.className);
    const text = o.text == null ? 'FTrack ↗' : String(o.text);
    return '<a class="' + escapeHtml(cls) + '" href="' + escapeHtml(url) + '"' +
      ' target="_blank" rel="noopener" title="Open ' + escapeHtml(trk) + ' in FTrack">' +
      escapeHtml(text) + '</a>';
  }

  return {
    FTRACK_BASE: FTRACK_BASE,
    ftrackUrl: ftrackUrl,
    ftrackLink: ftrackLink,
  };
});
