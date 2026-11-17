/* ============================================================================
 *  CGO Hub — the tab bar, the Today page and the Calendar page.
 *
 *  Nothing here decides anything about money. The campaign verdicts, the
 *  nightly plan and the creative desk are still made by rules.js / creative.js
 *  and drawn by app.js. The hub only
 *    1. sorts the existing sections into four tabs (nothing is removed),
 *    2. adds a Today page that gathers what needs attention,
 *    3. adds a Calendar page (dates, checklists, starter texts) built on
 *       calendar.js.
 *  Everything the owner changes (ticks, own dates, shipping days, discount)
 *  is kept in THIS browser only.
 * ========================================================================== */
(function () {
  'use strict';
  const K = window.CgoCalendar;
  if (!K) return;

  const TABS = [
    { id: 'today',     en: 'Today',     de: 'Heute',    icon: '🏠' },
    { id: 'calendar',  en: 'Calendar',  de: 'Kalender', icon: '📅' },
    { id: 'campaigns', en: 'Campaigns', de: 'Kampagnen', icon: '📊' },
    { id: 'creatives', en: 'Creatives', de: 'Kreative', icon: '🎬' },
    { id: 'all',       en: 'Everything', de: 'Alles',   icon: '☰', quiet: true }
  ];
  const AREA = { legal: 'Legal', creative: 'Creative', ads: 'Ads', funnel: 'Funnel', shipping: 'Shipping', budget: 'Budget', support: 'Support' };
  const KIND_FILTERS = [
    { id: 'all', label: 'All' }, { id: 'sale', label: 'Sales' }, { id: 'gift', label: 'Gift dates' },
    { id: 'holiday', label: 'Holidays' }, { id: 'season', label: 'Seasons' }, { id: 'custom', label: 'My dates' }
  ];
  const CONF = { fixed: ['Fixed date', 'Same calendar date every year'], computed: ['Calculated', 'An exact date worked out by rule for each year'], typical: ['Typical pattern', 'A usual pattern with no exact date. Check it against your own numbers'] };
  const VERDICT_ICON = { KILL: '⛔', DESCALE: '📉', PRICE_DROP: '🏷️', SCALE: '📈', SURF: '🏄', PROVE: '⏳', HOLD: '✋', MONITOR: '👀', DIAGNOSE: '🔧', NEEDS_SETUP: '⚙️' };

  /* ------------------------------------------------------------- storage -- */
  const KEY = 'cgo_hub_';
  const S = {
    get(k, d) { try { const v = localStorage.getItem(KEY + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };

  const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const cleanShip = (o) => {
    const d = K.SHIPPING_DEFAULT, s = o && typeof o === 'object' ? o : {};
    return { handling: clampInt(s.handling, 0, 30, d.handling), transitWorst: clampInt(s.transitWorst, 0, 60, d.transitWorst), buffer: clampInt(s.buffer, 0, 30, d.buffer) };
  };
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  const validISO = (s) => typeof s === 'string' && ISO_RE.test(s) && K.iso(K.parse(s)) === s;
  const CUSTOM_KINDS = ['sale', 'gift', 'holiday', 'occasion'];
  const CUSTOM_CPM = ['high', 'up', 'dip'];
  const cleanCustom = (list) => (Array.isArray(list) ? list : []).filter(c => c && typeof c.name === 'string' && c.name.trim() && validISO(c.date))
    .map(c => ({
      id: String(c.id || 'c_' + Math.random().toString(36).slice(2, 8)).replace(/[^\w-]/g, ''),
      name: c.name.trim().slice(0, 80), date: c.date,
      end: validISO(c.end) && c.end >= c.date ? c.end : '',
      kind: CUSTOM_KINDS.includes(c.kind) ? c.kind : 'sale',
      cpm: CUSTOM_CPM.includes(c.cpm) ? c.cpm : null,
      note: String(c.note || '').slice(0, 300)
    }));

  const M = {
    tab: 'today',
    done: S.get('done', {}) || {},
    custom: cleanCustom(S.get('custom', [])),
    ship: cleanShip(S.get('ship', null)),
    discount: String(S.get('discount', '') || '').slice(0, 20),
    view: S.get('view', '90') === 'year' ? 'year' : '90',
    filter: KIND_FILTERS.some(f => f.id === S.get('filter', 'all')) ? S.get('filter', 'all') : 'all',
    costOnly: !!S.get('costOnly', false),
    open: new Set(),
    ctx: null,
    index: {},
    today: ''
  };

  /* --------------------------------------------------------------- helpers -- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function tz() { return (M.ctx && M.ctx.tz) || 'Europe/Berlin'; }
  function todayISO() {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  const fmtDay = (iso, withYear) => K.parse(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: withYear ? 'numeric' : undefined, timeZone: 'UTC' });
  const fmtShort = (iso) => K.parse(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const fmtLong = (iso) => K.parse(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const fmtLongDE = (iso) => K.parse(iso).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const monthName = (iso) => K.parse(iso).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  function range(ev, withYear) {
    return ev.start === ev.end ? fmtDay(ev.start, withYear) : `${fmtShort(ev.start)} – ${fmtShort(ev.end)}${withYear ? ' ' + ev.end.slice(0, 4) : ''}`;
  }

  function countdown(ev, today) {
    if (K.isActive(ev, today)) {
      if (ev.start === ev.end) return { text: 'Today', tone: 'now' };
      const left = K.diffDays(ev.end, today);
      return { text: left === 0 ? 'Running now · last day today' : `Running now · ${plural(left, 'day')} left`, tone: 'now' };
    }
    const d = K.diffDays(ev.start, today);
    if (d > 0) return { text: d === 1 ? 'Tomorrow' : `In ${d} days`, tone: d <= 14 ? 'soon' : 'later' };
    return { text: 'Over', tone: 'past' };
  }

  function dueLabel(task, ev, today) {
    const d = K.diffDays(task.due, today);
    if (task.done) return { text: `Done · was due ${fmtShort(task.due)}`, tone: 'done' };
    if (ev.end < today) return { text: `Was due ${fmtShort(task.due)}`, tone: 'past' };
    if (d < 0) return { text: `Overdue · was due ${fmtShort(task.due)}`, tone: 'late' };
    if (d === 0) return { text: 'Due today', tone: 'today' };
    if (d === 1) return { text: 'Due tomorrow', tone: 'soon' };
    return { text: `Due ${fmtShort(task.due)} · in ${d} days`, tone: d <= 7 ? 'soon' : 'later' };
  }

  function buildEvents(from, months, includePast) {
    return K.build(from, months, { ship: M.ship, custom: M.custom, done: M.done, includePast: !!includePast });
  }

  /* ------------------------------------------------------------- style ---- */
  function injectStyle() {
    if ($('#hub-style')) return;
    const css = `
header { position: static; }
main > [hidden] { display: none !important; }
.hub-tabs { position: sticky; top: 0; z-index: 90; background: color-mix(in srgb, var(--bg-app) 92%, transparent); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border-color); }
.hub-tabs-inner { display: flex; gap: 6px; max-width: var(--max-width); margin: 0 auto; padding: 8px 24px; }
.hub-tab { position: relative; flex: 1 1 0; min-height: 52px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; padding: 6px 8px; border-radius: var(--radius-md); border: 1px solid transparent; background: transparent; color: var(--text-secondary); cursor: pointer; font: inherit; transition: background var(--t-fast), color var(--t-fast); }
.hub-tab:hover { background: var(--bg-card); color: var(--text-primary); }
.hub-tab:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
.hub-tab[aria-selected="true"] { background: var(--bg-card-solid); color: var(--text-primary); border-color: var(--border-hover); box-shadow: 0 0 0 3px var(--accent-glow); }
.hub-tab.quiet { flex: 0.6 1 0; }
.hub-tab-en { font-weight: 600; font-size: 15px; }
.hub-tab-de { font-size: 11px; color: var(--text-muted); letter-spacing: .02em; }
.hub-badge { position: absolute; top: 4px; right: 8px; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: var(--color-danger); color: #fff; font-size: 11px; font-weight: 700; line-height: 20px; text-align: center; }
.hub-badge.calm { background: var(--accent-primary); }
.hub-page { display: flex; flex-direction: column; gap: 18px; margin-bottom: 8px; }
.hub-page h2, .hub-page h3 { margin: 0; }
.hub-title { font-size: 22px; line-height: 1.25; }
.hub-title small { font-size: 14px; font-weight: 500; color: var(--text-muted); margin-left: 6px; }
.hub-lede { margin: 6px 0 0; color: var(--text-secondary); max-width: 70ch; line-height: 1.55; }
.hub-card { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 20px; }
.hub-card h3 { font-size: 16px; margin-bottom: 4px; }
.hub-sub { color: var(--text-muted); font-size: 13px; }
.hub-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.hub-tile { display: flex; flex-direction: column; gap: 2px; padding: 16px; border-radius: var(--radius-md); background: var(--bg-card); border: 1px solid var(--border-color); text-align: left; font: inherit; color: inherit; cursor: pointer; }
.hub-tile:hover { border-color: var(--border-hover); }
.hub-tile b { font-size: 28px; line-height: 1.1; }
.hub-tile span { color: var(--text-secondary); font-size: 13px; }
.hub-tile.warn b { color: var(--color-warning); }
.hub-tile.bad b { color: var(--color-danger); }
.hub-tile.good b { color: var(--color-success); }
.hub-hero { border-left: 4px solid var(--accent-secondary); }
.hub-hero.now { border-left-color: var(--color-danger); }
.hub-hero-top { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; justify-content: space-between; }
.hub-hero-name { font-size: 22px; font-weight: 700; }
.hub-hero-name small { font-size: 14px; font-weight: 500; color: var(--text-muted); margin-left: 6px; }
.hub-count { font-weight: 700; font-size: 15px; padding: 4px 12px; border-radius: 999px; background: var(--color-neutral-bg); }
.hub-count.now { background: var(--color-danger-bg); color: var(--color-danger); }
.hub-count.soon { background: var(--color-warning-bg); color: var(--color-warning); }
.hub-facts { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 10px 0 0; color: var(--text-secondary); font-size: 14px; }
.hub-link { background: none; border: 0; padding: 0; font: inherit; color: var(--accent-primary); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.hub-link:hover { color: var(--accent-secondary); }
.hub-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
.hub-btn { min-height: 40px; padding: 8px 16px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); background: var(--bg-card-solid); color: var(--text-primary); font: inherit; font-weight: 600; cursor: pointer; }
.hub-btn:hover { border-color: var(--border-hover); }
.hub-btn.primary { background: var(--accent-primary); border-color: var(--accent-primary); color: #fff; }
.hub-btn.danger { color: var(--color-danger); }
.hub-btn:focus-visible, .hub-chip:focus-visible, .hub-link:focus-visible, .hub-tile:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
.hub-empty { padding: 14px 16px; border-radius: var(--radius-md); background: var(--color-neutral-bg); color: var(--text-secondary); line-height: 1.5; }
.hub-rows { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.hub-row { display: flex; align-items: center; gap: 12px; padding: 10px 4px; border-bottom: 1px solid var(--border-color); }
.hub-row:last-child { border-bottom: 0; }
.hub-row-main { flex: 1; min-width: 0; }
.hub-row-title { font-weight: 600; }
.hub-row-sub { color: var(--text-muted); font-size: 13px; }
.cal-bar { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; }
.cal-seg { display: inline-flex; border: 1px solid var(--border-color); border-radius: var(--radius-sm); overflow: hidden; }
.cal-seg button { min-height: 38px; padding: 6px 14px; border: 0; background: var(--bg-card); color: var(--text-secondary); font: inherit; cursor: pointer; }
.cal-seg button[aria-pressed="true"] { background: var(--accent-primary); color: #fff; }
.cal-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.hub-chip { min-height: 34px; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--border-color); background: var(--bg-card); color: var(--text-secondary); font: inherit; font-size: 13px; cursor: pointer; }
.hub-chip[aria-pressed="true"] { background: var(--accent-glow); border-color: var(--accent-primary); color: var(--text-primary); }
.cal-check { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; color: var(--text-secondary); cursor: pointer; min-height: 34px; }
.cal-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12.5px; color: var(--text-muted); }
.cal-list { display: flex; flex-direction: column; gap: 10px; }
.cal-month { margin: 12px 0 2px; font-size: 15px; font-weight: 700; color: var(--text-secondary); letter-spacing: .02em; }
.cal-ev { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); }
.cal-ev[open] { border-color: var(--border-hover); }
.cal-ev.is-past { opacity: .6; }
.cal-ev.is-now { border-left: 4px solid var(--color-danger); }
.cal-ev > summary { list-style: none; display: flex; gap: 14px; align-items: center; padding: 14px 16px; cursor: pointer; min-height: 56px; }
.cal-ev > summary::-webkit-details-marker { display: none; }
.cal-ev > summary:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: -2px; border-radius: var(--radius-md); }
.cal-date { flex: 0 0 56px; text-align: center; line-height: 1.1; }
.cal-date b { display: block; font-size: 24px; }
.cal-date span { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; }
.cal-main { flex: 1; min-width: 0; }
.cal-name { font-weight: 700; font-size: 16px; }
.cal-name small { font-weight: 500; color: var(--text-muted); margin-left: 6px; font-size: 13px; }
.cal-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 4px; align-items: center; font-size: 13px; color: var(--text-secondary); }
.cal-when { flex: 0 0 auto; font-size: 13px; font-weight: 700; padding: 4px 10px; border-radius: 999px; background: var(--color-neutral-bg); white-space: nowrap; }
.cal-when.now { background: var(--color-danger-bg); color: var(--color-danger); }
.cal-when.soon { background: var(--color-warning-bg); color: var(--color-warning); }
.cal-prog { font-size: 12px; color: var(--text-muted); }
.tag { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; background: var(--color-neutral-bg); color: var(--text-secondary); white-space: nowrap; }
.tag.k-sale { background: var(--color-danger-bg); color: var(--color-danger); }
.tag.k-gift { background: var(--color-warning-bg); color: var(--color-warning); }
.tag.k-custom { background: var(--accent-glow); color: var(--accent-primary); }
.tag.cpm-high { background: var(--color-danger-bg); color: var(--color-danger); }
.tag.cpm-up { background: var(--color-warning-bg); color: var(--color-warning); }
.tag.cpm-dip { background: var(--color-success-bg); color: var(--color-success); }
.cal-body { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 14px; }
.cal-note { margin: 0; color: var(--text-secondary); line-height: 1.55; }
.cal-orderby { padding: 10px 14px; border-radius: var(--radius-sm); background: var(--color-warning-bg); line-height: 1.5; }
.cal-tasks { display: flex; flex-direction: column; gap: 2px; }
.cal-task { display: flex; gap: 12px; align-items: flex-start; padding: 10px 6px; border-radius: var(--radius-sm); cursor: pointer; }
.cal-task:hover { background: var(--accent-glow); }
.cal-task input { width: 22px; height: 22px; margin-top: 1px; flex: 0 0 auto; accent-color: var(--accent-primary); cursor: pointer; }
.ct-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.ct-title { font-weight: 600; }
.ct-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; font-size: 12.5px; }
.ct-due { color: var(--text-muted); }
.ct-due.late { color: var(--color-danger); font-weight: 700; }
.ct-due.today { color: var(--color-warning); font-weight: 700; }
.ct-due.soon { color: var(--color-warning); }
.ct-detail { color: var(--text-secondary); font-size: 13.5px; line-height: 1.5; }
.cal-task.is-done .ct-title { text-decoration: line-through; color: var(--text-muted); }
.cal-task.is-done .ct-detail { display: none; }
.cs { border: 1px dashed var(--border-hover); border-radius: var(--radius-md); padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.cs-head { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; }
.cs-disc { width: 110px; min-height: 38px; padding: 6px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); background: var(--bg-input); color: var(--text-primary); font: inherit; }
.cs-row { display: grid; grid-template-columns: 130px 1fr; gap: 6px 14px; padding-top: 10px; border-top: 1px solid var(--border-color); }
.cs-label b { display: block; }
.cs-label span { font-size: 12px; color: var(--text-muted); }
.cs-lines { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.cs-line { display: flex; gap: 10px; align-items: flex-start; }
.cs-line .lang { flex: 0 0 24px; font-size: 11px; font-weight: 700; color: var(--text-muted); padding-top: 8px; }
.cs-line .txt { flex: 1; min-width: 0; padding: 6px 10px; border-radius: var(--radius-sm); background: var(--bg-input); line-height: 1.45; overflow-wrap: anywhere; }
.cs-line.en .txt { color: var(--text-secondary); }
.cs-copy { flex: 0 0 auto; min-height: 34px; padding: 4px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); background: var(--bg-card-solid); color: var(--text-primary); font: inherit; font-size: 13px; cursor: pointer; }
.cs-copy:hover { border-color: var(--border-hover); }
.cal-side { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; align-items: start; }
.hub-form { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.hub-form label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-secondary); }
.hub-form input, .hub-form select, .hub-form textarea { min-height: 40px; padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); background: var(--bg-input); color: var(--text-primary); font: inherit; }
.hub-form textarea { min-height: 90px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.hub-form .two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.hub-form .three { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
.hub-msg { font-size: 13px; min-height: 18px; }
.hub-msg.bad { color: var(--color-danger); }
.hub-msg.good { color: var(--color-success); }
@media (max-width: 720px) {
  .hub-tabs-inner { padding: 6px 8px; gap: 4px; }
  .hub-tab { min-height: 54px; padding: 4px 2px; }
  .hub-tab-en { font-size: 13px; }
  .hub-tab-de { font-size: 10px; }
  .hub-badge { right: 2px; top: 2px; min-width: 18px; height: 18px; line-height: 18px; font-size: 10px; padding: 0 5px; }
  .hub-title { font-size: 19px; }
  .hub-card { padding: 16px; }
  .hub-hero-name { font-size: 19px; }
  .cal-ev > summary { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 8px 12px; padding: 12px; align-items: start; }
  .cal-date { flex: none; }
  .cal-when { grid-column: 2; justify-self: start; }
  .cs-row { grid-template-columns: 1fr; }
  .cs-line { flex-wrap: wrap; }
  .cs-line .txt { flex-basis: calc(100% - 34px); }
  .hub-form .three { grid-template-columns: 1fr; }
}
@media print { .hub-tabs { display: none; } }
`;
    const st = document.createElement('style');
    st.id = 'hub-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------------------------------------------------- tabs & visibility -- */
  function pageFor(el) {
    if (el.id === 'hub-today') return 'today';
    if (el.id === 'hub-calendar') return 'calendar';
    if (el.id === 'plan-panel') return 'today';
    if (el.id === 'guardrails') return 'today campaigns';
    if (el.id === 'creative-desk' || el.classList.contains('table-card')) return 'creatives';
    if (el.tagName === 'FOOTER') return 'all';
    return 'campaigns';
  }

  function applyVisibility() {
    const main = $('main');
    if (!main) return;
    Array.from(main.children).forEach(el => {
      if (!el.dataset.hub) el.dataset.hub = pageFor(el);
      const pages = el.dataset.hub.split(' ');
      el.hidden = M.tab === 'all'
        ? (el.id === 'hub-today' || el.id === 'hub-calendar')       // "Everything" = the page as it was before the tabs
        : !(pages.includes('all') || pages.includes(M.tab));
    });
    $$('.hub-tab').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === M.tab ? 'true' : 'false'));
    $$('.hub-tab').forEach(b => { b.tabIndex = b.dataset.tab === M.tab ? 0 : -1; });
  }

  function setTab(id, opts) {
    if (!TABS.some(t => t.id === id)) id = 'today';
    M.tab = id;
    S.set('tab', id);
    try { history.replaceState(null, '', '#' + id); } catch (e) { /* file:// or sandbox */ }
    applyVisibility();
    if (id === 'calendar') renderCalendar();
    if (id === 'campaigns' || id === 'creatives' || id === 'all') {
      try { Object.values((window.CgoState && window.CgoState.charts) || {}).forEach(c => c && c.resize && c.resize()); } catch (e) { /* charts are optional */ }
      window.dispatchEvent(new Event('resize'));
    }
    if (!opts || !opts.silent) {
      const nav = $('#hub-tabs');
      const top = nav ? nav.getBoundingClientRect().top + window.scrollY : 0;
      window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    }
  }

  function setupTabs() {
    const nav = $('#hub-tabs');
    if (!nav) return;
    nav.innerHTML = `<div class="hub-tabs-inner" role="tablist" aria-label="Sections · Bereiche">${TABS.map(t => `
      <button class="hub-tab${t.quiet ? ' quiet' : ''}" role="tab" data-tab="${t.id}" aria-selected="false" id="hub-tab-${t.id}">
        <span class="hub-tab-en">${t.icon} ${t.en}</span><span class="hub-tab-de">${t.de}</span>
        <span class="hub-badge" hidden></span>
      </button>`).join('')}</div>`;
    nav.addEventListener('click', e => {
      const b = e.target.closest('.hub-tab');
      if (b) setTab(b.dataset.tab);
    });
    nav.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
      const i = TABS.findIndex(t => t.id === M.tab);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
      setTab(TABS[next].id, { silent: true });
      const b = $(`#hub-tab-${TABS[next].id}`);
      if (b) b.focus();
      e.preventDefault();
    });
    window.addEventListener('hashchange', () => {
      const id = location.hash.replace('#', '');
      if (TABS.some(t => t.id === id) && id !== M.tab) setTab(id);
    });
  }

  function updateBadges() {
    const set = (id, n, calm) => {
      const b = $(`#hub-tab-${id} .hub-badge`);
      if (!b) return;
      b.hidden = !(n > 0);
      b.textContent = n > 99 ? '99+' : String(n);
      b.classList.toggle('calm', !!calm);
    };
    const plan = M.ctx && M.ctx.plan;
    const due = K.dueTasks(buildEvents(M.today, 12), M.today, 7);
    set('today', plan ? plan.items.length : 0);
    set('calendar', due.length, true);
    set('creatives', plan ? (plan.summary.creativeJobs || 0) : 0, true);
  }

  /* ----------------------------------------------------------- Today page -- */
  function renderToday() {
    const host = $('#hub-today');
    if (!host) return;
    const ctx = M.ctx || {};
    const today = M.today;
    const events = buildEvents(today, 12);
    const next = K.nextBig(events, today);
    const due = K.dueTasks(events, today, 7);
    const plan = ctx.plan;
    const live = ctx.source === 'api';
    const campaigns = (ctx.campaigns || []).filter(c => /^(ACTIVE|WITH_ISSUES)$/i.test(c.status || ''));
    const sync = ctx.lastSync ? new Date(ctx.lastSync).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz() }) : '';

    const tiles = `
      <div class="hub-tiles">
        <button class="hub-tile ${plan && plan.items.length ? 'warn' : 'good'}" data-go="today-plan"><b>${plan ? plan.items.length : '–'}</b><span>${plan ? (plan.items.length ? 'things to do tonight' : 'nothing to do tonight') : 'tonight’s plan (needs live data)'}</span></button>
        <button class="hub-tile ${due.some(d => d.overdue) ? 'bad' : due.length ? 'warn' : 'good'}" data-go="calendar"><b>${due.length}</b><span>${due.length ? `calendar ${due.length === 1 ? 'task' : 'tasks'} due now${due.some(d => d.overdue) ? ' (some overdue)' : ''}` : 'calendar tasks due this week'}</span></button>
        <button class="hub-tile" data-go="campaigns"><b>${live ? campaigns.length : '–'}</b><span>${live ? 'campaigns running' : 'campaigns (needs live data)'}</span></button>
        <button class="hub-tile ${plan && plan.summary.creativeJobs ? 'warn' : ''}" data-go="creatives"><b>${plan ? (plan.summary.newAds || 0) : '–'}</b><span>${plan ? 'new creatives to make' : 'creatives (needs live data)'}</span></button>
      </div>`;

    let hero = '';
    if (next) {
      const c = countdown(next, today);
      const open = next.tasks.filter(t => !t.done);
      hero = `
      <div class="hub-card hub-hero ${c.tone === 'now' ? 'now' : ''}">
        <div class="hub-hero-top">
          <div class="hub-hero-name">${esc(next.name)}${next.de && next.de !== next.name ? `<small>${esc(next.de)}</small>` : ''}</div>
          <span class="hub-count ${c.tone}">${esc(c.text)}</span>
        </div>
        <div class="hub-facts">
          <span>📅 ${esc(range(next, true))}</span>
          ${next.cpm ? `<span>💶 ${esc(K.CPM_LABEL[next.cpm])}</span>` : ''}
          ${next.promiseBy ? `<span>📦 Last order for delivery: <b>${esc(fmtDay(next.promiseBy.date))}</b></span>` : ''}
          <span>✅ ${next.tasks.length - open.length} of ${next.tasks.length} steps done</span>
        </div>
        ${next.note ? `<p class="cal-note" style="margin-top:10px">${esc(next.note)}</p>` : ''}
        <div class="hub-actions"><button class="hub-btn primary" data-open-event="${esc(next.key)}">Open checklist &amp; starter texts</button></div>
      </div>`;
    }

    const dueRows = due.slice(0, 6).map(d => {
      const lab = dueLabel(d.task, d.event, today);
      return `<li class="hub-row">
        <input type="checkbox" class="hub-tick" data-task="${esc(d.task.key)}" aria-label="Mark done: ${esc(d.task.title)}" style="width:22px;height:22px;accent-color:var(--accent-primary);cursor:pointer">
        <div class="hub-row-main"><div class="hub-row-title">${esc(d.task.title)}</div>
        <div class="hub-row-sub">${esc(d.event.name)} · <span class="ct-due ${lab.tone}">${esc(lab.text)}</span></div></div></li>`;
    }).join('');
    const dueCard = `
      <div class="hub-card">
        <h3>Dates to prepare for <span class="hub-sub">· Termine vorbereiten</span></h3>
        ${due.length ? `<ul class="hub-rows">${dueRows}</ul>
          ${due.length > 6 ? `<p class="hub-sub" style="margin-top:8px">${due.length - 6} more in the calendar.</p>` : ''}`
          : '<div class="hub-empty" style="margin-top:10px">Nothing is due in the next 7 days. The calendar shows what is coming.</div>'}
        <div class="hub-actions"><button class="hub-btn" data-go="calendar">Open the calendar</button></div>
      </div>`;

    let glance = '';
    if (live && campaigns.length) {
      const VE = window.VerdictEngine;
      const rows = campaigns.map(c => {
        const v = c.verdict || {};
        const label = VE && VE.productLabel ? VE.productLabel(c.name) : c.name;
        return `<li class="hub-row"><div class="hub-row-main"><div class="hub-row-title">${esc(label)}</div>
          <div class="hub-row-sub">${VERDICT_ICON[v.code] || ''} ${esc(v.headline || '')}</div></div>
          <button class="hub-link" data-open-campaign="${esc(c.id)}">Open</button></li>`;
      }).join('');
      glance = `<div class="hub-card"><h3>Campaigns at a glance <span class="hub-sub">· Kampagnen im Überblick</span></h3><ul class="hub-rows">${rows}</ul></div>`;
    } else if (!live) {
      glance = `<div class="hub-card"><h3>Campaigns <span class="hub-sub">· Kampagnen</span></h3>
        <div class="hub-empty" style="margin-top:10px">This page is showing demo numbers. Connect live data under “Data sources” and the campaigns and tonight’s plan appear here.</div></div>`;
    }

    host.innerHTML = `
      <div>
        <h2 class="hub-title">${esc(fmtLong(today))}<small>${esc(fmtLongDE(today))}</small></h2>
        <p class="hub-lede">${live ? `Live data${sync ? ` · updated ${esc(sync)}` : ''}. ` : 'Demo numbers. '}Start here: what needs you tonight, which date is coming, and which campaign to open.</p>
      </div>
      ${tiles}
      ${hero}
      ${dueCard}
      ${glance}`;
  }

  /* -------------------------------------------------------- Calendar page -- */
  function eventMatches(ev) {
    if (M.filter !== 'all') {
      if (M.filter === 'custom') { if (!ev.isCustom) return false; }
      else if (ev.kind !== M.filter) return false;
    }
    if (M.costOnly && !ev.cpm) return false;
    return true;
  }

  function taskRow(t, ev, today) {
    const lab = dueLabel(t, ev, today);
    return `<label class="cal-task ${t.done ? 'is-done' : ''}" data-task-row="${esc(t.key)}">
      <input type="checkbox" data-task="${esc(t.key)}" ${t.done ? 'checked' : ''}>
      <span class="ct-main">
        <span class="ct-title">${esc(t.title)}</span>
        <span class="ct-meta"><span class="ct-due ${lab.tone}">${esc(lab.text)}</span><span class="tag">${esc(AREA[t.area] || t.area)}</span></span>
        <span class="ct-detail">${esc(t.detail)}</span>
      </span></label>`;
  }

  function startersHTML(ev) {
    const list = K.starters(ev, { discount: M.discount });
    if (!list.length) return '';
    return `<div class="cs" data-starters="${esc(ev.key)}">
      <div class="cs-head"><strong>Starter texts <span class="hub-sub">· Textvorlagen</span></strong>
        ${ev.kind === 'sale' ? `<label class="hub-sub">Discount <input class="cs-disc" inputmode="text" placeholder="e.g. 20%" maxlength="20" value="${esc(M.discount)}" aria-label="Discount, for example 20%"></label>` : ''}</div>
      <p class="hub-sub" style="margin:0">${esc(K.STARTER_NOTE)}</p>
      ${list.map(s => `<div class="cs-row" data-st="${esc(s.id)}">
        <div class="cs-label"><b>${esc(s.label)}</b><span>${esc(s.where)}</span></div>
        <div class="cs-lines">
          <div class="cs-line de"><span class="lang">DE</span><span class="txt">${esc(s.de)}</span><button class="cs-copy" data-copy="de" aria-label="Copy German ${esc(s.label)}">Copy</button></div>
          <div class="cs-line en"><span class="lang">EN</span><span class="txt">${esc(s.en)}</span><button class="cs-copy" data-copy="en" aria-label="Copy English ${esc(s.label)}">Copy</button></div>
        </div></div>`).join('')}
    </div>`;
  }

  function eventHTML(ev, today, openByDefault) {
    const c = countdown(ev, today);
    const past = c.tone === 'past';
    const done = ev.tasks.filter(t => t.done).length;
    const isOpen = M.open.has(ev.key) || (openByDefault && !M.closed.has(ev.key));
    const d = K.parse(ev.start);
    const day = d.getUTCDate(), mon = d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
    const kindLabel = ev.isCustom ? 'My date' : K.KIND_LABEL[ev.kind] || ev.kind;
    const conf = CONF[ev.conf] || CONF.fixed;
    return `<details class="cal-ev ${past ? 'is-past' : ''} ${c.tone === 'now' ? 'is-now' : ''}" data-ev="${esc(ev.key)}" ${isOpen ? 'open' : ''}>
      <summary>
        <div class="cal-date"><b>${day}</b><span>${esc(mon)}</span></div>
        <div class="cal-main">
          <div class="cal-name">${esc(ev.name)}${ev.de && ev.de !== ev.name ? `<small>${esc(ev.de)}</small>` : ''}</div>
          <div class="cal-meta">
            <span>${esc(range(ev, true))}${ev.days > 1 ? ` · ${plural(ev.days, 'day')}` : ''}</span>
            <span class="tag k-${esc(ev.kind)}">${esc(kindLabel)}</span>
            ${ev.cpm ? `<span class="tag cpm-${esc(ev.cpm)}">${esc(K.CPM_LABEL[ev.cpm])}</span>` : ''}
            <span class="tag" title="${esc(conf[1])}">${esc(conf[0])}</span>
            ${ev.tasks.length ? `<span class="cal-prog">${done}/${ev.tasks.length} steps</span>` : ''}
          </div>
        </div>
        <span class="cal-when ${c.tone}">${esc(c.text)}</span>
      </summary>
      <div class="cal-body">
        ${ev.note ? `<p class="cal-note">${esc(ev.note)}</p>` : ''}
        ${ev.promiseBy ? `<div class="cal-orderby">📦 <b>Last order for delivery: ${esc(fmtDay(ev.promiseBy.date, true))}.</b> That is ${plural(ev.promiseBy.days, 'day')} before ${esc(fmtShort(ev.start))} (${M.ship.handling} to ship + ${M.ship.transitWorst} worst-case transit + ${M.ship.buffer} spare). After that date, stop promising it will arrive in time.</div>` : ''}
        ${ev.cpm ? `<p class="cal-note">💶 <b>${esc(K.CPM_LABEL[ev.cpm])}</b> from ${esc(fmtShort(ev.cpmFrom))}. Judge campaigns by orders and ROAS against break-even, not by CPM alone.</p>` : ''}
        ${ev.tasks.length ? `<div class="cal-tasks" role="group" aria-label="Checklist for ${esc(ev.name)}">${ev.tasks.map(t => taskRow(t, ev, today)).join('')}</div>` : '<p class="hub-sub">No steps for this date. It is here so you know it exists.</p>'}
        ${startersHTML(ev)}
        ${ev.isCustom ? `<div><button class="hub-btn danger" data-del="${esc(ev.id)}">Delete this date</button></div>` : ''}
      </div></details>`;
  }

  function renderCalendar() {
    const host = $('#hub-calendar');
    if (!host) return;
    const today = M.today;
    M.index = {};
    let events, body = '';
    if (M.view === '90') {
      const horizon = K.iso(K.add(K.parse(today), 90));
      events = buildEvents(today, 4).filter(e => e.start <= horizon || K.isActive(e, today));
    } else {
      const monthStart = today.slice(0, 8) + '01';
      const lastDay = K.iso(K.add(K.mk(+today.slice(0, 4), +today.slice(5, 7) + 12, 1), -1));
      events = buildEvents(monthStart, 12, true).filter(e => e.end >= monthStart && e.start <= lastDay);
    }
    events.forEach(e => { M.index[e.key] = e; });
    const shown = events.filter(eventMatches);
    if (!shown.length) {
      body = `<div class="hub-empty">Nothing matches this filter${M.view === '90' ? ' in the next 90 days' : ''}. Try “All”${M.costOnly ? ' or untick “only dates that change ad costs”' : ''}.</div>`;
    } else if (M.view === '90') {
      body = `<div class="cal-list">${shown.map(e => eventHTML(e, today, K.diffDays(e.start, today) <= 21)).join('')}</div>`;
    } else {
      // Every month gets a heading so the year reads as a year; a month where nothing new starts says so.
      const first = today.slice(0, 8) + '01';
      const filtered = M.filter !== 'all' || M.costOnly;
      const parts = [];
      for (let k = 0; k < 12; k++) {
        const ms = K.iso(K.mk(+first.slice(0, 4), +first.slice(5, 7) + k, 1));
        const me = K.iso(K.add(K.mk(+first.slice(0, 4), +first.slice(5, 7) + k + 1, 1), -1));
        const starting = shown.filter(e => (k === 0 ? e.start <= me : e.start >= ms && e.start <= me));
        const running = k === 0 ? [] : shown.filter(e => e.start < ms && e.end >= ms);
        if (!starting.length && filtered) continue;
        parts.push(`<h3 class="cal-month">${esc(monthName(ms))}</h3>`);
        if (starting.length) parts.push(starting.map(e => eventHTML(e, today, false)).join(''));
        else parts.push(`<p class="hub-sub" style="margin:0 0 4px">No new dates start this month.${running.length ? ' Still running: ' + esc(running.map(e => e.name).join(', ')) + '.' : ''}</p>`);
      }
      body = parts.length ? `<div class="cal-list">${parts.join('')}</div>` : '<div class="hub-empty">Nothing matches this filter in the next 12 months.</div>';
    }

    const xmasYear = today <= `${today.slice(0, 4)}-12-24` ? today.slice(0, 4) : String(+today.slice(0, 4) + 1);
    const ex = K.promiseBy(`${xmasYear}-12-24`, M.ship);
    const shipTotal = M.ship.handling + M.ship.transitWorst + M.ship.buffer;

    host.innerHTML = `
      <div>
        <h2 class="hub-title">Calendar<small>Kalender</small></h2>
        <p class="hub-lede">The dates that change ad costs and demand, and what to do before each one. Open a date to see its checklist and ready-to-adapt German texts. Ticks and your own dates are saved in this browser.</p>
      </div>
      <div class="hub-card">
        <div class="cal-bar">
          <div class="cal-seg" role="group" aria-label="Range">
            <button data-view="90" aria-pressed="${M.view === '90'}">Next 90 days</button>
            <button data-view="year" aria-pressed="${M.view === 'year'}">Whole year</button>
          </div>
          <div class="cal-chips" role="group" aria-label="Type of date">${KIND_FILTERS.map(f => `<button class="hub-chip" data-filter="${f.id}" aria-pressed="${M.filter === f.id}">${f.label}</button>`).join('')}</div>
          <label class="cal-check"><input type="checkbox" id="cal-cost" ${M.costOnly ? 'checked' : ''}> Only dates that change ad costs</label>
        </div>
        <div class="cal-legend" style="margin-top:12px"><span><span class="tag">Fixed date</span> same day every year</span><span><span class="tag">Calculated</span> exact date worked out by rule</span><span><span class="tag">Typical pattern</span> no exact date, check your own numbers</span></div>
      </div>
      ${body}
      <div class="cal-side">
        <div class="hub-card">
          <h3>Shipping promise <span class="hub-sub">· Lieferzusage</span></h3>
          <p class="hub-sub">Used to work out the “last order for delivery” date of gift occasions.</p>
          <div class="hub-form">
            <div class="three">
              <label>Days to ship<input type="number" min="0" max="30" id="ship-handling" value="${M.ship.handling}"></label>
              <label>Worst-case transit<input type="number" min="0" max="60" id="ship-transit" value="${M.ship.transitWorst}"></label>
              <label>Spare days<input type="number" min="0" max="30" id="ship-buffer" value="${M.ship.buffer}"></label>
            </div>
            <div class="hub-empty">${M.ship.handling} + ${M.ship.transitWorst} + ${M.ship.buffer} = <b>${shipTotal} days</b>. For Christmas Eve ${esc(xmasYear)} the last order is <b>${esc(fmtDay(ex.date, true))}</b>.</div>
            <div><button class="hub-btn" id="ship-reset">Back to 2 + 15 + 3</button></div>
          </div>
        </div>
        <div class="hub-card">
          <h3>Add my own date <span class="hub-sub">· Eigener Termin</span></h3>
          <form class="hub-form" id="cal-add" novalidate>
            <label>Name<input id="add-name" maxlength="80" placeholder="e.g. Brand anniversary sale" required></label>
            <div class="two">
              <label>Starts<input type="date" id="add-date" required></label>
              <label>Ends (optional)<input type="date" id="add-end"></label>
            </div>
            <div class="two">
              <label>Type<select id="add-kind"><option value="sale">Sale</option><option value="gift">Gift date</option><option value="holiday">Holiday</option><option value="occasion">Other occasion</option></select></label>
              <label>Ad cost effect<select id="add-cpm"><option value="">None known</option><option value="high">Usually high</option><option value="up">May rise</option><option value="dip">Often lower</option></select></label>
            </div>
            <label>Note (optional)<input id="add-note" maxlength="300"></label>
            <div class="hub-msg" id="add-msg" role="status"></div>
            <div><button class="hub-btn primary" type="submit">Add to calendar</button></div>
          </form>
        </div>
        <div class="hub-card">
          <h3>Back up &amp; restore <span class="hub-sub">· Sichern</span></h3>
          <p class="hub-sub">Your ticks and dates live in this browser only. Copy the backup somewhere safe, or paste one to restore it on another computer.</p>
          <div class="hub-form">
            <textarea id="bk-text" spellcheck="false" aria-label="Backup text"></textarea>
            <div class="hub-actions" style="margin-top:0"><button class="hub-btn" id="bk-show">Show my backup</button><button class="hub-btn" id="bk-copy">Copy</button><button class="hub-btn primary" id="bk-restore">Restore from text</button></div>
            <div class="hub-msg" id="bk-msg" role="status"></div>
          </div>
        </div>
      </div>`;
  }

  /* -------------------------------------------------- calendar interactions -- */
  M.closed = new Set();

  function saveAll() { S.set('done', M.done); S.set('custom', M.custom); S.set('ship', M.ship); S.set('discount', M.discount); }

  function toggleTask(key, checked) {
    const hadFocus = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.task === key;
    const wasToday = !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('#hub-today'));
    if (checked) M.done[key] = true; else delete M.done[key];
    saveAll();
    // update every copy of this task in place so open sections stay open
    $$(`[data-task="${CSS.escape(key)}"]`).forEach(i => { if (i.checked !== checked) i.checked = checked; });
    $$(`[data-task-row="${CSS.escape(key)}"]`).forEach(r => r.classList.toggle('is-done', checked));
    updateBadges();
    renderToday();
    // progress counters and the "due" wording come from the data, so refresh the calendar quietly
    if (M.tab === 'calendar') renderCalendar();
    if (hadFocus) {
      const again = $(`${wasToday ? '#hub-today' : '#hub-calendar'} [data-task="${CSS.escape(key)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }

  function copyText(text, btn) {
    const ok = () => { const o = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = o; }, 1400); };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) { btn.textContent = 'Select & copy'; }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  }

  function refreshStarters() {
    $$('[data-starters]').forEach(box => {
      const ev = M.index[box.dataset.starters];
      if (!ev) return;
      const list = K.starters(ev, { discount: M.discount });
      list.forEach(s => {
        const row = box.querySelector(`[data-st="${CSS.escape(s.id)}"]`);
        if (!row) return;
        const de = row.querySelector('.cs-line.de .txt'), en = row.querySelector('.cs-line.en .txt');
        if (de) de.textContent = s.de;
        if (en) en.textContent = s.en;
      });
      const inp = box.querySelector('.cs-disc');
      if (inp && inp !== document.activeElement) inp.value = M.discount;
    });
  }

  function addCustom(e) {
    e.preventDefault();
    const msg = $('#add-msg');
    const say = (t, tone) => { msg.textContent = t; msg.className = 'hub-msg ' + (tone || ''); };
    const name = $('#add-name').value.trim(), date = $('#add-date').value, end = $('#add-end').value;
    if (!name) return say('Give the date a name.', 'bad');
    if (!validISO(date)) return say('Pick the day it starts.', 'bad');
    if (end && (!validISO(end) || end < date)) return say('The end day cannot be before the start day.', 'bad');
    M.custom.push(cleanCustom([{ id: 'c_' + Date.now().toString(36), name, date, end, kind: $('#add-kind').value, cpm: $('#add-cpm').value || null, note: $('#add-note').value }])[0]);
    saveAll();
    renderCalendar(); renderToday(); updateBadges();
    const m = $('#add-msg'); if (m) { m.textContent = `Added “${name}”.`; m.className = 'hub-msg good'; }
  }

  function backupObject() { return { v: 1, done: M.done, custom: M.custom, ship: M.ship, discount: M.discount }; }

  function restore(text) {
    let o;
    try { o = JSON.parse(text); } catch (e) { return 'That is not a backup. Paste the whole text from “Show my backup”.'; }
    if (!o || typeof o !== 'object' || o.v !== 1) return 'That is not a backup from this calendar.';
    const done = {};
    if (o.done && typeof o.done === 'object') Object.keys(o.done).forEach(k => { if (o.done[k] === true && /^[\w:-]+$/.test(k)) done[k] = true; });
    M.done = done; M.custom = cleanCustom(o.custom); M.ship = cleanShip(o.ship); M.discount = String(o.discount || '').slice(0, 20);
    saveAll();
    return null;
  }

  function setupCalendarEvents() {
    const host = $('#hub-calendar');
    if (!host) return;
    host.addEventListener('click', e => {
      const t = e.target;
      const v = t.closest('[data-view]'); if (v) { M.view = v.dataset.view; S.set('view', M.view); renderCalendar(); return; }
      const f = t.closest('[data-filter]'); if (f) { M.filter = f.dataset.filter; S.set('filter', M.filter); renderCalendar(); return; }
      const cp = t.closest('[data-copy]');
      if (cp) {
        const line = cp.closest('.cs-line');
        copyText(line.querySelector('.txt').textContent, cp);
        return;
      }
      const del = t.closest('[data-del]');
      if (del) { M.custom = M.custom.filter(c => c.id !== del.dataset.del); saveAll(); renderCalendar(); renderToday(); updateBadges(); return; }
      if (t.id === 'ship-reset') { M.ship = cleanShip(null); saveAll(); renderCalendar(); renderToday(); updateBadges(); return; }
      if (t.id === 'bk-show') { $('#bk-text').value = JSON.stringify(backupObject(), null, 1); $('#bk-msg').textContent = ''; return; }
      if (t.id === 'bk-copy') { const ta = $('#bk-text'); if (!ta.value) ta.value = JSON.stringify(backupObject(), null, 1); copyText(ta.value, t); return; }
      if (t.id === 'bk-restore') {
        const err = restore($('#bk-text').value);
        if (err) { const m = $('#bk-msg'); m.textContent = err; m.className = 'hub-msg bad'; return; }
        renderCalendar(); renderToday(); updateBadges();
        const m = $('#bk-msg'); if (m) { m.textContent = 'Restored.'; m.className = 'hub-msg good'; }
      }
    });
    host.addEventListener('change', e => {
      const t = e.target;
      if (t.matches('input[data-task]')) return toggleTask(t.dataset.task, t.checked);
      if (t.id === 'cal-cost') { M.costOnly = t.checked; S.set('costOnly', M.costOnly); renderCalendar(); return; }
      if (t.id === 'ship-handling' || t.id === 'ship-transit' || t.id === 'ship-buffer') {
        M.ship = cleanShip({ handling: $('#ship-handling').value, transitWorst: $('#ship-transit').value, buffer: $('#ship-buffer').value });
        saveAll(); renderCalendar(); renderToday(); updateBadges();
      }
    });
    host.addEventListener('input', e => {
      if (e.target.classList && e.target.classList.contains('cs-disc')) {
        M.discount = e.target.value.slice(0, 20);
        S.set('discount', M.discount);
        refreshStarters();
      }
    });
    host.addEventListener('submit', e => { if (e.target.id === 'cal-add') addCustom(e); });
    host.addEventListener('toggle', e => {
      const d = e.target;
      if (!d.matches || !d.matches('details.cal-ev')) return;
      if (d.open) { M.open.add(d.dataset.ev); M.closed.delete(d.dataset.ev); } else { M.open.delete(d.dataset.ev); M.closed.add(d.dataset.ev); }
    }, true);
  }

  function setupTodayEvents() {
    const host = $('#hub-today');
    if (!host) return;
    host.addEventListener('click', e => {
      const go = e.target.closest('[data-go]');
      if (go) {
        if (go.dataset.go === 'today-plan') { const p = $('#plan-panel'); if (p) p.scrollIntoView({ behavior: 'auto', block: 'start' }); return; }
        setTab(go.dataset.go); return;
      }
      const oe = e.target.closest('[data-open-event]');
      if (oe) {
        M.open.add(oe.dataset.openEvent); M.closed.delete(oe.dataset.openEvent);
        setTab('calendar', { silent: true });
        const el = $(`details[data-ev="${CSS.escape(oe.dataset.openEvent)}"]`);
        if (el) { el.open = true; el.scrollIntoView({ block: 'start' }); }
        return;
      }
      const oc = e.target.closest('[data-open-campaign]');
      if (oc) {
        setTab('campaigns', { silent: true });
        const card = $(`.verdict-card[data-cid="${CSS.escape(oc.dataset.openCampaign)}"]`);
        if (card) card.scrollIntoView({ block: 'start' });
      }
    });
    host.addEventListener('change', e => {
      if (e.target.matches('input.hub-tick')) toggleTask(e.target.dataset.task, e.target.checked);
    });
  }

  /* ------------------------------------------------------------------ API -- */
  function refresh(ctx) {
    if (ctx) M.ctx = ctx;
    M.today = todayISO();
    renderToday();
    if (M.tab === 'calendar') renderCalendar();
    updateBadges();
    applyVisibility();
  }

  function init() {
    injectStyle();
    M.today = todayISO();
    setupTabs();
    setupCalendarEvents();
    setupTodayEvents();
    const fromHash = location.hash.replace('#', '');
    const start = TABS.some(t => t.id === fromHash) ? fromHash : (TABS.some(t => t.id === S.get('tab', 'today')) ? S.get('tab', 'today') : 'today');
    M.tab = start;
    renderToday();
    renderCalendar();
    updateBadges();
    applyVisibility();
    const main = $('main');
    if (main && window.MutationObserver) new MutationObserver(() => applyVisibility()).observe(main, { childList: true });
    // roll the date over on its own if the page is left open past midnight
    setInterval(() => { const t = todayISO(); if (t !== M.today) refresh(); }, 5 * 60 * 1000);
  }

  window.CgoHub = { init, refresh, setTab, _model: M };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
