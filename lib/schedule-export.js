'use strict';

// schedule-export.js — builds a clean, self-contained SVG of the schedule's
// Area Assignments + Modified Helpers grids for download/print/paste (issue:
// Schedule Viewer "Download schedule image" button).
//
// Pure + dual-loadable (browser global `ScheduleExport`, Node `module.exports`)
// so the same builder powers the tool AND its unit test (tests/schedule-export.test.js).
// The tool rasterises the returned SVG to PNG via <canvas>; this module never
// touches the DOM. The image is ALWAYS light-themed (white background, dark
// text) so it prints and pastes cleanly regardless of the viewer's theme.
//
// Colors mirror schedule.html's .area-* pill CSS (single on-screen source). If
// those hexes change, update DEFAULT_COLORS here and the test that pins them.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ScheduleExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Keyed by areaClass() output — matches schedule.html .area-* backgrounds.
  const DEFAULT_COLORS = {
    'area-A': '#4D148C',
    'area-B': '#1d4ed8',
    'area-C': '#0e7490',
    'area-ME': '#b45309',
    'area-DMG': '#dc2626',
    'area-CDMG': '#9333ea',
    'area-FLOAT': '#047857',
    'area-other': '#6b7280',
  };
  const CLASS_BY_CODE = {
    A: 'area-A', B: 'area-B', C: 'area-C', ME: 'area-ME',
    DMG: 'area-DMG', 'C/DMG': 'area-CDMG', FLOAT: 'area-FLOAT',
  };
  // Legend order + labels (only entries that actually appear are drawn).
  const LEGEND_ENTRIES = [
    { code: 'A', label: 'Cage A' },
    { code: 'B', label: 'Cage B' },
    { code: 'C', label: 'Cage C' },
    { code: 'ME', label: 'Middle Earth' },
    { code: 'DMG', label: 'Damages' },
    { code: 'FLOAT', label: 'Float' },
  ];

  const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

  function defaultIsOff(code) {
    const c = (code == null ? '' : String(code)).trim();
    return c === '' || c === '—' || c === '-' || c === '–';
  }
  function defaultColorFor(code) {
    if (defaultIsOff(code)) return null;
    const norm = String(code).trim().toUpperCase();
    return DEFAULT_COLORS[CLASS_BY_CODE[norm] || 'area-other'];
  }
  function xml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pillWidth(text, cellW) {
    const est = String(text).length * 8.3 + 20;
    return Math.max(40, Math.min(est, cellW - 8));
  }

  // opts:
  //   title      string  (default 'QA Schedule')
  //   week       string  (optional, right-aligned in the header)
  //   subtitle   string  (default 'Station 849 / NPHO')
  //   days       string[] weekday labels (default Sun..Sat)
  //   sections   [{ label, nameHeader, rows:[{ employee, cells:[...] }] }]
  //   colorFor   fn(code)->hex|null   (default mirrors the tool's pills)
  //   isOff      fn(code)->bool       (default —/blank aware)
  // Returns { svg, width, height }.
  function buildScheduleSVG(opts) {
    opts = opts || {};
    const title = opts.title != null ? opts.title : 'QA Schedule';
    const subtitle = opts.subtitle != null ? opts.subtitle : 'Station 849 / NPHO';
    const week = opts.week || '';
    const days = opts.days || ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const sections = (opts.sections || []).filter(function (s) { return s && s.rows && s.rows.length; });
    const colorFor = opts.colorFor || defaultColorFor;
    const isOff = opts.isOff || defaultIsOff;

    const W = 1180;
    const PAD = 34;
    const innerW = W - 2 * PAD;
    const nameColW = 150;
    const gridW = innerW - nameColW;
    const dayW = gridW / days.length;
    const headerH = 32;
    const rowH = 44;
    const sectionLabelH = 38;
    const sectionGap = 24;

    const parts = [];
    // Track which area codes appear, to prune the legend.
    const seen = {};

    // ── Header block ──
    let y = PAD;
    parts.push('<text x="' + PAD + '" y="' + (y + 30) + '" font-family="' + FONT +
      '" font-size="30" font-weight="800" fill="#0b0b0b">' + xml(title) + '</text>');
    if (week) {
      parts.push('<text x="' + (W - PAD) + '" y="' + (y + 30) + '" text-anchor="end" font-family="' + FONT +
        '" font-size="19" font-weight="600" fill="#52514e">' + xml(week) + '</text>');
    }
    if (subtitle) {
      parts.push('<text x="' + PAD + '" y="' + (y + 54) + '" font-family="' + FONT +
        '" font-size="14" fill="#52514e">' + xml(subtitle) + '</text>');
    }
    y += 78;

    // ── Sections ──
    sections.forEach(function (section) {
      // Section label
      parts.push('<text x="' + PAD + '" y="' + (y + 22) + '" font-family="' + FONT +
        '" font-size="18" font-weight="700" fill="#0b0b0b">' + xml(section.label || '') + '</text>');
      y += sectionLabelH;

      const tableTop = y;
      // Day header labels
      days.forEach(function (d, i) {
        const cx = PAD + nameColW + i * dayW + dayW / 2;
        parts.push('<text x="' + cx.toFixed(1) + '" y="' + (y + 21) + '" text-anchor="middle" font-family="' + FONT +
          '" font-size="13" font-weight="700" letter-spacing="0.6" fill="#6b6a66">' + xml(String(d).toUpperCase()) + '</text>');
      });
      const nameHeader = section.nameHeader || 'Employee';
      parts.push('<text x="' + (PAD + 8) + '" y="' + (y + 21) + '" font-family="' + FONT +
        '" font-size="13" font-weight="700" letter-spacing="0.6" fill="#6b6a66">' + xml(nameHeader.toUpperCase()) + '</text>');
      y += headerH;
      // Header underline
      parts.push('<line x1="' + PAD + '" y1="' + y + '" x2="' + (PAD + innerW) + '" y2="' + y +
        '" stroke="#d9d8d2" stroke-width="1.5"/>');

      // Rows
      section.rows.forEach(function (r, ri) {
        const rowY = y + ri * rowH;
        if (ri % 2 === 1) {
          parts.push('<rect x="' + PAD + '" y="' + rowY + '" width="' + innerW + '" height="' + rowH +
            '" fill="#f5f4f1"/>');
        }
        // Name
        parts.push('<text x="' + (PAD + 8) + '" y="' + (rowY + rowH / 2 + 5).toFixed(1) + '" font-family="' + FONT +
          '" font-size="16" font-weight="700" fill="#1a1a1a">' + xml(r.employee || '') + '</text>');
        // Day cells
        (r.cells || []).forEach(function (code, i) {
          const cellX = PAD + nameColW + i * dayW;
          const cx = cellX + dayW / 2;
          if (isOff(code)) {
            parts.push('<text x="' + cx.toFixed(1) + '" y="' + (rowY + rowH / 2 + 5).toFixed(1) +
              '" text-anchor="middle" font-family="' + FONT + '" font-size="15" fill="#b8b7b1">&#8212;</text>');
            return;
          }
          const label = String(code).trim();
          const norm = label.toUpperCase();
          if (CLASS_BY_CODE[norm]) seen[norm] = true;
          const color = colorFor(code) || '#6b7280';
          const pw = pillWidth(label, dayW);
          const px = cx - pw / 2;
          const py = rowY + (rowH - 28) / 2;
          parts.push('<rect x="' + px.toFixed(1) + '" y="' + py.toFixed(1) + '" width="' + pw.toFixed(1) +
            '" height="28" rx="6" ry="6" fill="' + color + '"/>');
          parts.push('<text x="' + cx.toFixed(1) + '" y="' + (py + 19).toFixed(1) +
            '" text-anchor="middle" font-family="' + FONT + '" font-size="14.5" font-weight="800" fill="#ffffff">' +
            xml(label) + '</text>');
        });
      });
      const tableBottom = y + section.rows.length * rowH;
      // Name/grid divider
      parts.push('<line x1="' + (PAD + nameColW) + '" y1="' + tableTop + '" x2="' + (PAD + nameColW) +
        '" y2="' + tableBottom + '" stroke="#d9d8d2" stroke-width="1.5"/>');
      // Row separators
      for (var s = 1; s < section.rows.length; s++) {
        const ly = y + s * rowH;
        parts.push('<line x1="' + PAD + '" y1="' + ly + '" x2="' + (PAD + innerW) + '" y2="' + ly +
          '" stroke="#ecebe6" stroke-width="1"/>');
      }
      y = tableBottom + sectionGap;
    });

    // ── Legend ──
    const legend = LEGEND_ENTRIES.filter(function (e) { return seen[e.code]; });
    if (legend.length) {
      parts.push('<line x1="' + PAD + '" y1="' + y + '" x2="' + (PAD + innerW) + '" y2="' + y +
        '" stroke="#e2e1dc" stroke-width="1"/>');
      y += 22;
      let lx = PAD;
      legend.forEach(function (e) {
        const color = defaultColorFor(e.code) || '#6b7280';
        parts.push('<rect x="' + lx + '" y="' + (y - 12) + '" width="15" height="15" rx="4" fill="' + color + '"/>');
        const text = e.code + ': ' + e.label;
        parts.push('<text x="' + (lx + 22) + '" y="' + y + '" font-family="' + FONT +
          '" font-size="14" fill="#2b2a28">' + xml(text) + '</text>');
        lx += 22 + text.length * 8.2 + 26;
      });
      y += 16;
    }

    // Logical (viewBox) size vs. rasterised pixel size. Setting the <svg>
    // width/height to logical*scale makes the browser rasterise the VECTOR at
    // high resolution when the tool loads it into an <img> — crisp text/pills at
    // any zoom — instead of the tool upscaling a 1x bitmap (which softened it).
    // Default scale=1 keeps the pure logical SVG (and the unit tests) unchanged.
    const logicalH = Math.ceil(y + PAD);
    const scale = opts.scale && opts.scale > 0 ? opts.scale : 1;
    const pxW = Math.round(W * scale);
    const pxH = Math.round(logicalH * scale);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + pxW + '" height="' + pxH +
      '" viewBox="0 0 ' + W + ' ' + logicalH + '">' +
      '<rect x="0" y="0" width="' + W + '" height="' + logicalH + '" fill="#fcfcfb"/>' +
      parts.join('') +
      '</svg>';

    // width/height are the rasterised PIXEL dimensions (canvas size); cssWidth/
    // cssHeight are the logical viewBox units.
    return { svg: svg, width: pxW, height: pxH, cssWidth: W, cssHeight: logicalH };
  }

  return {
    buildScheduleSVG: buildScheduleSVG,
    defaultColorFor: defaultColorFor,
    defaultIsOff: defaultIsOff,
    DEFAULT_COLORS: DEFAULT_COLORS,
  };
});
