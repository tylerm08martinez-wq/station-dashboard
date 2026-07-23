'use strict';

// Browse-first Raw-Data Viewer core (PRD #384, issue #388, ADR-0015).
//
// A reusable, browse-first, virtual-scrolled table that a host tool mounts over
// the report it already loaded. It opens on the WHOLE day (no filter), and keeps
// only a bounded slice of rows in the DOM so tens of thousands of rows never
// freeze the page. Sort, text-search, curated default columns + a "show all"
// toggle, and host-supplied facet/preset predicates. This is the shared table
// component only — it never re-ingests a report and knows nothing about coding;
// status derivation (coded/uncoded, etc.) is a host predicate, and row actions
// (quick-code, #392) are emitted as events for the host to handle.
//
// SPLIT (ADR-0015): the freeze-risk math is PURE and DOM-free —
//   - searchMatch / applySearch / sortRecords / applyFacets / applyPreset
//   - computeView (composes the above into the model the renderer paints)
//   - windowSlice (scroll offset + viewport -> the bounded index range)
//   - visibleColumns (curated default vs show-all)
//   - clampColumnWidth / columnWidthTemplate (drag-resizable column widths, #515)
// so it is unit-tested directly (tests/data-table.test.js). `mount()` is a thin
// DOM renderer over that math, DOM-tested through the real tool.
//
// Dual-loadable with no build step:
//   - Browser: window.DataTable.*
//   - Node:    require('./lib/data-table')

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DataTable = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const glob = (typeof globalThis !== 'undefined') ? globalThis
    : (typeof window !== 'undefined') ? window
    : (typeof self !== 'undefined') ? self : {};

  // ── PURE LOGIC ─────────────────────────────────────────────────────────────

  function cellText(rec, col) {
    if (rec == null) return '';
    const v = rec[col];
    return v == null ? '' : String(v);
  }

  // safeHttpUrl(u) -> the url when it is plainly http(s), else ''. Guards the
  // #517 linkColumns hook: only a real web link ever reaches an anchor's href,
  // so no host-supplied builder can turn a cell into a javascript: link.
  function safeHttpUrl(u) {
    const s = String(u == null ? '' : u).trim();
    return /^https?:\/\//i.test(s) ? s : '';
  }

  // searchMatch(record, query, searchColumns) -> bool. Case-insensitive substring
  // across the given columns' values. Blank/whitespace query matches everything.
  // Barcodes are matched as full text, so a partial tracking number hits.
  function searchMatch(record, query, searchColumns) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return true;
    const cols = Array.isArray(searchColumns) ? searchColumns : Object.keys(record || {});
    for (let i = 0; i < cols.length; i++) {
      if (cellText(record, cols[i]).toLowerCase().indexOf(q) !== -1) return true;
    }
    return false;
  }

  function applySearch(records, query, searchColumns) {
    const q = String(query == null ? '' : query).trim();
    if (!q) return (records || []).slice();
    return (records || []).filter(function (r) { return searchMatch(r, q, searchColumns); });
  }

  // sortRecords(records, column, direction) -> a NEW sorted array (non-mutating).
  // Uses a natural (numeric-aware) string comparison so numbers order by value
  // AND full-length barcodes stay intact — never coerced to a JS Number (which
  // would collapse a 12-digit tracking id toward scientific notation). No column
  // -> a stable copy in the original order.
  function sortRecords(records, column, direction) {
    const out = (records || []).slice();
    if (!column) return out;
    const dir = direction === 'desc' ? -1 : 1;
    const collator = (typeof Intl !== 'undefined' && Intl.Collator)
      ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
      : null;
    out.sort(function (a, b) {
      const av = cellText(a, column);
      const bv = cellText(b, column);
      let cmp;
      if (collator) cmp = collator.compare(av, bv);
      else cmp = av < bv ? -1 : (av > bv ? 1 : 0);
      return cmp * dir;
    });
    return out;
  }

  // applyFacets(records, facets, activeIds) -> records passing ALL active facet
  // predicates. Predicates are supplied by the host tool (status like
  // coded/uncoded needs the coding session), keeping this lib generic. No active
  // facet -> everything.
  function applyFacets(records, facets, activeIds) {
    const ids = Array.isArray(activeIds) ? activeIds : [];
    if (!ids.length) return (records || []).slice();
    const active = (facets || []).filter(function (f) { return f && ids.indexOf(f.id) !== -1; });
    if (!active.length) return (records || []).slice();
    return (records || []).filter(function (r) {
      return active.every(function (f) {
        try { return !!f.predicate(r); } catch (e) { return false; }
      });
    });
  }

  // applyPreset(records, presets, activeId) -> records passing the single active
  // preset predicate (host-supplied, e.g. "everything I scanned" = my scan name).
  // No active preset -> everything.
  function applyPreset(records, presets, activeId) {
    if (activeId == null) return (records || []).slice();
    const preset = (presets || []).filter(function (p) { return p && p.id === activeId; })[0];
    if (!preset || typeof preset.predicate !== 'function') return (records || []).slice();
    return (records || []).filter(function (r) {
      try { return !!preset.predicate(r); } catch (e) { return false; }
    });
  }

  // distinctValues(records, columns) -> the sorted, de-duped, non-blank values
  // present across the given columns. Backs a value picker (e.g. the scanner
  // picker, #389) — the host declares which columns identify a value and the lib
  // derives the option list from the loaded rows. Natural (numeric-aware) sort.
  function distinctValues(records, columns) {
    const cols = Array.isArray(columns) ? columns : [columns];
    const seen = Object.create(null);
    const out = [];
    (records || []).forEach(function (r) {
      cols.forEach(function (c) {
        const v = cellText(r, c).trim();
        if (v && !seen[v]) { seen[v] = true; out.push(v); }
      });
    });
    const collator = (typeof Intl !== 'undefined' && Intl.Collator)
      ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
      : null;
    out.sort(collator ? function (a, b) { return collator.compare(a, b); }
                      : function (a, b) { return a < b ? -1 : (a > b ? 1 : 0); });
    return out;
  }

  // applyPicker(records, columns, value) -> rows where ANY of the columns equals
  // value exactly. Blank/absent value -> everything (the picker is inert until a
  // value is chosen, matching browse-first: nothing hidden by default).
  function applyPicker(records, columns, value) {
    const v = value == null ? '' : String(value).trim();
    if (!v) return (records || []).slice();
    const cols = Array.isArray(columns) ? columns : [columns];
    return (records || []).filter(function (r) {
      for (let i = 0; i < cols.length; i++) {
        if (cellText(r, cols[i]).trim() === v) return true;
      }
      return false;
    });
  }

  // applyPickers(records, pickers, pickerValues) -> rows passing every picker that
  // has a chosen value. `pickers` is [{ id, columns }]; `pickerValues` maps
  // pickerId -> selected value. Pickers with no chosen value are inert.
  function applyPickers(records, pickers, pickerValues) {
    const list = Array.isArray(pickers) ? pickers : [];
    const vals = pickerValues || {};
    let rows = (records || []).slice();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p) continue;
      const chosen = vals[p.id];
      if (chosen == null || String(chosen).trim() === '') continue;
      rows = applyPicker(rows, p.columns, chosen);
    }
    return rows;
  }

  // computeView(config, state) -> the filtered + sorted record array the renderer
  // paints. Composition order: preset -> facets -> pickers -> search -> sort. Pure
  // over the full in-memory set, so every stage applies to the WHOLE report, not
  // just the rendered window.
  function computeView(config, state) {
    const cfg = config || {};
    const st = state || {};
    let rows = cfg.records || [];
    rows = applyPreset(rows, cfg.presets, st.presetId == null ? null : st.presetId);
    rows = applyFacets(rows, cfg.facets, st.facetIds);
    rows = applyPickers(rows, cfg.pickers, st.pickerValues);
    rows = applySearch(rows, st.search, cfg.searchColumns || cfg.columns);
    rows = sortRecords(rows, st.sortColumn || null, st.sortDir || 'asc');
    return rows;
  }

  // windowSlice({scrollTop, viewportHeight, rowHeight, totalRows, overscan})
  //   -> { startIndex, endIndex, offsetY, totalHeight }
  // The virtual-scroll math and the load-bearing freeze guard: given where the
  // user has scrolled and how tall the viewport is, return ONLY the bounded index
  // range to render, plus the pixel offset to push that window down by and the
  // full scrollable height. endIndex is EXCLUSIVE. The rendered count is
  // ~viewport rows + 2*overscan regardless of totalRows, so 40k rows paint the
  // same handful of nodes as 40.
  function windowSlice(opts) {
    const o = opts || {};
    const rowHeight = o.rowHeight > 0 ? o.rowHeight : 34;
    const totalRows = Math.max(0, o.totalRows | 0);
    const overscan = o.overscan >= 0 ? (o.overscan | 0) : 3;
    const scrollTop = Math.max(0, o.scrollTop || 0);
    const viewportHeight = Math.max(0, o.viewportHeight || 0);
    const totalHeight = totalRows * rowHeight;
    if (totalRows === 0) {
      return { startIndex: 0, endIndex: 0, offsetY: 0, totalHeight: 0 };
    }
    const firstVisible = Math.floor(scrollTop / rowHeight);
    let startIndex = Math.max(0, firstVisible - overscan);
    if (startIndex > totalRows - 1) startIndex = Math.max(0, totalRows - 1);
    const visibleCount = Math.ceil(viewportHeight / rowHeight);
    let endIndex = startIndex + visibleCount + 2 * overscan;
    if (endIndex > totalRows) endIndex = totalRows;
    return {
      startIndex: startIndex,
      endIndex: endIndex,
      offsetY: startIndex * rowHeight,
      totalHeight: totalHeight,
    };
  }

  // visibleColumns(allColumns, defaultColumns, showAll) -> the columns to render.
  // Curated default set by default (in its declared order, dropping any name not
  // in the real header); the full header when showAll; falls back to all columns
  // when no curated set is given.
  function visibleColumns(allColumns, defaultColumns, showAll) {
    const all = Array.isArray(allColumns) ? allColumns : [];
    if (showAll) return all.slice();
    const def = Array.isArray(defaultColumns) ? defaultColumns : [];
    if (!def.length) return all.slice();
    const present = def.filter(function (c) { return all.indexOf(c) !== -1; });
    return present.length ? present : all.slice();
  }

  // ── Drag-resizable columns (#515) ──
  // Session-only widths: the user drags a header border to pin that column to an
  // exact pixel width so long values (corrected addresses, recipient names) read
  // in full. The minimum keeps a column grabbable; there is deliberately NO
  // ceiling — reading a long value in full is the point, and a wide column just
  // scrolls horizontally like the show-all path already does.
  const MIN_COLUMN_WIDTH = 60;
  const DEFAULT_COLUMN_WIDTH = 110;
  const DEFAULT_COLUMN_TRACK = 'minmax(' + DEFAULT_COLUMN_WIDTH + 'px, 1fr)';

  // clampColumnWidth(px) -> px clamped to the minimum, rounded to whole pixels.
  function clampColumnWidth(px) {
    return Math.max(MIN_COLUMN_WIDTH, Math.round(px));
  }

  // columnWidthTemplate(cols, widths, hasActions) -> the grid-template-columns
  // track list for header AND rows. Columns with a custom width in `widths` are
  // pinned to exact pixels; everything else stays on the flexible default, and
  // the optional row-actions trailing column is always flexible. Pinned columns
  // stop flexing, so an exact width is exactly what the user dragged to.
  function columnWidthTemplate(cols, widths, hasActions) {
    const parts = (Array.isArray(cols) ? cols : []).map(function (c) {
      const w = widths ? widths[c] : null;
      return (typeof w === 'number' && w > 0) ? Math.round(w) + 'px' : DEFAULT_COLUMN_TRACK;
    });
    if (hasActions) parts.push(DEFAULT_COLUMN_TRACK);
    if (!parts.length) parts.push(DEFAULT_COLUMN_TRACK);
    return parts.join(' ');
  }

  // recurrenceGroups(records, recurrenceCfg, opts) -> the rollup groups the
  // Recurrence secondary view paints (ADR-0015, issue #391). A THIN adapter: it
  // runs the host-injected RecurrenceRollup over the given records (the CURRENT
  // filtered/sorted view) with the host's pair keySpec, or the bare-original
  // projection (recurrenceCfg.bareKeySpec) when opts.bare is set. The rollup math
  // itself lives in lib/recurrence-rollup.js and stays fully independent — this
  // only wires the current view into it and swallows a bad keySpec into [] so a
  // misconfigured host never throws in the render path.
  //   recurrenceCfg: { rollup?, keySpec, bareKeySpec?, ... }
  //   rollup defaults to the global RecurrenceRollup.rollup (script-tag load).
  function recurrenceGroups(records, recurrenceCfg, opts) {
    if (!recurrenceCfg) return [];
    const rollupFn = recurrenceCfg.rollup ||
      (glob.RecurrenceRollup && glob.RecurrenceRollup.rollup);
    if (typeof rollupFn !== 'function') return [];
    const bare = !!(opts && opts.bare);
    const keySpec = (bare && recurrenceCfg.bareKeySpec) ? recurrenceCfg.bareKeySpec : recurrenceCfg.keySpec;
    if (!keySpec) return [];
    try { return rollupFn(records || [], keySpec) || []; }
    catch (e) { return []; }
  }

  // ── DOM RENDERER (thin) ──────────────────────────────────────────────────────
  // mount(container, config) -> controller. `config`:
  //   { records, columns, defaultColumns, barcodeColumns, searchColumns,
  //     facets, presets, rowActions, rowHeight, overscan, viewportHeight,
  //     emptyText, onRowAction, columnWidths, formatters, linkColumns }
  // columnWidths (#516): optional { col: px } seed for the session widths —
  // the host's chosen STARTING layout (e.g. narrow Date/Tracking so addresses
  // get the room); a user drag overrides it, reload restores it.
  // formatters (#516): optional { col: fn(rawText, record) -> displayText } —
  // DISPLAY-ONLY decode (e.g. the corrections Date's 1YYMMDD -> MM/DD/YY).
  // Search and sort deliberately stay over the RAW value.
  // linkColumns (#517): optional { col: fn(rawText, record) -> url|'' } — the
  // cell renders as an anchor to that url (new tab, noopener) instead of plain
  // text; a falsy/rejected url falls back to plain text, so a row with no
  // linkable value never gets a dead link. The anchor is built through the DOM
  // with textContent, never markup, so the "no row value can inject markup"
  // invariant above still holds; only http(s) urls are accepted, so a
  // host-supplied builder can't smuggle in a javascript: scheme.
  // Row actions are emitted as a CustomEvent 'datatable:rowaction'
  // (detail: {actionId, record}) on the container AND passed to config.onRowAction
  // — the lib never knows what an action means. Each rowActions entry is
  // { id, label?, render? }: `render(record)` (optional) lets the host compute a
  // per-row label/className/title/disabled state from state IT owns (e.g. a
  // coding session), or hide the action for that row by returning a falsy value;
  // without `render` every row gets the static `label`. #388 mounted this
  // READ-ONLY (rowActions: []); #392 (IBNO quick-code) is the first caller of
  // `render`. The Address Catcher mount (ADR-0012) stays rowActions: [] — never a
  // write path back.
  function mount(container, config) {
    if (!container) throw new Error('data-table: mount needs a container element');
    const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('data-table: no document available to render into');

    const cfg = config || {};
    const rowHeight = cfg.rowHeight > 0 ? cfg.rowHeight : 34;
    const overscan = cfg.overscan >= 0 ? cfg.overscan : 6;
    // jsdom performs no layout (clientHeight is 0), so fall back to a configured
    // viewport height for the initial paint. In a real browser clientHeight wins.
    const viewportFallback = cfg.viewportHeight > 0 ? cfg.viewportHeight : 480;
    const barcodeSet = Object.create(null);
    (cfg.barcodeColumns || []).forEach(function (c) {
      barcodeSet[String(c == null ? '' : c).trim().toUpperCase()] = true;
    });

    const state = {
      records: cfg.records || [],
      columns: cfg.columns || (cfg.records && cfg.records[0] ? Object.keys(cfg.records[0]) : []),
      search: '',
      sortColumn: null,
      sortDir: 'asc',
      showAll: false,
      facetIds: [],
      presetId: null,
      pickerValues: {},
      // Session-only custom column widths (#515): col name -> pinned px. Lives
      // only in this mount's closure — survives the show-all toggle and a fresh
      // setRecords in the same session, resets on reload (no persistence
      // machinery, per the ticket). Seeded from cfg.columnWidths (#516): the
      // host's default pinned widths, which a drag then overrides.
      colWidths: (function () {
        const seed = Object.create(null);
        Object.keys(cfg.columnWidths || {}).forEach(function (c) {
          const w = cfg.columnWidths[c];
          if (typeof w === 'number' && w > 0) seed[c] = w;
        });
        return seed;
      })(),
      view: [],
      recurrenceOpen: false,
      recurrenceBare: false,
    };

    // ── build the shell ──
    container.classList.add('dt-root');
    container.innerHTML = '';

    const toolbar = doc.createElement('div');
    toolbar.className = 'dt-toolbar';

    const searchInput = doc.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'dt-search';
    searchInput.placeholder = 'Search tracking # or address…';
    searchInput.setAttribute('aria-label', 'Search rows');
    toolbar.appendChild(searchInput);

    const spacer = doc.createElement('span');
    spacer.className = 'dt-spacer';
    toolbar.appendChild(spacer);

    const countEl = doc.createElement('span');
    countEl.className = 'dt-count';
    toolbar.appendChild(countEl);

    const showAllBtn = doc.createElement('button');
    showAllBtn.type = 'button';
    showAllBtn.className = 'dt-showall';
    showAllBtn.textContent = 'Show all columns';
    toolbar.appendChild(showAllBtn);

    // Recurrence secondary-view toggle (#391, ADR-0015). Only the two ADDRESS
    // reports wire cfg.recurrence; the IBNO inbound viewer leaves it off
    // (recurrence there is Repeat History / Recurring IBNO — not re-derived).
    let recurrenceToggle = null;
    if (cfg.recurrence) {
      recurrenceToggle = doc.createElement('button');
      recurrenceToggle.type = 'button';
      recurrenceToggle.className = 'dt-recurrence-toggle';
      recurrenceToggle.textContent = cfg.recurrence.label || 'Recurrence';
      recurrenceToggle.title = 'Group the current view by how often each one repeats';
      toolbar.appendChild(recurrenceToggle);
    }

    container.appendChild(toolbar);

    // Refinements bar (host-supplied; empty for the read-only IBNO core mount):
    // status-facet chips (multi-select, AND), preset chips (single-select), and
    // value pickers (a <select> per picker). All are one-click refinements layered
    // on the browse-first view — nothing is hidden by default.
    const facetBar = doc.createElement('div');
    facetBar.className = 'dt-facets';
    (cfg.facets || []).forEach(function (f) {
      const chip = doc.createElement('button');
      chip.type = 'button';
      chip.className = 'dt-facet';
      chip.dataset.facetId = f.id;
      chip.textContent = f.label || f.id;
      chip.addEventListener('click', function () { toggleFacet(f.id); });
      facetBar.appendChild(chip);
    });
    (cfg.presets || []).forEach(function (p) {
      const chip = doc.createElement('button');
      chip.type = 'button';
      chip.className = 'dt-facet dt-preset';
      chip.dataset.presetId = p.id;
      chip.textContent = p.label || p.id;
      chip.addEventListener('click', function () { setPreset(p.id, p); });
      facetBar.appendChild(chip);
    });
    (cfg.pickers || []).forEach(function (p) {
      const sel = doc.createElement('select');
      sel.className = 'dt-picker';
      sel.dataset.pickerId = p.id;
      const first = doc.createElement('option');
      first.value = '';
      first.textContent = p.allLabel || ('All ' + (p.label || p.id));
      sel.appendChild(first);
      distinctValues(state.records, p.columns).forEach(function (v) {
        const opt = doc.createElement('option');
        opt.value = v;
        opt.textContent = v;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', function () { setPickerValue(p.id, sel.value); });
      facetBar.appendChild(sel);
    });
    if ((cfg.facets || []).length || (cfg.presets || []).length || (cfg.pickers || []).length) {
      container.appendChild(facetBar);
    }

    const header = doc.createElement('div');
    header.className = 'dt-header';
    container.appendChild(header);

    const scroll = doc.createElement('div');
    scroll.className = 'dt-scroll';
    const sizer = doc.createElement('div');
    sizer.className = 'dt-sizer';
    const rowsEl = doc.createElement('div');
    rowsEl.className = 'dt-rows';
    sizer.appendChild(rowsEl);
    scroll.appendChild(sizer);
    container.appendChild(scroll);

    const emptyEl = doc.createElement('div');
    emptyEl.className = 'dt-empty';
    container.appendChild(emptyEl);

    // Recurrence secondary view (#391). Hidden until toggled; when open it
    // replaces the table body with the rollup over the CURRENT view. Built only
    // when the host wires cfg.recurrence. Inline layout styles keep it usable
    // even before a host ships .dt-rec-* CSS (the component owns behavior, the
    // host owns polish — same split as the rest of the viewer).
    let recEl = null;
    let recListEl = null;
    let recTotalEl = null;
    let recBareBtn = null;
    if (cfg.recurrence) {
      recEl = doc.createElement('div');
      recEl.className = 'dt-recurrence';
      recEl.style.display = 'none';

      const recControls = doc.createElement('div');
      recControls.className = 'dt-rec-controls';

      recTotalEl = doc.createElement('span');
      recTotalEl.className = 'dt-rec-total';
      recControls.appendChild(recTotalEl);

      // Bare-original toggle: re-projects to the single key (e.g. Original
      // Address) to expose AMBIGUOUS originals. Only when the host defines a
      // bareKeySpec (the Corrections report does; Manual Assignment does not).
      if (cfg.recurrence.bareKeySpec) {
        recBareBtn = doc.createElement('button');
        recBareBtn.type = 'button';
        recBareBtn.className = 'dt-rec-bare';
        recBareBtn.textContent = cfg.recurrence.bareLabel || 'Bare original';
        recBareBtn.title = 'Group by the original only — exposes originals that map to several corrected values';
        recControls.appendChild(recBareBtn);
      }
      recEl.appendChild(recControls);

      recListEl = doc.createElement('div');
      recListEl.className = 'dt-rec-list';
      recEl.appendChild(recListEl);

      container.appendChild(recEl);
    }

    // ── wiring ──
    searchInput.addEventListener('input', function () {
      state.search = searchInput.value || '';
      recompute();
    });
    showAllBtn.addEventListener('click', function () {
      state.showAll = !state.showAll;
      showAllBtn.classList.toggle('on', state.showAll);
      renderHeader();
      renderWindow();
    });
    if (recurrenceToggle) {
      recurrenceToggle.addEventListener('click', function () { toggleRecurrence(); });
    }
    if (recBareBtn) {
      recBareBtn.addEventListener('click', function () { setRecurrenceBare(!state.recurrenceBare); });
    }
    let scrollRaf = null;
    scroll.addEventListener('scroll', function () {
      // Keep the (separate, non-scrolling) header aligned with the body's HORIZONTAL
      // scroll so column headers stay over their columns when "Show all columns" makes
      // the table wider than the viewport. Done synchronously so it never lags the body.
      header.scrollLeft = scroll.scrollLeft;
      if (scrollRaf != null) return;
      const raf = (container.ownerDocument.defaultView && container.ownerDocument.defaultView.requestAnimationFrame)
        ? container.ownerDocument.defaultView.requestAnimationFrame
        : function (cb) { return setTimeout(cb, 16); };
      scrollRaf = raf(function () { scrollRaf = null; renderWindow(); });
    });

    function columnTemplate(cols) {
      return columnWidthTemplate(cols, state.colWidths, !!(cfg.rowActions && cfg.rowActions.length));
    }

    // Re-apply the current column template to the header and the rendered rows.
    // Called live during a drag so the column follows the pointer; the virtual
    // window itself is untouched (same rows, same heights).
    function applyColumnTemplate() {
      const tmpl = columnTemplate(currentColumns());
      header.style.gridTemplateColumns = tmpl;
      Array.prototype.forEach.call(rowsEl.children, function (row) {
        row.style.gridTemplateColumns = tmpl;
      });
    }

    // Timestamp guard: a real browser fires a click after pointerup at the
    // press/release targets' common ancestor — release a drag off the 8px
    // handle and that click lands on the header CELL, which would sort
    // mid-resize. A drag that moved suppresses sorts for a brief window.
    let suppressSortUntil = 0;

    // Drag-to-resize a column border (#515). The handle sits on the header
    // cell's right border; pointermove on the DOCUMENT tracks the drag so the
    // pointer can leave the handle mid-drag without losing it. Starting width
    // comes from the session override, else the live rendered width, else the
    // flexible-default width — the last is what a no-layout environment
    // (jsdom) falls back to.
    function beginColumnResize(ev, col, handleEl) {
      ev.preventDefault();
      ev.stopPropagation();
      const th = handleEl.parentNode;
      const measured = th && typeof th.getBoundingClientRect === 'function'
        ? th.getBoundingClientRect().width : 0;
      const startWidth = state.colWidths[col] || measured || DEFAULT_COLUMN_WIDTH;
      const startX = ev.clientX;
      let moved = false;
      function onMove(e) {
        const w = clampColumnWidth(startWidth + ((e.clientX || 0) - startX));
        if (w === state.colWidths[col] && moved) return;
        if ((e.clientX || 0) !== startX) moved = true;
        state.colWidths[col] = w;
        applyColumnTemplate();
      }
      function onUp() {
        doc.removeEventListener('pointermove', onMove);
        doc.removeEventListener('pointerup', onUp);
        doc.removeEventListener('pointercancel', onUp);
        if (moved) suppressSortUntil = Date.now() + 350;
      }
      doc.addEventListener('pointermove', onMove);
      doc.addEventListener('pointerup', onUp);
      doc.addEventListener('pointercancel', onUp);
    }

    function currentColumns() {
      return visibleColumns(state.columns, cfg.defaultColumns, state.showAll);
    }

    function renderHeader() {
      const cols = currentColumns();
      header.style.gridTemplateColumns = columnTemplate(cols);
      header.innerHTML = '';
      cols.forEach(function (col) {
        const cell = doc.createElement('button');
        cell.type = 'button';
        cell.className = 'dt-th';
        if (state.sortColumn === col) cell.classList.add(state.sortDir === 'desc' ? 'sort-desc' : 'sort-asc');
        cell.textContent = col;
        cell.addEventListener('click', function () {
          if (Date.now() < suppressSortUntil) return; // click trailing a resize drag (#515)
          sortBy(col);
        });
        // Drag-to-resize handle on the cell's right border (#515). Inline
        // layout styles keep it usable before a host ships .dt-resizer CSS —
        // the component owns behavior, the host owns polish (same split as
        // the recurrence view). Clicks on the handle must never sort.
        cell.style.position = 'relative';
        const handle = doc.createElement('span');
        handle.className = 'dt-resizer';
        handle.style.position = 'absolute';
        handle.style.top = '0';
        handle.style.bottom = '0';
        handle.style.right = '0';
        handle.style.width = '8px';
        handle.style.cursor = 'col-resize';
        handle.style.touchAction = 'none';
        handle.setAttribute('aria-hidden', 'true');
        handle.addEventListener('pointerdown', function (ev) { beginColumnResize(ev, col, handle); });
        handle.addEventListener('click', function (ev) { ev.stopPropagation(); });
        cell.appendChild(handle);
        header.appendChild(cell);
      });
      if (cfg.rowActions && cfg.rowActions.length) {
        const ah = doc.createElement('span');
        ah.className = 'dt-th dt-th-actions';
        ah.textContent = '';
        header.appendChild(ah);
      }
    }

    function renderWindow() {
      const cols = currentColumns();
      const total = state.view.length;
      const viewportHeight = scroll.clientHeight || viewportFallback;
      const slice = windowSlice({
        scrollTop: scroll.scrollTop || 0,
        viewportHeight: viewportHeight,
        rowHeight: rowHeight,
        totalRows: total,
        overscan: overscan,
      });
      sizer.style.height = slice.totalHeight + 'px';
      rowsEl.style.transform = 'translateY(' + slice.offsetY + 'px)';
      const tmpl = columnTemplate(cols);
      const frag = doc.createDocumentFragment();
      for (let i = slice.startIndex; i < slice.endIndex; i++) {
        const rec = state.view[i];
        const row = doc.createElement('div');
        row.className = 'dt-row';
        // Optional host-supplied per-row class (issue #449, Address Catcher's
        // Raw-Data Viewer filtered-jump): rowClassName(record) -> a class
        // string (or falsy for none), appended onto the row so a host can
        // highlight rows without this lib knowing anything about WHY a row
        // is highlighted — same "host owns meaning, lib owns rendering" split
        // as rowActions.render(). Errors are swallowed like every other
        // host-supplied predicate in this file (searchMatch/applyFacets).
        if (typeof cfg.rowClassName === 'function') {
          let extraClass = '';
          try { extraClass = cfg.rowClassName(rec) || ''; } catch (e) { extraClass = ''; }
          if (extraClass) row.className += ' ' + extraClass;
        }
        row.style.height = rowHeight + 'px';
        row.style.gridTemplateColumns = tmpl;
        cols.forEach(function (col) {
          const c = doc.createElement('span');
          c.className = 'dt-td';
          const isBarcode = barcodeSet[String(col).trim().toUpperCase()] === true;
          if (isBarcode) c.classList.add('dt-mono');
          // textContent only: barcodes render as full literal text, never
          // scientific notation, and no row value can inject markup.
          // cfg.formatters (#516) is DISPLAY-ONLY — search/sort stay over
          // the raw value. Host-supplied, so a throwing formatter falls
          // back to the raw text like every other host predicate here.
          const rawText = cellText(rec, col);
          let display = rawText;
          const fmt = cfg.formatters ? cfg.formatters[col] : null;
          if (typeof fmt === 'function') {
            try { display = String(fmt(rawText, rec)); } catch (e) { display = rawText; }
          }
          // #517: a linkColumns column renders its value as a real anchor
          // (built via the DOM, textContent only) so a tracking number is one
          // click from FTrack. No url -> plain text, never a dead link.
          const linkFn = cfg.linkColumns ? cfg.linkColumns[col] : null;
          let href = '';
          if (typeof linkFn === 'function') {
            try { href = safeHttpUrl(linkFn(rawText, rec)); } catch (e) { href = ''; }
          }
          if (href) {
            const a = doc.createElement('a');
            a.className = 'dt-link';
            a.href = href;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = display;
            c.appendChild(a);
          } else {
            c.textContent = display;
          }
          c.title = display;
          row.appendChild(c);
        });
        if (cfg.rowActions && cfg.rowActions.length) {
          const actions = doc.createElement('span');
          actions.className = 'dt-td dt-actions';
          cfg.rowActions.forEach(function (act) {
            // render(record) -> { label, className, title, disabled } | null lets a
            // host derive per-row appearance from LIVE state it owns, or hide the
            // action entirely by returning a falsy value. This is how the IBNO
            // quick-code action (#392) reads the coding session (not a value baked
            // into the record) so the pill reflects the session as the single
            // authoritative source instead of drifting into a second value. When
            // no render() is supplied every row gets the same static label/id —
            // the original #388 read-only behavior.
            let spec = { label: act.label || act.id };
            if (typeof act.render === 'function') {
              try { spec = act.render(rec); } catch (e) { spec = null; }
            }
            if (!spec) return; // hidden for this row
            const b = doc.createElement('button');
            b.type = 'button';
            b.className = 'dt-action' + (spec.className ? ' ' + spec.className : '');
            b.textContent = spec.label != null ? spec.label : (act.label || act.id);
            if (spec.title) b.title = spec.title;
            if (spec.disabled) { b.disabled = true; b.classList.add('dt-action-disabled'); }
            b.addEventListener('click', function (ev) {
              ev.stopPropagation();
              if (b.disabled) return;
              emitRowAction(act.id, rec);
            });
            actions.appendChild(b);
          });
          row.appendChild(actions);
        }
        frag.appendChild(row);
      }
      rowsEl.innerHTML = '';
      rowsEl.appendChild(frag);
    }

    function emitRowAction(actionId, record) {
      if (typeof cfg.onRowAction === 'function') {
        try { cfg.onRowAction(actionId, record); } catch (e) { /* host owns errors */ }
      }
      const view = doc.defaultView;
      if (view && typeof view.CustomEvent === 'function') {
        container.dispatchEvent(new view.CustomEvent('datatable:rowaction', {
          bubbles: true, detail: { actionId: actionId, record: record },
        }));
      }
    }

    function updateCountAndEmpty() {
      const total = (state.records || []).length;
      const shown = state.view.length;
      if (!total) {
        emptyEl.textContent = cfg.emptyText || 'No report loaded.';
        emptyEl.style.display = 'block';
        scroll.style.display = 'none';
        header.style.display = 'none';
        countEl.textContent = '';
        return;
      }
      header.style.display = '';
      if (!shown) {
        const bits = [];
        if (state.search) bits.push('search “' + state.search.trim() + '”');
        if (state.facetIds.length) bits.push('facets ' + state.facetIds.join(', '));
        if (state.presetId) bits.push('preset ' + state.presetId);
        Object.keys(state.pickerValues || {}).forEach(function (k) {
          const v = state.pickerValues[k];
          if (v != null && String(v).trim() !== '') bits.push(k + ' “' + String(v).trim() + '”');
        });
        emptyEl.textContent = 'No rows match ' + (bits.length ? bits.join(' + ') : 'the active filters') + '.';
        emptyEl.style.display = 'block';
        scroll.style.display = 'none';
        countEl.textContent = '0 of ' + total;
        return;
      }
      emptyEl.style.display = 'none';
      scroll.style.display = '';
      countEl.textContent = shown === total
        ? (total + ' row' + (total === 1 ? '' : 's'))
        : (shown + ' of ' + total);
    }

    function recompute() {
      state.view = computeView({
        records: state.records,
        columns: state.columns,
        searchColumns: cfg.searchColumns || state.columns,
        facets: cfg.facets,
        presets: cfg.presets,
        pickers: cfg.pickers,
      }, {
        search: state.search,
        facetIds: state.facetIds,
        presetId: state.presetId,
        pickerValues: state.pickerValues,
        sortColumn: state.sortColumn,
        sortDir: state.sortDir,
      });
      updateCountAndEmpty();
      renderWindow();
      // Keep the recurrence view live with the current filtered view when open.
      if (recEl && state.recurrenceOpen) applyRecurrenceVisibility();
    }

    // ── Recurrence secondary view (#391, ADR-0015) ─────────────────────────────
    // Runs the host-injected rollup over state.view (the CURRENT filtered/sorted
    // records), rendering group + count most-frequent-first. Clicking a group
    // drills the table into it; the bare-original toggle re-projects to expose
    // ambiguous originals in the Corrections rollup.
    function renderRecurrence() {
      if (!recEl) return;
      const groups = recurrenceGroups(state.view, cfg.recurrence, { bare: state.recurrenceBare });
      recListEl.innerHTML = '';
      recTotalEl.textContent = groups.length
        ? (groups.length + ' group' + (groups.length === 1 ? '' : 's') +
           ' over ' + state.view.length + ' row' + (state.view.length === 1 ? '' : 's'))
        : '';
      if (recBareBtn) recBareBtn.classList.toggle('on', state.recurrenceBare);
      if (!groups.length) {
        const empty = doc.createElement('div');
        empty.className = 'dt-rec-empty';
        empty.textContent = state.view.length
          ? 'No repeating groups in the current view.'
          : 'No rows in the current view.';
        recListEl.appendChild(empty);
        return;
      }
      const frag = doc.createDocumentFragment();
      groups.forEach(function (g) {
        const row = doc.createElement('button');
        row.type = 'button';
        row.className = 'dt-rec-row';
        row.style.display = 'flex';
        row.style.width = '100%';
        row.style.textAlign = 'left';
        row.style.cursor = 'pointer';
        if (g.ambiguous) row.classList.add('ambiguous');

        const count = doc.createElement('span');
        count.className = 'dt-rec-count';
        count.textContent = String(g.count);
        row.appendChild(count);

        const key = doc.createElement('span');
        key.className = 'dt-rec-key';
        key.textContent = g.key;
        key.title = g.key;
        row.appendChild(key);

        // Ambiguous originals (bare projection): show how many corrected values
        // this one original maps to — the whole point of the bare toggle.
        if (g.ambiguous && Array.isArray(g.variants)) {
          const variants = doc.createElement('span');
          variants.className = 'dt-rec-variants';
          variants.textContent = g.variants.length + ' variants';
          variants.title = g.variants.map(function (v) { return v.value + ' (' + v.count + ')'; }).join(', ');
          row.appendChild(variants);
        }

        row.addEventListener('click', function () { selectRecurrenceGroup(g); });
        frag.appendChild(row);
      });
      recListEl.appendChild(frag);
    }

    // Show either the table or the recurrence panel per state.recurrenceOpen,
    // overriding the table visibility updateCountAndEmpty() would otherwise set.
    function applyRecurrenceVisibility() {
      if (!recEl) return;
      if (recurrenceToggle) recurrenceToggle.classList.toggle('on', state.recurrenceOpen);
      if (state.recurrenceOpen) {
        header.style.display = 'none';
        scroll.style.display = 'none';
        emptyEl.style.display = 'none';
        recEl.style.display = 'block';
        renderRecurrence();
      } else {
        recEl.style.display = 'none';
        // Let the normal data-driven visibility take back over.
        updateCountAndEmpty();
        renderWindow();
      }
    }

    function toggleRecurrence(open) {
      if (!recEl) return;
      state.recurrenceOpen = (open == null) ? !state.recurrenceOpen : !!open;
      applyRecurrenceVisibility();
    }

    function setRecurrenceBare(v) {
      state.recurrenceBare = !!v;
      if (recBareBtn) recBareBtn.classList.toggle('on', state.recurrenceBare);
      if (state.recurrenceOpen) renderRecurrence();
    }

    function selectRecurrenceGroup(group) {
      if (cfg.recurrence && typeof cfg.recurrence.onSelect === 'function') {
        try { cfg.recurrence.onSelect(group); } catch (e) { /* host owns errors */ }
      }
      const view = doc.defaultView;
      if (view && typeof view.CustomEvent === 'function') {
        container.dispatchEvent(new view.CustomEvent('datatable:recurrence-select', {
          bubbles: true, detail: { group: group },
        }));
      }
      // Drill the table into the group's leading key part (the address/original)
      // and return to the table so Tyler sees the underlying rows.
      const drill = (group && group.parts && group.parts.length) ? group.parts[0] : group.key;
      state.recurrenceOpen = false;
      state.search = drill || '';
      searchInput.value = state.search;
      recompute();
      applyRecurrenceVisibility();
    }

    function sortBy(col) {
      if (state.sortColumn === col) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortColumn = col;
        state.sortDir = 'asc';
      }
      renderHeader();
      recompute();
    }

    function toggleFacet(id) {
      const i = state.facetIds.indexOf(id);
      if (i === -1) state.facetIds.push(id); else state.facetIds.splice(i, 1);
      Array.prototype.forEach.call(facetBar.querySelectorAll('.dt-facet[data-facet-id]'), function (chip) {
        chip.classList.toggle('on', state.facetIds.indexOf(chip.dataset.facetId) !== -1);
      });
      recompute();
    }

    // setPreset(id, preset) -> single-select toggle. On ACTIVATION, an optional
    // host-supplied preset.prepare() runs first (e.g. resolve "my" scanner
    // identity once); if it returns false the activation is aborted, so the lib
    // stays generic and identity/prompt logic lives in the host.
    function setPreset(id, preset) {
      const turningOn = state.presetId !== id;
      if (turningOn && preset && typeof preset.prepare === 'function') {
        let ok;
        try { ok = preset.prepare(); } catch (e) { ok = false; }
        if (ok === false) return;
      }
      state.presetId = turningOn ? id : null;
      Array.prototype.forEach.call(facetBar.querySelectorAll('.dt-preset'), function (chip) {
        chip.classList.toggle('on', chip.dataset.presetId === state.presetId);
      });
      recompute();
    }

    function setPickerValue(id, value) {
      const v = value == null ? '' : String(value);
      if (v) state.pickerValues[id] = v; else delete state.pickerValues[id];
      recompute();
    }

    // Rebuild a picker's option list from the current records (option list is
    // data-derived, so a fresh load repopulates the scanner list).
    function rebuildPickerOptions() {
      (cfg.pickers || []).forEach(function (p) {
        const sel = facetBar.querySelector('.dt-picker[data-picker-id="' + p.id + '"]');
        if (!sel) return;
        const keep = sel.value;
        while (sel.options.length > 1) sel.remove(1);
        distinctValues(state.records, p.columns).forEach(function (v) {
          const opt = doc.createElement('option');
          opt.value = v;
          opt.textContent = v;
          sel.appendChild(opt);
        });
        // preserve the selection if it still exists; otherwise reset to "all"
        if (keep && distinctValues(state.records, p.columns).indexOf(keep) !== -1) sel.value = keep;
        else { sel.value = ''; delete state.pickerValues[p.id]; }
      });
    }

    function setRecords(records, columns) {
      state.records = records || [];
      state.columns = columns || (records && records[0] ? Object.keys(records[0]) : state.columns);
      rebuildPickerOptions();
      renderHeader();
      recompute();
    }

    // initial paint
    renderHeader();
    recompute();

    return {
      setSearch: function (q) { state.search = q || ''; searchInput.value = state.search; recompute(); },
      sortBy: sortBy,
      toggleFacet: toggleFacet,
      setPreset: setPreset,
      setPickerValue: setPickerValue,
      setShowAll: function (v) { state.showAll = !!v; showAllBtn.classList.toggle('on', state.showAll); renderHeader(); renderWindow(); },
      setRecords: setRecords,
      refresh: recompute,
      toggleRecurrence: toggleRecurrence,
      setRecurrenceBare: setRecurrenceBare,
      isRecurrenceOpen: function () { return state.recurrenceOpen; },
      getRecurrenceGroups: function () {
        return recurrenceGroups(state.view, cfg.recurrence, { bare: state.recurrenceBare });
      },
      getColumnWidths: function () { return Object.assign({}, state.colWidths); },
      getViewCount: function () { return state.view.length; },
      getRenderedRowCount: function () { return rowsEl.children.length; },
      getState: function () { return { search: state.search, sortColumn: state.sortColumn, sortDir: state.sortDir, showAll: state.showAll, facetIds: state.facetIds.slice(), presetId: state.presetId, pickerValues: Object.assign({}, state.pickerValues) }; },
      el: container,
    };
  }

  return {
    // pure
    searchMatch: searchMatch,
    applySearch: applySearch,
    sortRecords: sortRecords,
    applyFacets: applyFacets,
    applyPreset: applyPreset,
    distinctValues: distinctValues,
    applyPicker: applyPicker,
    applyPickers: applyPickers,
    computeView: computeView,
    windowSlice: windowSlice,
    visibleColumns: visibleColumns,
    clampColumnWidth: clampColumnWidth,
    columnWidthTemplate: columnWidthTemplate,
    recurrenceGroups: recurrenceGroups,
    safeHttpUrl: safeHttpUrl,
    // dom
    mount: mount,
  };
});
