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
//
// TWO PAGES, ONE PROGRAM (Tyler, 2026-10-26 email "FTRACK links"). FTrack moved
// off ftrack.gss.ground.fedex.com:8085 to ftrack.prod.cloud.fedex.com, and the
// same PKG621CL program serves both pages a tracking number can open:
//   history ......... IIFORM=01, the full scan history. What every FTrack chip
//                     opens, on every device. The admins work from this page.
//   delivery ........ IIFORM=04, the delivery page, which shows the address.
//                     One click shorter than history when all you need is
//                     where a no-address package is going. Nothing renders it
//                     unless a tool opts in (the IBNO Coder's Address chip).
// The two query strings differ in more than the form number (IITMSD, and
// IITRAKS vs IITRAK), so do not "tidy" one to match the other. The delivery
// query is verbatim from the link in that email. The history query is the old
// host's, carried over unchanged: the email gave only the bare program URL,
// and FTrack resolves only on the FedEx network, so it could not be checked
// from here.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FTrack = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FTRACK_HOST = 'https://ftrack.prod.cloud.fedex.com/cgi-bin/PKG621CL';
  const FTRACK_BASE = FTRACK_HOST + '?IIWEBI=&IIFORM=01&IITMSD=N&IICNT1=Y&IITRAKS=';
  const FTRACK_DELIVERY_BASE = FTRACK_HOST + '?IIWEBI=&IIFORM=04&IITMSD=Y&IICNT1=Y&IITRAK=';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ftrackUrl(trk) -> the FTrack deep link, or '' when there is no tracking
  // number to link. Callers render nothing on '' rather than a dead link.
  function ftrackUrl(trk) {
    return urlFor(FTRACK_BASE, trk);
  }

  // ftrackDeliveryUrl(trk) -> the FTrack delivery page (the address), or ''
  // on the same terms as ftrackUrl.
  function ftrackDeliveryUrl(trk) {
    return urlFor(FTRACK_DELIVERY_BASE, trk);
  }

  function urlFor(base, trk) {
    const t = String(trk == null ? '' : trk).trim();
    if (!t) return '';
    return base + encodeURIComponent(t);
  }

  // ftrackLink(trk, opts) -> the ready-to-inject anchor HTML, or '' when there
  // is no tracking number. opts.className overrides the default class so a tool
  // can keep its established styling hook (e.g. address-catcher's
  // .history-ftrack); opts.text overrides the label for tight surfaces.
  function ftrackLink(trk, opts) {
    return anchor(ftrackUrl(trk), trk, opts, 'ftrack-link', 'FTrack ↗', 'Open ' + trk + ' in FTrack');
  }

  // ftrackDeliveryLink(trk, opts) -> the delivery-page anchor, same contract as
  // ftrackLink. The default class keeps `ftrack-link` so every row-click opt-out
  // that already names it lets this chip's click through too, and adds
  // `ftrack-delivery` so a test or a style can tell the two apart.
  function ftrackDeliveryLink(trk, opts) {
    return anchor(ftrackDeliveryUrl(trk), trk, opts, 'ftrack-link ftrack-delivery', 'Address ↗',
      'Open the FTrack delivery page for ' + trk + ' (shows the address)');
  }

  function anchor(url, trk, opts, defaultClass, defaultText, title) {
    if (!url) return '';
    const o = opts || {};
    const cls = o.className == null ? defaultClass : String(o.className);
    const text = o.text == null ? defaultText : String(o.text);
    return '<a class="' + escapeHtml(cls) + '" href="' + escapeHtml(url) + '"' +
      ' target="_blank" rel="noopener" title="' + escapeHtml(title) + '">' +
      escapeHtml(text) + '</a>';
  }

  return {
    FTRACK_HOST: FTRACK_HOST,
    FTRACK_BASE: FTRACK_BASE,
    FTRACK_DELIVERY_BASE: FTRACK_DELIVERY_BASE,
    ftrackUrl: ftrackUrl,
    ftrackLink: ftrackLink,
    ftrackDeliveryUrl: ftrackDeliveryUrl,
    ftrackDeliveryLink: ftrackDeliveryLink,
  };
});
