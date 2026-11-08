/* ==========================================================================
   CGO Media Buyer — Verdict Dashboard
   App layer: settings, Meta Graph API, Shopify truth, rendering. The decision
   logic lives in rules.js (VerdictEngine) and is unit-tested separately.

   REVENUE OF RECORD (8 Nov 2026)
   Meta's per-campaign revenue is not trustworthy on this account. Shopify is.
   Revenue now arrives from the CGO Truth Worker, is matched onto campaigns by
   product name (truth.js), and drives every verdict. Where a campaign has no
   Shopify match, the card falls back to Meta, says so, and scaling is locked.
   ========================================================================== */

const VE = window.VerdictEngine;
const TR = window.Truth;
const CD = window.CreativeDesk;

/* ---------------------------------------------------------------- state -- */
const State = {
  campaigns: [],          // normalized campaign objects
  ads: [],                // ad rows for the 12-column table
  currency: 'EUR',
  window: null,           // 'morning' | 'evening' | 'midnight' (null = auto)
  econ: null,
  charts: {},
  sort: { column: 'Score (1-10)', direction: 'desc' },
  live: false,
  lastSync: 0,
  range: null,          // {since,until} as YYYY-MM-DD when a custom span is picked
  dateManual: false,    // the user chose the window; stop auto-rolling it
  lpvEstimated: false,
  accountTz: null,      // ad account timezone — the only clock the daily rules mean anything against
  source: 'demo',       // 'api' | 'csv' | 'demo'
  truth: null,          // Worker payload for the judged window
  truthStatus: null,    // { state: 'off'|'ok'|'error', message }
  truthMatch: null,     // output of Truth.match
  truthSyncedAt: 0,     // when the Shopify pull last succeeded
  atcBroken: false      // the ATC event does not fire on these funnels
};

const LS = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
  json: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } }
};

const CURRENCY_SYMBOLS = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF ', PLN: 'zł' };
const sym = () => CURRENCY_SYMBOLS[State.currency] || '€';
const fmtMoney = (v, dp = 2) => sym() + (Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtInt = (v) => (Number(v) || 0).toLocaleString();
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------------------------------------------------- copy grader -- */
const EMOTIONAL_TRIGGERS_LIST = ['free', 'gratis', 'now', 'limited', 'exclusive', 'unlock', 'stop', 'save',
  'discount', 'secret', 'guaranteed', 'proven', 'easy', 'best', 'today', 'sale', "don't miss", 'discover',
  'instant', 'finally', 'endlich', 'sofort', 'ohne'];
const CTA_VERBS_LIST = ['shop', 'buy', 'get', 'claim', 'download', 'learn', 'try', 'join', 'start', 'grab',
  'order', 'sichern', 'entdecken', 'holen'];

/* ========================================================================== *
 *  BOOT
 * ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  injectStyles();
  initTheme();
  migrateAccountState();   // must run before anything reads account-scoped keys
  renderAccountTabs();
  setupAccountTabs();
  loadEconomics();
  setupModals();
  setupTruthSettings();
  setupWindowTabs();
  setupDateBar();
  setupTableControls();
  setupGrader();
  loadData();
  startAutoRefresh();
});

/* Keeps the page current without anyone touching it: re-pulls Meta every 15
   minutes when live, and re-renders anyway so the check window rolls over on
   its own at 09:00 / 15:00 / 23:30. */
function startAutoRefresh() {
  setInterval(() => {
    if (document.hidden) return;
    if (State.live) syncMetaAPI();
    else if (State.campaigns.length) renderAll();
  }, 15 * 60 * 1000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && State.live && Date.now() - State.lastSync > 10 * 60 * 1000) syncMetaAPI();
  });
}

function initTheme() {
  const t = LS.get('theme', 'dark');
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('theme-toggle').innerHTML = t === 'light' ? '🌙' : '☀️';
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    LS.set('theme', next);
    document.getElementById('theme-toggle').innerHTML = next === 'light' ? '🌙' : '☀️';
    renderCharts();
  });
}

/* The day being judged has closed. Several warnings are only true once it has
   — a campaign at 40% of budget at lunchtime is pacing normally, not failing
   to fill the auction. */
function dayIsOver() {
  /* A custom span that ends before today is finished by definition, whatever
     time it is now — reviewing last Tuesday must not be treated as a
     part-day. */
  if (State.range) return State.range.until < todayInAccountTz(0);
  const preset = LS.get('meta_date_preset', 'today');
  return preset !== 'today' || activeWindow() === 'midnight';
}

/* Today's date on the AD ACCOUNT's clock. Reading the laptop clock instead
   silently shifts the window by the Cairo/Berlin offset. */
function todayInAccountTz(offsetDays = 0) {
  const tz = State.accountTz;
  const d = new Date(Date.now() + offsetDays * 86400000);
  if (!tz) return d.toISOString().slice(0, 10);
  try { return d.toLocaleDateString('en-CA', { timeZone: tz }); }
  catch (e) { return d.toISOString().slice(0, 10); }
}

/* ========================================================================== *
 *  UNIT ECONOMICS
 * ========================================================================== */
function loadEconomics() {
  const saved = acctJson('cgo_econ', { price: 29.95, cogs: 7, shipping: 2, feePct: 3 });
  ['price', 'cogs', 'shipping', 'fees'].forEach(k => {
    const el = document.getElementById('econ-' + k);
    if (el) el.value = saved[k === 'fees' ? 'feePct' : k];
  });
  State.econ = VE.economics(saved);
}

function readEconomicsInputs() {
  return {
    price: parseFloat(document.getElementById('econ-price').value) || 0,
    cogs: parseFloat(document.getElementById('econ-cogs').value) || 0,
    shipping: parseFloat(document.getElementById('econ-shipping').value) || 0,
    feePct: parseFloat(document.getElementById('econ-fees').value) || 0
  };
}

function renderEconomicsPreview() {
  const e = VE.economics(readEconomicsInputs());
  const box = document.getElementById('econ-result');
  if (!e.valid) {
    box.className = 'econ-result bad';
    box.innerHTML = `<strong>These numbers do not make money.</strong> Costs are at or above the selling price, so there is no ROAS that breaks even.`;
    return;
  }
  box.className = 'econ-result';
  box.innerHTML = `
    <div class="econ-headline">
      <div><span class="econ-big">${e.ber.toFixed(2)}</span><span class="econ-cap">Break-even ROAS</span></div>
      <div><span class="econ-big">${e.grossMarginPct}%</span><span class="econ-cap">Gross margin</span></div>
      <div><span class="econ-big">${fmtMoney(e.contribution)}</span><span class="econ-cap">Contribution per order before ads</span></div>
    </div>
    <p class="econ-note">
      Name campaigns <code>Product | ${e.ber.toFixed(2)} | ${e.grossMarginPct}</code> and every verdict reads it automatically.
      This is contribution, not profit: it deducts cost, shipping and fees, and nothing else.
    </p>`;
}

/* ========================================================================== *
 *  MODALS + SETTINGS
 * ========================================================================== */
function setupModals() {
  const open = (id) => document.getElementById(id).classList.add('show');
  const close = (id) => document.getElementById(id).classList.remove('show');

  document.getElementById('settings-toggle').addEventListener('click', () => open('settings-modal'));
  document.getElementById('econ-toggle').addEventListener('click', () => { renderEconomicsPreview(); open('econ-modal'); });
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => close(b.dataset.close)));
  document.querySelectorAll('.modal-overlay').forEach(m =>
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); }));

  ['econ-price', 'econ-cogs', 'econ-shipping', 'econ-fees'].forEach(id =>
    document.getElementById(id).addEventListener('input', renderEconomicsPreview));

  document.getElementById('btn-save-econ').addEventListener('click', () => {
    const inputs = readEconomicsInputs();
    acctSet('cgo_econ', JSON.stringify(inputs));
    State.econ = VE.economics(inputs);
    close('econ-modal');
    renderAll();
  });

  // Meta API settings
  const accEl = document.getElementById('meta-account-id');
  const tokEl = document.getElementById('meta-access-token');
  const dateEl = document.getElementById('meta-date-preset');
  accEl.value = LS.get('meta_account_ids', '') || LS.get('meta_account_id', '');
  tokEl.value = LS.get('meta_access_token', '');
  dateEl.value = LS.get('meta_date_preset', 'today');

  document.getElementById('btn-save-settings').addEventListener('click', () => {
    const acc = accEl.value.trim(), tok = tokEl.value.trim();
    if (!acc || !tok) { showModal('Missing details', 'Both the Ad Account ID and the Access Token are needed.'); return; }
    LS.set('meta_account_ids', acc);
    LS.del('meta_account_id');
    /* Anything typed here that is not already a tab becomes one, so the box
       and the tab bar can never disagree about which accounts exist. */
    (() => {
      const reg = accountRegistry();
      acc.split(/[\s,;]+/).filter(Boolean).map(normAcc).forEach(id => {
        if (!reg.some(a => a.id === id)) reg.push({ id, label: shortLabel(id) });
      });
      LS.set('cgo_accounts', JSON.stringify(reg));
      renderAccountTabs();
    })();
    LS.set('meta_access_token', tok);
    LS.set('meta_date_preset', dateEl.value);
    saveTruthSettings();
    close('settings-modal');
    syncMetaAPI();
  });

  document.getElementById('btn-disconnect-settings').addEventListener('click', () => {
    LS.del('meta_account_ids'); LS.del('meta_account_id'); LS.del('meta_access_token');
    accEl.value = ''; tokEl.value = '';
    close('settings-modal');
    setApiStatus('offline');
    loadData();
  });

  document.getElementById('api-sync-btn').addEventListener('click', syncMetaAPI);
  document.getElementById('csv-file-input').addEventListener('change', handleCsvUpload);
}

/* The Truth Worker fields are added from JS rather than the HTML, so the
   dashboard keeps working if an older index.html is still deployed. */
function setupTruthSettings() {
  const body = document.querySelector('#settings-modal .modal-body');
  if (!body || document.getElementById('truth-worker-url')) return;

  const block = document.createElement('div');
  block.className = 'truth-settings';
  block.innerHTML = `
    <h4>Shopify truth <span class="truth-pill">revenue of record</span></h4>
    <p class="truth-help">
      Meta's per-campaign revenue has been wrong by up to €869 on this account. These two fields
      point the dashboard at your Truth Worker so every verdict runs on the Shopify order book
      instead. Both values stay in this browser.
    </p>
    <label>Worker URL
      <input type="text" id="truth-worker-url" placeholder="https://cgo-truth.YOUR-SUBDOMAIN.workers.dev" autocomplete="off" spellcheck="false">
    </label>
    <label>Dashboard key
      <input type="password" id="truth-dash-key" placeholder="the DASH_KEY secret you set in Cloudflare" autocomplete="off">
    </label>
    <div class="truth-actions">
      <button class="btn-mini" id="btn-test-truth">Test connection</button>
      <button class="btn-mini" id="btn-edit-map">Product → campaign map</button>
    </div>
    <div id="truth-test-result" class="truth-test"></div>`;
  body.appendChild(block);

  document.getElementById('truth-worker-url').value = LS.get('truth_worker_url', '');
  document.getElementById('truth-dash-key').value = LS.get('truth_dash_key', '');

  document.getElementById('btn-test-truth').addEventListener('click', async () => {
    saveTruthSettings();
    const box = document.getElementById('truth-test-result');
    box.className = 'truth-test';
    box.innerText = 'Asking the Worker…';
    const res = await TR.fetchTruth({
      workerUrl: LS.get('truth_worker_url', ''),
      dashKey: LS.get('truth_dash_key', ''),
      preset: LS.get('meta_date_preset', 'today'),
      tz: State.accountTz || 'Europe/Berlin'
    });
    if (res.ok) {
      const d = res.data;
      const lines = Object.entries(d.byProduct || {})
        .sort((a, b) => b[1].net - a[1].net)
        .map(([t, p]) => `${esc(t)} — ${fmtMoney(p.net)} (${p.orders})`);
      box.className = 'truth-test ok';
      box.innerHTML = `<strong>Connected.</strong> ${d.orders} orders, ${fmtMoney(d.net)} net` +
        (d.refunded ? `, ${fmtMoney(d.refunded)} refunded` : '') +
        `<div class="truth-test-list">${lines.join('<br>') || 'No orders in this window.'}</div>`;
    } else {
      box.className = 'truth-test bad';
      box.innerHTML = `<strong>Not connected.</strong> ${esc(res.error || res.reason)}`;
    }
  });

  document.getElementById('btn-edit-map').addEventListener('click', editProductMap);
}

function saveTruthSettings() {
  const u = document.getElementById('truth-worker-url');
  const k = document.getElementById('truth-dash-key');
  if (u) LS.set('truth_worker_url', u.value.trim());
  if (k) LS.set('truth_dash_key', k.value.trim());
}

function setApiStatus(status, label) {
  const badge = document.getElementById('api-status-badge');
  const btn = document.getElementById('api-sync-btn');
  badge.className = 'api-status-badge ' + status;
  badge.querySelector('.status-text').innerText =
    status === 'online' ? (label || 'Live') : status === 'syncing' ? 'Syncing…' : 'Demo Mode';
  btn.style.display = status === 'offline' ? 'none' : 'inline-flex';
  State.live = status === 'online';
}

/* ========================================================================== *
 *  CHECK WINDOW
 * ========================================================================== */
const WINDOW_META = {
  morning:  { title: '☀️ Morning Check', sub: 'Creative quality · around 11:00' },
  evening:  { title: '🌇 Evening Check', sub: 'Funnel quality · no budget moves' },
  midnight: { title: '🌙 Midnight Check', sub: 'Scale · keep · descale · kill' }
};

/* Every time shown on this dashboard is the ad account's time. Your laptop's
   clock is irrelevant to Meta's advertising day and showing it invites you to
   act on the wrong read window. */
function accountClock(d = new Date()) {
  const tz = State.accountTz;
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && tz !== localTz ? `${t} ${tz.split('/').pop().replace(/_/g, ' ')}` : t;
}

function activeWindow() { return State.window || VE.detectWindow(new Date(), State.accountTz); }

function setupWindowTabs() {
  document.querySelectorAll('.command-tabs .playbook-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      State.window = tab.dataset.window;
      renderAll();
    });
  });
}

function renderCommandBar() {
  const win = activeWindow();
  const meta = WINDOW_META[win];
  const auto = VE.detectWindow(new Date(), State.accountTz);
  document.getElementById('command-title').innerText = meta.title;
  document.getElementById('command-sub').innerText =
    meta.sub + (win === auto ? ' · this is where you are now' : ' · viewing out of hours');

  document.querySelectorAll('.command-tabs .playbook-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.window === win));

  // verdict tally
  const counts = {};
  State.campaigns.forEach(c => { counts[c.verdict.code] = (counts[c.verdict.code] || 0) + 1; });
  const order = ['KILL', 'DESCALE', 'PRICE_DROP', 'SCALE', 'SURF', 'PROVE', 'HOLD', 'MONITOR', 'DIAGNOSE', 'NEEDS_SETUP'];
  const labels = { KILL: 'Kill', DESCALE: 'Descale', PRICE_DROP: 'Price drop', SCALE: 'Scale', SURF: 'Surf',
                   PROVE: 'Prove', HOLD: 'Hold', MONITOR: 'Watch', DIAGNOSE: 'Diagnose', NEEDS_SETUP: 'Setup' };
  const tones = { KILL: 'danger', DESCALE: 'warning', PRICE_DROP: 'warning', SCALE: 'success', SURF: 'success',
                  PROVE: 'success', HOLD: 'neutral', MONITOR: 'neutral', DIAGNOSE: 'neutral', NEEDS_SETUP: 'neutral' };
  document.getElementById('verdict-tally').innerHTML = order
    .filter(k => counts[k])
    .map(k => `<div class="tally tally-${tones[k]}"><span class="tally-num">${counts[k]}</span><span class="tally-label">${labels[k]}</span></div>`)
    .join('') || '<div class="tally tally-neutral"><span class="tally-num">0</span><span class="tally-label">Campaigns</span></div>';
}

/* ========================================================================== *
 *  DATA LOADING
 * ========================================================================== */
function loadData() {
  if (accountIds().length && LS.get('meta_access_token')) { syncMetaAPI(); return; }
  const demo = buildDemoData();
  State.campaigns = demo.campaigns;
  State.ads = demo.ads;
  State.currency = 'EUR';
  State.source = 'demo';
  State.truth = null;
  State.truthStatus = null;
  setApiStatus('offline');
  document.getElementById('brand-sub').innerText = 'Demo data · connect the Meta API for live verdicts';
  renderAll();
}

/* ------------------------------------------------------------ Graph API -- */
const GRAPH_VERSIONS = ['v23.0', 'v21.0', 'v19.0'];

/* Meta retires insight fields between versions (video_3_sec_watched_actions
   is gone, for example). Rather than break the whole sync over one dead
   field, drop whichever field the API names and ask again. */
State.droppedFields = [];

function stripField(fields, name) {
  return String(fields || '')
    .split(',')
    .filter(f => f.trim() !== name)
    .join(',');
}

async function graph(path, params) {
  const token = LS.get('meta_access_token');
  const versions = [...new Set([LS.get('meta_api_version') || GRAPH_VERSIONS[0], ...GRAPH_VERSIONS])];
  let lastErr;

  for (const v of versions) {
    let attemptParams = { ...params };

    for (let retry = 0; retry < 8; retry++) {
      const qs = new URLSearchParams({ ...attemptParams, access_token: token }).toString();
      let body;
      try {
        const res = await fetch(`https://graph.facebook.com/${v}/${path}?${qs}`);
        body = await res.json();
      } catch (e) {
        throw new Error('Could not reach Meta. If the address bar starts with file://, open the dashboard through "Start Dashboard.command" instead.');
      }

      if (body && body.error) {
        const msg = body.error.message || 'Unknown Graph error';

        // A field this API version no longer knows — drop it and retry.
        const dead = msg.match(/\(#100\)\s*([a-zA-Z0-9_]+)\s+is not valid for fields param/i);
        if (dead && attemptParams.fields && attemptParams.fields.includes(dead[1])) {
          if (!State.droppedFields.includes(dead[1])) State.droppedFields.push(dead[1]);
          attemptParams.fields = stripField(attemptParams.fields, dead[1]);
          continue;
        }

        // Wrong API version — step down and start over.
        if (/version|unsupported get request|does not exist/i.test(msg) && v !== versions[versions.length - 1]) {
          lastErr = msg;
          break;
        }
        throw new Error(msg);
      }

      LS.set('meta_api_version', v);
      return body;
    }
  }
  throw new Error(lastErr || 'Graph API unreachable');
}

/* ==========================================================================
   ACCOUNT REGISTRY — one account at a time
   ==========================================================================
   Ban prevention means several small ad accounts, and merging them into one
   picture hides which account is spending the money. Worse, each account
   sells different products, so one set of unit economics cannot describe
   them all: a merged view judges a Main 1 campaign against Chic-Shop's
   margins and returns a wrong verdict that looks perfectly reasonable.
   So the page reads exactly one account, and the header carries a tab per
   account to switch. */
const DEFAULT_ACCOUNTS = [
  { id: 'act_2995536273958154', label: 'Chic-Shop' },
  { id: 'act_1679754109728357', label: 'Main 1' },
  { id: 'act_1563288332017037', label: 'Main 2' }
];

const normAcc = (a) => (String(a).startsWith('act_') ? String(a) : 'act_' + a);
const shortLabel = (id) => 'Account ' + String(id).replace(/^act_/, '').slice(-4);

/* Seeded once from whatever was already connected, so nobody loses the
   account they were reading when this shipped. */
function accountRegistry() {
  let list = null;
  try { list = JSON.parse(LS.get('cgo_accounts', '')); } catch (e) { list = null; }
  if (!Array.isArray(list) || !list.length) {
    list = DEFAULT_ACCOUNTS.slice();
    (LS.get('meta_account_ids', '') || LS.get('meta_account_id', ''))
      .split(/[\s,;]+/).filter(Boolean).map(normAcc)
      .forEach(id => { if (!list.some(a => normAcc(a.id) === id)) list.unshift({ id, label: shortLabel(id) }); });
    LS.set('cgo_accounts', JSON.stringify(list));
  }
  return list.map(a => ({ id: normAcc(a.id), label: a.label || shortLabel(a.id) }));
}

function activeAccount() {
  const reg = accountRegistry();
  return reg.find(a => a.id === LS.get('cgo_active_account', '')) || reg[0];
}

function setActiveAccount(id) {
  if (activeAccount().id === id) return;
  LS.set('cgo_active_account', id);
  State.truth = null;          // another account's order book is not this one's
  State.truthStatus = null;
  State.truthMatch = null;
  loadEconomics();             // this account's margins, not the last one's
  renderAccountTabs();
  loadData();
}

function accountIds() {
  const acct = activeAccount();
  return acct ? [acct.id] : [];
}

/* Margins, break-even overrides and the applied-action log all describe ONE
   account's products, so each key is suffixed with the account id. The first
   time an account is opened, whatever was stored globally is copied in, so
   nothing is lost on upgrade. */
const ACCOUNT_SCOPED = ['cgo_econ', 'cgo_ber_overrides', 'cgo_action_log'];

function acctKey(base, id) { return `${base}::${id || activeAccount().id}`; }

/* The old global value belongs to the account that was connected when it was
   written — the one seeded first in the registry. It is copied, never moved,
   so a downgrade still finds its data where it left it. */
function migrateAccountState() {
  const first = accountRegistry()[0];
  if (!first || LS.get('cgo_scoped_v1', '')) return;
  ACCOUNT_SCOPED.forEach(base => {
    const legacy = LS.get(base, '');
    if (legacy && !LS.get(acctKey(base, first.id), '')) LS.set(acctKey(base, first.id), legacy);
  });
  LS.set('cgo_scoped_v1', '1');
}

const acctJson = (base, dflt) => LS.json(acctKey(base), dflt);
const acctSet = (base, value) => LS.set(acctKey(base), value);

/* Delegated, because the tabs are re-rendered whenever the registry or the
   active account changes. */
function setupAccountTabs() {
  const host = document.getElementById('account-tabs');
  if (!host) return;
  host.addEventListener('click', e => {
    const btn = e.target.closest('.acct-tab');
    if (btn) setActiveAccount(btn.dataset.acct);
  });
}

function renderAccountTabs() {
  const host = document.getElementById('account-tabs');
  if (!host) return;
  const act = activeAccount();
  host.innerHTML = accountRegistry().map(a =>
    `<button class="acct-tab${a.id === act.id ? ' active' : ''}" data-acct="${esc(a.id)}"
             title="${esc(a.id)}">${esc(a.label)}</button>`).join('');

  /* An account nobody has configured yet is being judged against the default
     €29.95 economics. Saying so out loud is the difference between a verdict
     you can trust and one that merely looks confident. */
  const hint = document.getElementById('acct-hint');
  if (!hint) return;
  const configured = !!LS.get(acctKey('cgo_econ', act.id), '');
  hint.innerHTML = configured
    ? 'Reading one account at a time'
    : `<strong>${esc(act.label)}</strong> has no unit economics yet — verdicts use the defaults until you set them`;
  hint.classList.toggle('acct-hint-warn', !configured);
}

/* Meta's `last_14d` and friends END YESTERDAY — today is not in them. So the
   numbers you are judging must come from their own aggregated call for the
   chosen window, and the day-by-day call is used only for history. Deriving
   "today" from the daily rows silently showed yesterday's closed day instead,
   which is the worst kind of wrong: plausible and confident. */
const CAMPAIGN_FIELDS = [
  'campaign_id', 'campaign_name', 'spend', 'impressions', 'reach', 'frequency',
  'clicks', 'inline_link_clicks', 'inline_link_click_ctr', 'cost_per_inline_link_click',
  'cpc', 'cpm', 'ctr', 'actions', 'action_values', 'purchase_roas'
].join(',');

/* The quartile fields are what make a retention curve possible. Without them
   an ad is a single thruplay number and the only creative advice available is
   "make it better". With them, the shape says which second loses the viewer
   and therefore which part of the edit to change. */
const AD_FIELDS = [
  'ad_id', 'ad_name', 'campaign_id', 'campaign_name', 'spend', 'impressions', 'reach', 'frequency',
  'inline_link_clicks', 'inline_link_click_ctr', 'cost_per_inline_link_click',
  'cpc', 'cpm', 'ctr', 'actions', 'action_values', 'purchase_roas',
  'video_play_actions', 'video_thruplay_watched_actions',
  'video_p25_watched_actions', 'video_p50_watched_actions',
  'video_p75_watched_actions', 'video_p100_watched_actions',
  'video_avg_time_watched_actions'
].join(',');

/* Meta accepts either a named preset or an explicit {since,until}. The date
   bar uses the second form so any day or span can be judged, not just the
   handful of presets. */
function windowParams() {
  return State.range
    ? { time_range: JSON.stringify(State.range) }
    : { date_preset: LS.get('meta_date_preset', 'today') };
}

function windowLabel() {
  if (State.range) {
    const { since, until } = State.range;
    const fmt = d => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return since === until ? fmt(since) : `${fmt(since)} – ${fmt(until)}`;
  }
  return LS.get('meta_date_preset', 'today').replace(/_/g, ' ');
}

async function fetchAccount(acc, preset) {
  const win = windowParams();
  const [account, campaigns, adsets, judged, history, adInsights, adsMeta] = await Promise.all([
    graph(acc, { fields: 'name,currency,timezone_name' }),
    graph(`${acc}/campaigns`, { fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,created_time', limit: 200 }),
    graph(`${acc}/adsets`, { fields: 'id,campaign_id,daily_budget,effective_status,learning_stage_info', limit: 300 }),
    // the window being judged, aggregated by Meta — not summed by us
    graph(`${acc}/insights`, Object.assign({ level: 'campaign', fields: CAMPAIGN_FIELDS, limit: 200 }, win)),
    // history for sparklines and streaks (ends yesterday, which is what we want)
    graph(`${acc}/insights`, { level: 'campaign', fields: 'campaign_id,spend,actions,action_values,purchase_roas', date_preset: 'last_30d', time_increment: 1, limit: 800 }),
    graph(`${acc}/insights`, Object.assign({ level: 'ad', fields: AD_FIELDS, limit: 300 }, win)),
    graph(`${acc}/ads`, { fields: 'id,name,campaign_id,effective_status,creative{id,title,body,object_type,video_id,thumbnail_url}', limit: 300 })
  ]);

  /* Video lengths turn the quartiles into timestamps. One batched call for
     every video in the account, and the curve can say "they leave at 7
     seconds" instead of "p25". If it fails, the curve still works in
     percentages — so this never blocks a sync. */
  const videoIds = [...new Set((adsMeta.data || [])
    .map(a => a.creative && a.creative.video_id).filter(Boolean))].slice(0, 50);
  let lengths = {};
  if (videoIds.length) {
    try {
      const res = await graph('', { ids: videoIds.join(','), fields: 'length' });
      Object.entries(res || {}).forEach(([id, v]) => {
        if (v && v.length) lengths[id] = parseFloat(v.length) || 0;
      });
    } catch (e) { /* lengths are a nicety, not a dependency */ }
  }

  const built = buildFromApi({
    campaigns: campaigns.data || [], adsets: adsets.data || [],
    judged: judged.data || [], history: history.data || [],
    adInsights: adInsights.data || [], adsMeta: adsMeta.data || [], preset,
    accountId: acc, accountName: account.name || acc, videoLengths: lengths
  });

  return { ...built, account, accountId: acc };
}

async function syncMetaAPI() {
  const accounts = accountIds();
  const acc = accounts[0];
  const token = LS.get('meta_access_token');
  if (!accounts.length || !token) { setApiStatus('offline'); return; }

  if (location.protocol === 'file:') {
    setApiStatus('offline');
    showModal('Open it through the launcher', `
      <p>Browsers refuse API calls from a page opened as a file (<code>file://</code>). Nothing is wrong with your token.</p>
      <p><strong>Fix:</strong> close this tab and double-click <code>Start Dashboard.command</code> in the dashboard folder.
      It starts a tiny local server and reopens the page at <code>http://localhost:8765</code>, where the API works.</p>`);
    loadDemoFallback();
    return;
  }

  setApiStatus('syncing');
  State.droppedFields = [];
  const preset = LS.get('meta_date_preset', 'today');

  try {
    const results = await Promise.all(accounts.map(id =>
      fetchAccount(id, preset).catch(err => ({ failed: true, accountId: id, message: err.message }))));

    const ok = results.filter(r => !r.failed);
    const failed = results.filter(r => r.failed);
    if (!ok.length) throw new Error(failed[0].message);

    State.currency = ok[0].account.currency || 'EUR';
    State.accountErrors = failed.map(f => `${f.accountId}: ${f.message}`);
    State.campaigns = ok.flatMap(r => r.campaigns);
    State.ads = ok.flatMap(r => r.ads);
    State.adStatuses = ok.flatMap(r => r.adStatuses || []);
    State.lpvEstimated = ok.some(r => r.lpvEstimated);
    State.lastSync = Date.now();
    State.source = 'api';

    if (!State.campaigns.length) {
      setApiStatus('offline');
      showModal('Connected, but no spend found', `The ${accounts.length === 1 ? 'account' : 'accounts'} answered fine, but there is no campaign data for <strong>${preset.replace(/_/g, ' ')}</strong>. Pick a wider window in the Meta API panel, or wait until spend starts.`);
      loadDemoFallback();
      return;
    }

    State.accountTz = (ok[0] && ok[0].account && ok[0].account.timezone_name) || null;

    // Shopify is the revenue of record. Pull it for the same window, in the
    // same timezone, before any verdict is computed.
    await syncTruth(preset);

    setApiStatus('online', `Live · ${accountClock()}`);
    document.getElementById('brand-sub').innerText = ok.length === 1
      ? `${ok[0].account.name || acc} · ${State.currency} · ${ok[0].account.timezone_name || ''}`
      : `${ok.length} ad accounts · ${State.currency}`;
    renderAccountTabs();   // the "no economics yet" warning is per account
    renderAll();

  } catch (err) {
    console.error(err);
    setApiStatus('offline');
    const expired = /session|expired|access token|OAuth|190/i.test(err.message);
    showModal('Sync failed', expired
      ? `<p><strong>Your access token has expired.</strong></p>
         <p>Meta said: <em>${esc(err.message)}</em></p>
         <p>Generate a fresh one in the <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noopener">Graph API Explorer</a>,
         then extend it to 60 days with the <a href="https://developers.facebook.com/tools/accesstoken/" target="_blank" rel="noopener">Access Token Tool</a>
         so you are not doing this every hour. Paste it back into ⚙️ Meta API.</p>
         <p>Showing demo data until then.</p>`
      : `<p><strong>${esc(err.message)}</strong></p>
         <p>Usual causes:</p>
         <ul>
           <li>Account ID missing the <code>act_</code> prefix.</li>
           <li>Token missing <code>ads_read</code> or <code>read_insights</code>.</li>
           <li>The token belongs to a user without access to that ad account.</li>
         </ul>
         <p>Showing demo data so you can still use the dashboard.</p>`);
    loadDemoFallback();
  }
}

function loadDemoFallback() {
  const demo = buildDemoData();
  State.campaigns = demo.campaigns;
  State.ads = demo.ads;
  State.source = 'demo';
  State.truth = null;
  State.truthStatus = null;
  State.truthMatch = null;
  renderAll();
}

/* --------------------------------------------------- Shopify truth ------- */
async function syncTruth(preset) {
  State.truth = null;
  State.truthMatch = null;

  const workerUrl = LS.get('truth_worker_url', '');
  const dashKey = LS.get('truth_dash_key', '');

  if (!workerUrl || !dashKey) {
    State.truthStatus = {
      state: 'off',
      message: 'No Shopify truth connected, so every verdict below runs on Meta\'s attributed revenue and scaling is locked. Add the Truth Worker in ⚙️ Settings.'
    };
    return;
  }

  const res = await TR.fetchTruth({
    workerUrl, dashKey,
    preset: preset || LS.get('meta_date_preset', 'today'),
    range: State.range,            // a custom span wins over the preset
    tz: State.accountTz || 'Europe/Berlin'
  });

  if (!res.ok) {
    State.truthStatus = {
      state: 'error',
      message: (res.error || 'The Truth Worker did not answer.') +
               ' Verdicts below fall back to Meta revenue and scaling is locked.'
    };
    return;
  }

  State.truth = res.data;
  State.truthRange = { since: res.since, until: res.until };
  State.truthMatch = TR.match(State.campaigns, res.data.byProduct || {}, LS.json('cgo_product_map', {}));
  State.truthStatus = { state: 'ok', message: null };
  State.truthSyncedAt = Date.now();
}

/* --------------------------------------------------- API → app model ----- */
function actionVal(list, type) {
  if (!Array.isArray(list)) return 0;
  const hit = list.find(a => a.action_type === type);
  return hit ? parseFloat(hit.value) || 0 : 0;
}

function conversions(row) {
  const a = row.actions, av = row.action_values;
  // `omni_purchase` is what Ads Manager's "Purchases" column reports. Prefer it
  // so the dashboard and Ads Manager never disagree; fall back for accounts
  // that only report the pixel event.
  const purchases = actionVal(a, 'omni_purchase') || actionVal(a, 'purchase') ||
                    actionVal(a, 'offsite_conversion.fb_pixel_purchase');
  const revenue = actionVal(av, 'omni_purchase') || actionVal(av, 'purchase') ||
                  actionVal(av, 'offsite_conversion.fb_pixel_purchase');
  const atc = actionVal(a, 'offsite_conversion.fb_pixel_add_to_cart') || actionVal(a, 'add_to_cart');
  const ic = actionVal(a, 'offsite_conversion.fb_pixel_initiate_checkout') || actionVal(a, 'initiate_checkout');
  const lpvRaw = actionVal(a, 'landing_page_view');
  return { purchases, revenue, atc, ic, lpvRaw };
}

function buildFromApi({ campaigns, adsets, judged, history, adInsights, adsMeta, preset, accountId, accountName, videoLengths }) {
  const vlen = videoLengths || {};
  let lpvEstimated = false;

  // Ad-set budgets, summed per campaign — the fallback when the campaign is
  // not on CBO and the daily budget lives one level down.
  // Learning status also lives here: any ad set still learning means the
  // campaign must not have its budget touched.
  const adsetBudget = {};
  const learningByCampaign = {};
  (adsets || []).forEach(s => {
    if ((s.effective_status || '').toUpperCase() === 'DELETED') return;
    const b = s.daily_budget ? parseFloat(s.daily_budget) / 100 : 0;
    if (b) adsetBudget[s.campaign_id] = (adsetBudget[s.campaign_id] || 0) + b;
    const stage = s.learning_stage_info && s.learning_stage_info.status;
    if (/^LEARNING$/i.test(stage || '')) learningByCampaign[s.campaign_id] = true;
  });

  // History, day by day, per campaign. This range ends yesterday, which is
  // exactly right: a streak should only count days that have actually closed.
  const historyByCampaign = {};
  history.forEach(r => (historyByCampaign[r.campaign_id] = historyByCampaign[r.campaign_id] || []).push(r));
  Object.values(historyByCampaign).forEach(rows =>
    rows.sort((a, b) => (a.date_start || '').localeCompare(b.date_start || '')));

  // The judged window, aggregated by Meta itself.
  const judgedByCampaign = {};
  (judged || []).forEach(r => { judgedByCampaign[r.campaign_id] = r; });

  const judgingToday = preset === 'today';

  const built = campaigns.map(c => {
    const daily = (historyByCampaign[c.id] || []).map(r => {
      const conv = conversions(r);
      const spend = parseFloat(r.spend) || 0;
      return { date: r.date_start, spend, revenue: conv.revenue, roas: spend > 0 ? conv.revenue / spend : 0 };
    });

    const j = judgedByCampaign[c.id] || {};
    const conv = conversions(j);
    const spend = parseFloat(j.spend) || 0;
    const clicks = parseInt(j.inline_link_clicks) || 0;

    let lpv = conv.lpvRaw;
    if (!lpv && clicks) { lpv = Math.round(clicks * 0.82); lpvEstimated = true; }

    // Meta's own purchase ROAS is authoritative; fall back to the arithmetic.
    const metaRoas = Array.isArray(j.purchase_roas) && j.purchase_roas.length
      ? parseFloat(j.purchase_roas[0].value) || 0 : 0;
    const roas = metaRoas || (spend > 0 ? conv.revenue / spend : 0);

    let budget = 0, budgetSource = 'none';
    if (c.daily_budget) { budget = parseFloat(c.daily_budget) / 100; budgetSource = 'cbo'; }
    else if (adsetBudget[c.id]) { budget = adsetBudget[c.id]; budgetSource = 'adset'; }
    else if (c.lifetime_budget) { budget = parseFloat(c.lifetime_budget) / 100; budgetSource = 'lifetime'; }

    // The sparkline should end on the day being judged, so today gets appended.
    const series = judgingToday && spend > 0
      ? daily.concat([{ date: 'today', spend, revenue: conv.revenue, roas }])
      : daily;

    const closedDays = daily.filter(d => d.spend > 0).length;

    return {
      id: c.id,
      name: c.name,
      accountId,
      accountName,
      status: (c.effective_status || c.status || '').toUpperCase(),
      learning: !!learningByCampaign[c.id],
      budget,
      budgetSource,
      series,
      createdTime: c.created_time,
      daysLive: Math.max(1, closedDays + (judgingToday && spend > 0 ? 1 : 0)),
      spend,
      // Meta's figures are kept under their own names so the gap stays visible
      // after Shopify overwrites the headline revenue.
      metaRevenue: conv.revenue,
      metaRoas: roas,
      metaPurchases: conv.purchases,
      revenue: conv.revenue,
      roas,
      purchases: conv.purchases,
      clicks,
      impressions: parseInt(j.impressions) || 0,
      reach: parseInt(j.reach) || 0,
      lpv, atc: conv.atc, ic: conv.ic,
      frequency: parseFloat(j.frequency) || 0,
      ctr: parseFloat(j.inline_link_click_ctr) || 0,
      cpc: parseFloat(j.cost_per_inline_link_click) || 0,
      cpm: parseFloat(j.cpm) || 0,
      // Streaks judge closed days only — never the day still in progress.
      history: daily
    };
  }).filter(c => c.spend > 0 || c.status === 'ACTIVE');

  // ---- ads table ----
  const creativeById = {};
  adsMeta.forEach(a => {
    creativeById[a.id] = {
      headline: (a.creative && a.creative.title) || '',
      body: (a.creative && a.creative.body) || '',
      type: decodeFormat(a.creative && a.creative.object_type),
      creativeId: (a.creative && a.creative.id) || '',
      videoId: (a.creative && a.creative.video_id) || '',
      thumbnail: (a.creative && a.creative.thumbnail_url) || '',
      effectiveStatus: (a.effective_status || '').toUpperCase(),
      name: a.name || ''
    };
  });

  // Ads Meta is refusing to deliver — these never reach the insights list, so
  // they have to be collected from the ad objects themselves.
  const adStatuses = adsMeta.map(a => ({
    name: a.name || a.id,
    campaignId: a.campaign_id || '',
    effectiveStatus: (a.effective_status || '').toUpperCase()
  }));

  const ads = adInsights.map(r => {
    const cr = creativeById[r.ad_id] || {};
    const conv = conversions(r);
    const spend = parseFloat(r.spend) || 0;
    const impressions = parseInt(r.impressions) || 0;
    const clicks = parseInt(r.inline_link_clicks) || 0;
    let lpv = conv.lpvRaw; if (!lpv && clicks) { lpv = Math.round(clicks * 0.82); lpvEstimated = true; }
    // Meta removed the 3-second view metric. Video plays is the closest live
    // equivalent and is what "hook rate" means in practice now.
    const v3 = actionVal(r.video_play_actions, 'video_view');
    const thru = actionVal(r.video_thruplay_watched_actions, 'video_view');
    const hookRate = impressions > 0 ? (v3 / impressions) * 100 : 0;
    // Link CTR and link CPC — not the all-clicks versions, which count every
    // reaction and profile tap and read far better than reality.
    const ctr = parseFloat(r.inline_link_click_ctr) || 0;
    const cpc = parseFloat(r.cost_per_inline_link_click) || 0;
    const metaRoas = Array.isArray(r.purchase_roas) && r.purchase_roas.length
      ? parseFloat(r.purchase_roas[0].value) || 0 : 0;

    /* The structured shape the creative desk reads. Kept alongside the
       display row rather than parsed back out of formatted strings. */
    const creativeRow = {
      id: r.ad_id,
      name: r.ad_name || r.ad_id,
      campaignId: r.campaign_id || '',
      campaign: r.campaign_name || '',
      type: cr.type || (v3 > 0 ? 'Video' : 'Image'),
      impressions,
      v3,
      p25: actionVal(r.video_p25_watched_actions, 'video_view'),
      p50: actionVal(r.video_p50_watched_actions, 'video_view'),
      p75: actionVal(r.video_p75_watched_actions, 'video_view'),
      p100: actionVal(r.video_p100_watched_actions, 'video_view'),
      avgWatchSec: actionVal(r.video_avg_time_watched_actions, 'video_view'),
      lengthSec: vlen[cr.videoId] || 0,
      clicks,
      spend,
      purchases: conv.purchases,
      revenue: conv.revenue,
      thumbnail: cr.thumbnail || '',
      status: cr.effectiveStatus || '',
      days: 1
    };

    return normalizeAd({
      _creative: creativeRow,
      'Ad Name': r.ad_name || r.ad_id,
      'Campaign': r.campaign_name || '',
      'Creative Type': cr.type || (v3 > 0 ? 'Video' : 'Image'),
      'Hook Rate (%)': hookRate.toFixed(2),
      'Link CTR (%)': ctr.toFixed(2),
      'Spend ($)': spend.toFixed(2),
      'Reach': String(parseInt(r.reach) || 0),
      'Headline': cr.headline,
      'Primary Text Snippet': cr.body,
      'CPM ($)': (parseFloat(r.cpm) || 0).toFixed(2),
      'CPC ($)': cpc.toFixed(2),
      'Impressions': String(impressions),
      'Link Clicks': String(clicks),
      'Landing Page Views': String(lpv),
      'Adds to Cart': String(conv.atc),
      'Checkouts Initiated': String(conv.ic),
      'Purchases': String(conv.purchases),
      'Purchase ROAS': (metaRoas || (spend > 0 ? conv.revenue / spend : 0)).toFixed(2),
      'Cost per Purchase': conv.purchases > 0 ? (spend / conv.purchases).toFixed(2) : '',
      'Frequency': (parseFloat(r.frequency) || 0).toFixed(2),
      'Video 3s Views': String(v3),
      'Thruplay Views': String(thru),
      'Ad ID': r.ad_id,
      'Creative ID': cr.creativeId || '',
      'Status': cr.effectiveStatus || ''
    });
  });

  return { campaigns: built, ads, adStatuses, lpvEstimated };
}

function decodeFormat(t) {
  const s = (t || '').toUpperCase();
  if (s.includes('VIDEO')) return 'Video';
  if (s.includes('CAROUSEL') || s.includes('MULTI')) return 'Carousel';
  if (!s) return '';
  return 'Image';
}

/* --------------------------------------------- per-ad score + feedback --- */
function normalizeAd(ad) {
  const ctr = parseFloat(ad['Link CTR (%)']) || 0;
  const hook = parseFloat(ad['Hook Rate (%)']) || 0;
  const clicks = parseInt(ad['Link Clicks']) || 0;
  const lpv = parseInt(ad['Landing Page Views']) || 0;
  const atc = parseInt(ad['Adds to Cart']) || 0;
  const ic = parseInt(ad['Checkouts Initiated']) || 0;
  const purchases = parseInt(ad['Purchases']) || 0;
  const freq = parseFloat(ad['Frequency']) || 0;
  const text = ((ad['Headline'] || '') + ' ' + (ad['Primary Text Snippet'] || '')).toLowerCase();

  const triggers = EMOTIONAL_TRIGGERS_LIST.filter(t => text.includes(t));
  const hasCTA = CTA_VERBS_LIST.some(v => new RegExp('\\b' + v, 'i').test(text));
  const hasQuestion = text.includes('?');
  const hasNumber = /\d/.test(text);

  let score = 5;
  if (ctr >= 2) score += 2; else if (ctr < 0.8) score -= 2;
  if (ad['Creative Type'] === 'Video') { if (hook >= 30) score += 2; else if (hook < 15 && hook > 0) score -= 2; }
  if (hasCTA) score += 1;
  if (hasQuestion || hasNumber) score += 1;
  if (triggers.length >= 3) score += 1;
  score = Math.max(1, Math.min(10, score));

  const fb = [];
  if (ctr && ctr < 2) fb.push('CTR under 2% — the hook is not stopping the scroll. Change the first frame, not the offer.');
  if (ad['Creative Type'] === 'Video' && hook > 0 && hook < 25) fb.push('Hook rate under 25% — rebuild the first 3 seconds with a pattern interrupt.');
  if (clicks && lpv < clicks * 0.7) fb.push('Clicks are not reaching the page — Funnelish/Shopify load speed is leaking traffic.');
  if (lpv && atc < lpv * 0.05 && !State.atcBroken) fb.push('Add-to-cart under 5% — offer or price problem, not a creative problem.');
  if (atc && ic < atc * 0.3) fb.push('Carts are not starting checkout — usually shipping cost revealed too late.');
  if (ic && purchases < ic * 0.5) fb.push('Checkouts are not finishing — check Klarna/PayPal and the trust block.');
  if (freq > VE.RULES.frequency.fatigue) fb.push(`Frequency ${freq.toFixed(2)} — the same people keep seeing it. Refresh the creative.`);
  if (!fb.length) fb.push('Nothing broken. Leave it alone and let it spend.');

  ad['Score (1-10)'] = String(score);
  ad['Emotional Triggers'] = triggers.join(', ') || 'None';
  ad['Has CTA'] = hasCTA ? 'Yes' : 'No';
  ad['Actionable Feedback'] = fb.join(' | ');
  return ad;
}

/* ========================================================================== *
 *  VERDICTS
 * ========================================================================== */
function actionLog() { return acctJson('cgo_action_log', {}); }
function saveActionLog(l) { acctSet('cgo_action_log', JSON.stringify(l)); }

function berFor(campaign) {
  const parsed = VE.parseCampaignName(campaign.name);
  const override = acctJson('cgo_ber_overrides', {})[campaign.id];
  const ber = override || parsed.ber || (State.econ && State.econ.valid ? State.econ.ber : 0);
  return {
    ber,
    grossMargin: ber > 0 ? 1 / ber : 0,
    source: override ? 'override' : parsed.ber ? 'name' : (State.econ && State.econ.valid ? 'economics' : 'none')
  };
}

/* Overlay the Shopify figures onto each campaign. Meta's numbers are kept
   alongside so the card can show both and the gap between them — the gap is
   the early warning that tracking has drifted again. */
function applyTruth() {
  const m = State.truthMatch;
  State.campaigns.forEach(c => {
    const row = m && m.perCampaign[c.id];
    if (row) {
      c.trueRevenue = row.net;
      c.trueGross = row.gross;
      c.trueRefunded = row.refunded;
      c.trueOrders = row.orders;
      c.trueProducts = row.products;
      c.revenue = row.net;
      c.roas = c.spend > 0 ? row.net / c.spend : 0;
      c.purchases = row.orders;
      c.revenueSource = 'shopify';
      c.revenueGap = Math.round((row.net - (c.metaRevenue || 0)) * 100) / 100;
    } else {
      c.trueRevenue = null;
      c.revenue = c.metaRevenue !== undefined ? c.metaRevenue : c.revenue;
      c.roas = c.metaRoas !== undefined ? c.metaRoas : c.roas;
      c.purchases = c.metaPurchases !== undefined ? c.metaPurchases : c.purchases;
      c.revenueGap = null;
      c.revenueSource = State.source === 'api' ? 'meta' : State.source;
    }
  });
}

/* The ATC event does not fire on these funnels. Detect it at account level —
   no adds to cart anywhere while orders are being placed is a tracking fault,
   not nine simultaneous offer failures. Without this flag every new campaign
   gets killed as "nobody wants the offer", which is simply untrue. */
function detectAtcBroken() {
  const t = State.campaigns.reduce((a, c) => {
    a.atc += c.atc || 0; a.purchases += c.purchases || 0; a.spend += c.spend || 0;
    return a;
  }, { atc: 0, purchases: 0, spend: 0 });
  State.atcBroken = t.atc === 0 && (t.purchases > 0 || t.spend > 100);
}

/* The judged day against the trailing closed days, from the SAME source, so
   one noisy day cannot be mistaken for a trend and a trend cannot be used to
   excuse a bad day. Both sides are Meta history, which is why it is labelled
   as a Meta trend and never replaces the verdict. */
function metaTrendPool(c, days) {
  const rows = (c.history || []).filter(d => d.spend > 0).slice(-days);
  if (rows.length < 2) return null;
  const spend = rows.reduce((s, d) => s + d.spend, 0);
  const revenue = rows.reduce((s, d) => s + d.revenue, 0);
  return { spend, revenue, purchases: 0, roas: spend > 0 ? revenue / spend : 0, days: rows.length };
}

function computeVerdicts() {
  const now = new Date();
  const ctxDay = VE.dayContext(now, State.accountTz);
  const win = activeWindow();
  const log = actionLog();

  applyTruth();
  detectAtcBroken();

  State.campaigns.forEach(c => {
    const { ber, grossMargin, source } = berFor(c);
    const entry = log[c.id] || {};
    c.descaleCount = entry.descaleCount || 0;
    c.profitableStreak = VE.countProfitableStreak(c.history, ber);
    c.berSource = source;
    c.surfedRecently = ['SURF', 'SCALE'].includes(entry.lastCode) && daysAgo(entry.last) <= 2;

    const ctx = {
      ber, grossMargin, window: win,
      isSaturday: ctxDay.isSaturday, isSunday: ctxDay.isSunday,
      learning: c.learning,
      currency: State.currency,
      revenueSource: c.revenueSource,
      atcTrackingBroken: State.atcBroken
    };

    c.verdict = VE.verdict(c, ctx);

    // Stability check — shown as a note, never as a second verdict.
    const pool = metaTrendPool(c, 3);
    c.trend = pool ? VE.windowAgreement(
      { ...c, revenue: c.metaRevenue, roas: c.metaRoas }, pool,
      { ...ctx, revenueSource: 'meta' }
    ) : null;

    c.lastAction = entry.last || null;
  });

  State.multiAccount = new Set(State.campaigns.map(c => c.accountId).filter(Boolean)).size > 1;

  // sort: most urgent first
  const rank = { KILL: 0, DESCALE: 1, PRICE_DROP: 2, SURF: 3, SCALE: 4, PROVE: 5, HOLD: 6, DIAGNOSE: 7, MONITOR: 8, NEEDS_SETUP: 9 };
  State.campaigns.sort((a, b) => (rank[a.verdict.code] - rank[b.verdict.code]) || (b.spend - a.spend));
}

const VERDICT_ICON = { KILL: '⛔', DESCALE: '📉', PRICE_DROP: '🏷️', SCALE: '📈', SURF: '🏄', PROVE: '⏳',
                       HOLD: '✋', MONITOR: '👀', DIAGNOSE: '🔧', NEEDS_SETUP: '⚙️' };

/* 14 days of ROAS against the break-even line. One glance answers "is this
   getting better or worse", which no single-day number can. */
function sparkline(series, ber) {
  const days = (series || []).filter(d => d.spend > 0).slice(-14);
  if (days.length < 2) return '<div class="spark-empty">Not enough history yet</div>';

  const W = 260, H = 44, pad = 3;
  const vals = days.map(d => d.roas);
  const top = Math.max(ber * 1.6, ...vals, 1);
  const x = i => pad + (i * (W - pad * 2)) / (days.length - 1);
  const y = v => H - pad - (Math.min(v, top) / top) * (H - pad * 2);

  const line = days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.roas).toFixed(1)}`).join(' ');
  const area = `${line} L${x(days.length - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;
  const berY = y(ber).toFixed(1);
  const last = days[days.length - 1];
  const tone = last.roas >= ber ? 'up' : 'down';
  const first = days[0].roas;
  const drift = first > 0 ? Math.round(((last.roas - first) / first) * 100) : 0;

  return `
    <div class="spark ${tone}">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
           aria-label="Meta-reported ROAS over the last ${days.length} days, ending at ${last.roas.toFixed(2)} against break-even ${ber.toFixed(2)}">
        <path class="spark-area" d="${area}"/>
        <line class="spark-ber" x1="${pad}" x2="${W - pad}" y1="${berY}" y2="${berY}"/>
        <path class="spark-line" d="${line}"/>
        <circle class="spark-dot" cx="${x(days.length - 1).toFixed(1)}" cy="${y(last.roas).toFixed(1)}" r="3"/>
      </svg>
      <span class="spark-cap">${days.length}d ROAS as Meta reported it · dashed line is break-even · ${drift >= 0 ? '+' : ''}${drift}% since day one</span>
    </div>`;
}

/* The revenue provenance strip on each card. This is the single most
   important thing on the card, because it says whether the number underneath
   can be trusted. */
function revenueLine(c) {
  if (c.revenueSource === 'shopify') {
    const gap = c.revenueGap;
    const gapTxt = gap === null ? '' :
      Math.abs(gap) < 0.5 ? ' · Meta agrees' :
      ` · Meta said ${fmtMoney(c.metaRevenue, 0)}, out by ${gap > 0 ? '−' : '+'}${fmtMoney(Math.abs(gap), 0)}`;
    const refund = c.trueRefunded > 0 ? ` · ${fmtMoney(c.trueRefunded, 0)} refunded` : '';
    return `<div class="rev-line verified">
      <span class="rev-badge ok">✓ Shopify</span>
      <span>${fmtMoney(c.trueRevenue, 0)} from ${c.trueOrders} order${c.trueOrders === 1 ? '' : 's'}${refund}${gapTxt}</span>
    </div>`;
  }
  if (c.revenueSource === 'meta') {
    return `<div class="rev-line unverified">
      <span class="rev-badge warn">⚠ Meta only</span>
      <span>${fmtMoney(c.revenue, 0)} attributed, unverified. No Shopify product matched this campaign — scaling is locked.</span>
    </div>`;
  }
  return `<div class="rev-line demo"><span class="rev-badge">${esc(c.revenueSource || 'demo')}</span><span>Not live data.</span></div>`;
}

function trendNote(c) {
  const t = c.trend;
  if (!t || t.agree) return '';
  const dir = d => d === 'up' ? 'scaling' : d === 'down' ? 'cutting' : 'holding';
  return `<li class="note conflict">
    This day and the ${t.pooled.days}-day Meta trend disagree: the day points at ${dir(t.conflict.day)}
    (ROAS ${t.day.roas}), the trend at ${dir(t.conflict.pooled)} (ROAS ${t.pooled.roas}).
    Decide on one window and say which — do not take whichever supports the answer you already wanted.
  </li>`;
}

function renderVerdicts() {
  const grid = document.getElementById('verdict-grid');
  if (!State.campaigns.length) {
    grid.innerHTML = `<div class="card empty-state">No campaigns with spend in this window.</div>`;
    return;
  }

  grid.innerHTML = State.campaigns.map(c => {
    const v = c.verdict;
    const m = v.metrics;
    let budgetLine;
    if (v.budgetTo === null) {
      budgetLine = `<div class="verdict-budget none">No budget change at this read</div>`;
    } else if (v.code === 'KILL') {
      budgetLine = `<div class="verdict-budget danger">
          ${v.budgetFrom ? `<span class="bud-from">${fmtMoney(v.budgetFrom, 0)}</span><span class="bud-arrow">→</span>` : ''}
          <span class="bud-to">Turn it off</span></div>`;
    } else if (!v.budgetFrom) {
      // Meta gave us no budget for this campaign — show the move, not a fake number.
      budgetLine = `<div class="verdict-budget none">
          <strong>${esc(v.headline)}</strong> — no budget found on this campaign, so apply it wherever the budget lives.</div>`;
    } else {
      budgetLine = `<div class="verdict-budget ${v.tone}">
          <span class="bud-from">${fmtMoney(v.budgetFrom, 0)}</span><span class="bud-arrow">→</span>
          <span class="bud-to">${fmtMoney(v.budgetTo, 0)}</span>
          <span class="bud-delta">${v.budgetDelta > 0 ? '+' : ''}${fmtMoney(v.budgetDelta, 0)}/day${c.budgetSource === 'adset' ? ' · ad-set budget' : ''}</span>
        </div>`;
    }

    const marginTone = m.marginPct >= 20 ? 'success' : m.marginPct >= 15 ? 'warning' : m.marginPct > 0 ? 'neutral' : 'danger';
    const roasTone = m.ber && m.roas >= m.ber ? 'success' : 'danger';
    const lockChip = v.revenue && v.revenue.scalingLocked
      ? '<span class="lock-chip" title="Scaling needs Shopify-verified revenue">🔒 scale locked</span>' : '';
    /* How much evidence is behind this card, stated plainly. A verdict on
       four orders and a verdict on four hundred should not look the same. */
    const conf = v.confidence || {};
    const evidenceChip = !conf.interval
      ? '<span class="eq none">no orders yet</span>'
      : conf.proven
        ? `<span class="eq ok" title="Even the low end of the range clears break-even">✓ proven on ${conf.orders} orders</span>`
        : `<span class="eq thin" title="The range still crosses break-even, so this is not yet a reliable signal">~ ${conf.orders} order${conf.orders === 1 ? '' : 's'} — not conclusive${conf.ordersNeeded ? `, needs about ${conf.ordersNeeded}` : ''}</span>`;

    return `
      <article class="card verdict-card tone-${v.tone}">
        <header class="verdict-head">
          <div class="verdict-name">
            <h3>${esc(VE.productLabel(c.name))}</h3>
            <span class="verdict-fullname" title="${esc(c.name)}">${esc(c.name)}</span>
            <span class="verdict-meta">Day ${m.daysLive} · ${esc(c.status || '—')}${c.learning ? ' · <b class="learning-chip">learning</b>' : ''}${State.multiAccount && c.accountName ? ' · ' + esc(c.accountName) : ''}</span>
          </div>
          <div class="verdict-badge tone-${v.tone}">${VERDICT_ICON[v.code] || ''} ${esc(v.headline)} ${lockChip}</div>
        </header>

        ${revenueLine(c)}
        <div class="evidence-line">${evidenceChip}</div>
        ${budgetLine}

        <div class="verdict-stats">
          <div class="vstat tone-${roasTone}" title="${v.confidence && v.confidence.interval ? `Resting on ${v.confidence.orders} orders, so the real figure is between ${v.confidence.interval.lo} and ${v.confidence.interval.hi}` : 'No orders behind this figure'}">
            <span class="vstat-val">${m.roas.toFixed(2)}</span>
            <span class="vstat-cap">ROAS${v.confidence && v.confidence.interval ? ` <span class="ci">${v.confidence.interval.lo}–${v.confidence.interval.hi}</span>` : ''}</span>
          </div>
          <div class="vstat"><span class="vstat-val">${m.ber ? m.ber.toFixed(2) : '—'}</span><span class="vstat-cap">BER</span></div>
          <div class="vstat tone-${marginTone}" title="${esc(v.revenue ? v.revenue.marginMeans : 'Contribution margin')}"><span class="vstat-val">${m.marginPct > -100 ? m.marginPct + '%' : '—'}</span><span class="vstat-cap">Contribution</span></div>
          <div class="vstat"><span class="vstat-val">${fmtMoney(m.spend, 0)}</span><span class="vstat-cap">Spent</span></div>
          <div class="vstat"><span class="vstat-val">${m.purchases}</span><span class="vstat-cap">Orders</span></div>
          <div class="vstat ${m.frequency > VE.RULES.frequency.fatigue ? 'tone-warning' : ''}"><span class="vstat-val">${m.frequency.toFixed(2)}</span><span class="vstat-cap">Freq</span></div>
        </div>

        ${sparkline(c.series, m.ber)}

        <ul class="verdict-reasons">
          ${v.reasons.map(r => `<li>${esc(r)}</li>`).join('')}
          ${v.notes.map(n => `<li class="note">${esc(n)}</li>`).join('')}
          ${trendNote(c)}
          ${m.cpa && m.maxCpa ? `<li class="${m.cpa <= m.maxCpa ? 'note' : ''}">CPA ${fmtMoney(m.cpa)} against a break-even CPA of ${fmtMoney(m.maxCpa)}${m.cpa > m.maxCpa ? ' — you are paying more per order than an order is worth.' : '.'}</li>` : ''}
          ${m.pacingPct !== null && m.pacingPct < 70 && c.budget && dayIsOver() ? `<li class="note">Spent only ${m.pacingPct}% of the ${fmtMoney(c.budget, 0)} budget on a closed day — the auction could not fill it.</li>` : ''}
        </ul>

        <div class="verdict-funnel">
          ${['pageLoad', 'offer', 'intent', 'completion'].map(k => funnelChip(k, v.funnel[k])).join('')}
        </div>

        <footer class="verdict-foot">
          <span class="verdict-rule">📖 ${esc(v.rule)}</span>
          <div class="verdict-actions">
            <button class="btn-mini" onclick="editBer('${c.id}')">Set BER</button>
            ${v.budgetTo !== null ? `<button class="btn-mini primary" onclick="markApplied('${c.id}','${v.code}')">${c.lastAction === todayKey() ? '✓ Done today' : 'Mark applied'}</button>` : ''}
          </div>
        </footer>
      </article>`;
  }).join('');
}

/* A funnel chip must never show a green number it guessed. When landing page
   views are estimated at 82% of clicks, the page-speed ratio is 82% by
   construction and the band's pass mark is 70% — so it could only ever read
   healthy. That is not a measurement, so it is not displayed as one. The same
   goes for the offer ratio while the add-to-cart event is dead. */
const CHIP_LABEL = { pageLoad: 'Speed', offer: 'Offer', intent: 'Intent', completion: 'Close' };

function funnelChip(key, d) {
  const untracked =
    (key === 'pageLoad' && State.lpvEstimated) ||
    (key === 'offer' && State.atcBroken) ||
    (key === 'intent' && State.atcBroken);
  if (untracked) {
    return `<span class="fchip untracked" title="Not measured — the event does not fire on this funnel, so no number here would mean anything.">${CHIP_LABEL[key]} not tracked</span>`;
  }
  return `<span class="fchip ${d.status}" title="target ${d.target}%+">${CHIP_LABEL[key]} ${d.value}%</span>`;
}

function todayKey() { return new Date().toISOString().slice(0, 10); }
function daysAgo(key) {
  if (!key) return 999;
  const d = (Date.now() - new Date(key + 'T00:00:00').getTime()) / 86400000;
  return Number.isFinite(d) ? d : 999;
}

function markApplied(id, code) {
  const log = actionLog();
  const entry = log[id] || { descaleCount: 0 };
  entry.last = todayKey();
  entry.lastCode = code;
  if (code === 'DESCALE') entry.descaleCount = (entry.descaleCount || 0) + 1;
  if (code === 'SCALE' || code === 'SURF') entry.descaleCount = 0;
  log[id] = entry;
  saveActionLog(log);
  renderAll();
}

function editBer(id) {
  const c = State.campaigns.find(x => x.id === id);
  const current = berFor(c).ber;
  const val = prompt(`Break-even ROAS for "${c.name}"\n\nLeave empty to go back to the campaign name / your unit economics.`, current ? current.toFixed(2) : '');
  if (val === null) return;
  const overrides = acctJson('cgo_ber_overrides', {});
  const n = parseFloat(String(val).replace(',', '.'));
  if (!val.trim() || !(n > 0)) delete overrides[id]; else overrides[id] = n;
  acctSet('cgo_ber_overrides', JSON.stringify(overrides));
  renderAll();
}

/* Hand-mapping a Shopify product onto a campaign, for the cases the name
   match cannot get: a renamed product, or a campaign whose product label does
   not resemble the Shopify title. */
function editProductMap() {
  const t = State.truth;
  if (!t || !t.byProduct) {
    showModal('No Shopify data yet', '<p>Connect the Truth Worker and sync once. The product list comes from your actual orders, so there is nothing to map until then.</p>');
    return;
  }
  const map = LS.json('cgo_product_map', {});
  const titles = Object.keys(t.byProduct).sort();
  const opts = State.campaigns.map(c =>
    `<option value="${esc(c.id)}">${esc(VE.productLabel(c.name))} — ${esc(c.name)}</option>`).join('');

  const rows = titles.map(title => {
    const auto = (State.truthMatch && State.truthMatch.matches.find(x => x.title === title)) || null;
    const current = map[title] || (auto ? auto.campaignId : '');
    return `<tr>
      <td>${esc(title)}<div class="map-sub">${fmtMoney(t.byProduct[title].net)} · ${t.byProduct[title].orders} orders${auto ? ` · auto-matched to ${esc(auto.campaign)}` : ' · <b>unmatched</b>'}</div></td>
      <td><select data-title="${esc(title)}"><option value="">— leave to name matching —</option>${opts}</select></td>
    </tr>`;
  }).join('');

  showModal('Product → campaign map', `
    <p>Every Shopify product from the current window. Anything left on name matching is matched automatically;
    set one by hand only where the automatic match is wrong or missing.</p>
    <table class="map-table"><tbody>${rows}</tbody></table>
    <p class="map-foot"><button class="btn btn-primary" id="btn-save-map">Save map</button></p>`);

  // Pre-select the stored overrides, then wire the save.
  setTimeout(() => {
    document.querySelectorAll('.map-table select').forEach(sel => {
      const stored = map[sel.dataset.title];
      if (stored) sel.value = stored;
    });
    const btn = document.getElementById('btn-save-map');
    if (btn) btn.addEventListener('click', () => {
      const next = {};
      document.querySelectorAll('.map-table select').forEach(sel => {
        if (sel.value) next[sel.dataset.title] = sel.value;
      });
      LS.set('cgo_product_map', JSON.stringify(next));
      if (State.truth) {
        State.truthMatch = TR.match(State.campaigns, State.truth.byProduct || {}, next);
      }
      const modal = document.getElementById('info-modal');
      if (modal) modal.remove();
      renderAll();
    });
  }, 0);
}

/* ========================================================================== *
 *  TRUTH PANEL
 * ========================================================================== */
function truthPanelHost() {
  let el = document.getElementById('truth-panel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'truth-panel';
    const grid = document.getElementById('verdict-grid');
    if (grid && grid.parentNode) grid.parentNode.insertBefore(el, grid);
    else document.body.appendChild(el);
  }
  return el;
}

/* ========================================================================== *
 *  DATA STRIP — what window am I looking at, and how old is it
 * ========================================================================== *
 * Every number below this line is only meaningful against a date and a clock.
 * "Today" in a Berlin ad account is not today in Cairo, and a Today figure is
 * a part-day that will keep growing — scaling off it as though the day were
 * finished is the single easiest way to act on noise. The strip says the
 * dates out loud, marks a running day as running, and shows how stale each
 * source is so a silently failed sync cannot pass for fresh data.
 * ========================================================================== */
function dataStripHost() {
  let el = document.getElementById('data-strip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'data-strip';
    const kpis = document.querySelector('.kpi-grid');
    if (kpis && kpis.parentNode) kpis.parentNode.insertBefore(el, kpis);
    else document.body.insertBefore(el, document.body.firstChild);
  }
  return el;
}

function ageText(ts) {
  if (!ts) return null;
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const h = Math.floor(mins / 60);
  return h + (h === 1 ? ' hour ago' : ' hours ago');
}

/* The Berlin dates the chosen preset actually covers. Derived from the same
   helper the Shopify pull uses, so the two can never describe different days. */
function windowDates() {
  const tz = State.accountTz || 'Europe/Berlin';
  const preset = LS.get('meta_date_preset', 'today');
  try {
    const r = TR.rangeForPreset(preset, tz);
    if (!r) return null;
    const first = r.since.toISOString().slice(0, 10);
    const last = new Date(r.until.getTime() - 1).toISOString().slice(0, 10);
    return { preset, tz, first, last, single: first === last };
  } catch (e) { return null; }
}

function renderDataStrip() {
  const host = dataStripHost();
  const w = windowDates();
  if (!w) { host.innerHTML = ''; return; }

  const running = w.preset === 'today' && !dayIsOver();
  const metaAge = ageText(State.lastSync);
  const shopAge = ageText(State.truthSyncedAt);
  const stale = State.lastSync && Date.now() - State.lastSync > 30 * 60 * 1000;

  const label = w.single ? w.first : `${w.first} → ${w.last}`;
  const srcName = State.source === 'api' ? 'Meta API' : State.source === 'csv' ? 'CSV' : 'demo data';

  host.innerHTML = `
    <div class="dstrip${running ? ' running' : ''}">
      <span class="dstrip-dates">📅 <strong>${esc(label)}</strong>
        <span class="dstrip-tz">${esc(w.tz)}</span></span>
      ${running
        ? `<span class="dstrip-flag">⏳ Day still running — this is a part-day. Budget moves wait for the midnight read.</span>`
        : `<span class="dstrip-flag done">✓ Complete day</span>`}
      <span class="dstrip-src">
        ${srcName}${metaAge ? ' · synced ' + metaAge : ' · not synced'}${stale ? ' <em>(stale)</em>' : ''}
        · Shopify ${shopAge ? 'synced ' + shopAge : 'not connected'}
      </span>
    </div>`;

}

/* ========================================================================== *
 *  DATE BAR
 * ========================================================================== *
 * The check WINDOW (morning / evening / midnight) and the DATES being read
 * are two different things. Keeping them separate is what lets you review
 * last Tuesday without the engine pretending it is Tuesday morning.
 * ========================================================================== */
function renderDateBar() {
  const preset = LS.get('meta_date_preset', 'today');
  document.querySelectorAll('.date-btn[data-preset]').forEach(b =>
    b.classList.toggle('active', !State.range && b.dataset.preset === preset));

  const note = document.getElementById('date-note');
  if (!note) return;
  const tzName = State.accountTz ? State.accountTz.split('/').pop().replace(/_/g, ' ') : null;

  if (State.range) {
    note.innerHTML = `Showing <strong>${esc(windowLabel())}</strong>` +
      (tzName ? ` in ${esc(tzName)} time.` : '.') +
      ` Verdicts still follow the ${esc(activeWindow())} read.`;
  } else if (preset === 'today') {
    note.innerHTML = `Showing <strong>today so far</strong>` + (tzName ? ` (${esc(tzName)} time)` : '') +
      `. This is a part-day — budget moves wait for the midnight read.`;
  } else {
    note.innerHTML = `Showing <strong>${esc(windowLabel())}</strong>. ` +
      `Meta's multi-day windows <strong>end yesterday</strong> — today is not included.`;
  }
}

function refreshWindow() {
  renderDateBar();
  if (State.live) syncMetaAPI(); else loadData();
}

function setupDateBar() {
  document.querySelectorAll('.date-btn[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      State.range = null;                 // an explicit preset clears any custom span
      State.dateManual = true;
      LS.set('meta_date_preset', btn.dataset.preset);
      const sel = document.getElementById('meta-date-preset');
      if (sel) sel.value = btn.dataset.preset;   // keep the dialog honest
      refreshWindow();
    });
  });

  const from = document.getElementById('date-from');
  const to = document.getElementById('date-to');
  const apply = document.getElementById('date-apply');

  apply && apply.addEventListener('click', () => {
    if (!from.value) return;
    const since = from.value;
    const until = to.value && to.value >= since ? to.value : since;
    State.range = { since, until };
    State.dateManual = true;
    refreshWindow();
  });

  /* ‹ › step one day at a time through history — the fastest way to answer
     "was yesterday a fluke, or is this a trend?" */
  const step = dir => {
    const base = State.range ? State.range.until : todayInAccountTz(0);
    const d = new Date(base + 'T12:00:00');
    d.setDate(d.getDate() + dir);
    const day = d.toISOString().slice(0, 10);
    if (day > todayInAccountTz(0)) return;          // no future days
    State.range = { since: day, until: day };
    State.dateManual = true;
    from.value = day; to.value = day;
    refreshWindow();
  };
  const prev = document.getElementById('date-prev');
  const next = document.getElementById('date-next');
  prev && prev.addEventListener('click', () => step(-1));
  next && next.addEventListener('click', () => step(1));
}

function renderTruthPanel() {
  const host = truthPanelHost();
  const st = State.truthStatus;

  if (!st) { host.innerHTML = ''; return; }

  if (st.state !== 'ok') {
    host.innerHTML = `
      <div class="truth-card ${st.state === 'off' ? 'off' : 'bad'}">
        <div class="truth-head">
          <strong>${st.state === 'off' ? 'Shopify truth not connected' : 'Shopify truth unavailable'}</strong>
          <span class="truth-chip warn">🔒 scaling locked</span>
        </div>
        <p>${esc(st.message)}</p>
      </div>`;
    return;
  }

  const t = State.truth;
  const m = State.truthMatch || { attributed: 0, unattributed: 0, unmatchedProducts: [], unmatchedCampaigns: [], matches: [] };
  const metaTotal = State.campaigns.reduce((s, c) => s + (c.metaRevenue || 0), 0);
  const spend = State.campaigns.reduce((s, c) => s + (c.spend || 0), 0);
  const gap = t.net - metaTotal;
  const gapPct = metaTotal > 0 ? (gap / metaTotal) * 100 : 0;
  const range = State.truthRange;
  const rangeTxt = range
    ? `${range.since.toISOString().slice(0, 10)} → ${new Date(range.until.getTime() - 1).toISOString().slice(0, 10)}`
    : '';

  const warnings = [];
  if (Math.abs(gapPct) > 5) {
    warnings.push(`Meta's account total is out by ${gapPct > 0 ? '−' : '+'}${Math.abs(gapPct).toFixed(1)}%. Up to about 2% is normal here; more than that means the Shopify pull is incomplete or tracking has degraded further.`);
  }
  if (m.unattributed > 0) {
    warnings.push(`${fmtMoney(m.unattributed)} of real orders could not be matched to any live campaign: ${m.unmatchedProducts.map(p => esc(p.title)).join(', ')}. That revenue is counted in the account total but in no campaign's ROAS. Fix it in the product map.`);
  }
  if (m.unmatchedCampaigns.length) {
    warnings.push(`${m.unmatchedCampaigns.length} campaign${m.unmatchedCampaigns.length === 1 ? '' : 's'} spent money and matched no Shopify orders: ${m.unmatchedCampaigns.map(c => esc(c.label) + ' (' + fmtMoney(c.spend, 0) + ')').join(', ')}. Either they genuinely sold nothing, or the product name does not match — check before cutting.`);
  }
  if (State.atcBroken) {
    warnings.push('The add-to-cart event is not firing anywhere on this account, so no offer or checkout-intent ratio is meaningful. Day-1 kills fall back to landing-page views, and the price-drop test cannot run until the event is fixed.');
  }

  host.innerHTML = `
    <div class="truth-card ok">
      <div class="truth-head">
        <strong>Shopify is the revenue of record</strong>
        <span class="truth-chip ok">✓ ${t.orders} orders${rangeTxt ? ' · ' + rangeTxt : ''}</span>
      </div>
      <div class="truth-grid">
        <div><span class="truth-big">${fmtMoney(t.net, 0)}</span><span class="truth-cap">Shopify, net of refunds</span></div>
        <div><span class="truth-big">${fmtMoney(metaTotal, 0)}</span><span class="truth-cap">Meta reported</span></div>
        <div><span class="truth-big ${Math.abs(gapPct) > 5 ? 'bad' : ''}">${gap >= 0 ? '+' : '−'}${fmtMoney(Math.abs(gap), 0)}</span><span class="truth-cap">Gap (${gapPct >= 0 ? '+' : '−'}${Math.abs(gapPct).toFixed(1)}%)</span></div>
        <div><span class="truth-big">${spend > 0 ? (t.net / spend).toFixed(2) : '—'}</span><span class="truth-cap">Shopify ÷ Meta spend</span></div>
        ${t.refunded > 0 ? `<div><span class="truth-big">${fmtMoney(t.refunded, 0)}</span><span class="truth-cap">Refunded in window</span></div>` : ''}
      </div>
      <p class="truth-foot">
        Account totals have always agreed within about 2%. The per-campaign split is what was wrong, so the
        number that matters on each card below is the one labelled ✓ Shopify.
        <strong>Shopify ÷ Meta spend is not ROAS</strong> — it includes orders from email, organic and returning
        customers, so it flatters paid. Judge campaigns on their own card, not on this ratio.
      </p>
      ${warnings.length ? `<ul class="truth-warnings">${warnings.map(w => `<li>${w}</li>`).join('')}</ul>` : ''}
    </div>`;
}

/* ========================================================================== *
 *  CREATIVE DESK
 * ========================================================================== */
function creativeHost() {
  let el = document.getElementById('creative-desk');
  if (!el) {
    el = document.createElement('section');
    el.id = 'creative-desk';
    el.className = 'section-block';
    const table = document.querySelector('.table-card');
    if (table && table.parentNode) table.parentNode.insertBefore(el, table);
    else document.body.appendChild(el);
  }
  return el;
}

/* The curve, drawn. A shape falls off a cliff at one of six places and the
   cliff is the brief. */
function retentionBar(ret) {
  if (!ret.isVideo || ret.points.length < 2) return '';
  const pts = ret.points;
  const max = pts[0].viewers || 1;
  return `
    <div class="ret">
      ${pts.map(p => {
        const h = Math.max(2, Math.round((p.viewers / max) * 100));
        const when = p.seconds !== null && p.seconds !== undefined ? `${p.seconds}s` : p.label;
        return `<div class="ret-col" title="${esc(`${fmtInt(p.viewers)} ${p.what} (${p.pctOfImpressions}%)`)}">
            <div class="ret-fill" style="height:${h}%"></div>
            <span class="ret-lab">${esc(when)}</span>
            <span class="ret-val">${p.pctOfImpressions}%</span>
          </div>`;
      }).join('')}
    </div>
    ${ret.avgWatchSec ? `<div class="ret-cap">Average viewer watches ${ret.avgWatchSec}s${ret.lengthSec ? ` of ${ret.lengthSec}s — ${ret.avgWatchPct}% of the cut` : ''}.</div>` : ''}`;
}

const AD_CODE = {
  SCALE_SOURCE: { label: 'Make more like this', tone: 'success' },
  KEEP:         { label: 'Keep', tone: 'neutral' },
  KEEP_FOR_NOW: { label: 'Held — replace it', tone: 'warning' },
  TESTING:      { label: 'Still testing', tone: 'neutral' },
  PAUSE:        { label: 'Pause', tone: 'danger' }
};

function renderCreativeDesk() {
  const host = creativeHost();
  const rows = State.ads.map(a => a._creative).filter(Boolean);

  if (!rows.length) {
    host.innerHTML = `
      <h2 class="section-title">🎬 Creative desk</h2>
      <p class="section-lede">No ad-level data in this window.</p>`;
    return;
  }

  /* Group by campaign so each brief is about one product and one offer. */
  const byCampaign = {};
  rows.forEach(r => {
    const key = r.campaignId || r.campaign || 'Unassigned';
    (byCampaign[key] = byCampaign[key] || { name: r.campaign || key, ads: [] }).ads.push(r);
  });

  const blocks = Object.entries(byCampaign).map(([key, group]) => {
    const campaign = State.campaigns.find(c => c.id === key) || {};
    const { ber } = campaign.id ? berFor(campaign) : { ber: State.econ && State.econ.valid ? State.econ.ber : 0 };
    const cpa = campaign.purchases > 0 ? campaign.spend / campaign.purchases : 0;

    const label = VE.productLabel(group.name);
    const d = CD.desk(label, group.ads,
      { ber, currency: State.currency, campaignCpa: cpa, fullName: group.name });

    const adCards = d.verdicts.ads
      .sort((a, b) => b.spend - a.spend)
      .map(a => {
        const meta = AD_CODE[a.code] || AD_CODE.KEEP;
        const p = a.diagnosis.primary;
        return `
          <div class="ad-card tone-${meta.tone}">
            <div class="ad-head">
              <strong>${esc(a.name)}</strong>
              <span class="ad-chip ${meta.tone}">${meta.label}</span>
            </div>
            <div class="ad-nums">
              ${fmtMoney(a.spend, 0)} · ${a.purchases} order${a.purchases === 1 ? '' : 's'} · ROAS ${a.roas.toFixed(2)}
              ${a.type === 'Video' ? ' · video' : ' · image'}
            </div>
            <div class="ad-why">${esc(a.why)}</div>
            ${retentionBar(CD.retention(group.ads.find(x => x.id === a.id)))}
            <div class="ad-stages">
              ${a.diagnosis.stages.map(s => `
                <span class="schip ${s.status}" title="${esc(s.measurable ? `${s.window} — target ${s.target}%+` : 'Not measurable for this ad')}">
                  ${esc(s.label)} ${s.measurable ? s.value + '%' : '—'}
                </span>`).join('')}
            </div>
            ${p ? `<div class="ad-fix"><strong>${esc(p.label)} — ${esc(p.window)}.</strong> ${esc(p.fails)}<br><em>${esc(p.fix)}</em></div>` : ''}
          </div>`;
      }).join('');

    return `
      <article class="card creative-card">
        <header class="creative-head">
          <h3>${esc(label)}</h3>
          <span class="creative-sub">${d.verdicts.count} ads · fair test ${d.verdicts.threshold ? fmtMoney(d.verdicts.threshold, 0) : '—'}${d.verdicts.overSop ? ` · ${d.verdicts.overSop} over the SOP` : ''}</span>
        </header>
        <div class="brief ${d.brief.urgent ? 'urgent' : ''}">
          <div class="brief-head">📋 ${esc(d.brief.headline)}</div>
          <div class="brief-body">${d.brief.lines.map(l => mdLine(l)).join('')}</div>
          <button class="btn-mini" onclick="copyBrief('${esc(key)}')">Copy brief for the team</button>
        </div>
        <div class="ad-grid">${adCards}</div>
      </article>`;
  }).join('');

  host.innerHTML = `
    <h2 class="section-title">🎬 Creative desk</h2>
    <p class="section-lede">
      Which ads deserve the budget, and what the editors should make next. The retention curve says
      <em>where</em> a video loses people, and each drop has a different cause — an ad that dies at
      3 seconds needs a new opening, not a new offer.
    </p>
    ${blocks}`;

  State._briefs = Object.fromEntries(Object.entries(byCampaign).map(([key, group]) => {
    const campaign = State.campaigns.find(c => c.id === key) || {};
    const { ber } = campaign.id ? berFor(campaign) : { ber: 0 };
    const cpa = campaign.purchases > 0 ? campaign.spend / campaign.purchases : 0;
    const d = CD.desk(VE.productLabel(group.name), group.ads,
      { ber, currency: State.currency, campaignCpa: cpa, fullName: group.name });
    return [key, `${d.brief.headline}\n\n${d.brief.lines.join('\n')}`];
  }));
}

/* The briefs use a little markdown so they can be pasted straight into
   ClickUp without reformatting. */
function mdLine(l) {
  if (!l.trim()) return '<div class="brief-gap"></div>';
  const html = esc(l)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- /, '• ');
  return `<div class="brief-line">${html}</div>`;
}

function copyBrief(key) {
  const text = (State._briefs || {})[key] || '';
  if (!text) return;
  try {
    navigator.clipboard.writeText(text);
    showModal('Brief copied', '<p>Paste it into the ClickUp task for the editors.</p>');
  } catch (e) {
    showModal('Brief', `<pre class="brief-pre">${esc(text)}</pre>`);
  }
}
window.copyBrief = copyBrief;

/* ========================================================================== *
 *  GUARDRAILS
 * ========================================================================== */
function renderGuardrails() {
  const preset = LS.get('meta_date_preset', 'today');

  // Delivery alarms come first — a stopped campaign matters more than a
  // mediocre one.
  const items = VE.deliveryAlarms(State.campaigns, State.adStatuses || [], { dayIsOver: dayIsOver() })
    .concat(VE.guardrails(State.campaigns));

  if (State.accountErrors && State.accountErrors.length) {
    items.unshift({
      severity: 'alert',
      title: `${State.accountErrors.length} ad account could not be read`,
      body: State.accountErrors.join(' · ') + '. The rest of the numbers below exclude it.'
    });
  }

  if (State.live && preset === 'today' && activeWindow() !== 'midnight') {
    items.push({
      severity: 'info',
      title: "Today's numbers are still filling in",
      body: 'Purchases attribute back to the click, so today\'s ROAS reads lower than it will end up. Treat midday numbers as directional — the real decision is the midnight read.'
    });
  }

  if (State.lpvEstimated) {
    items.push({
      severity: 'warning',
      title: 'Landing page views are not being measured',
      body: 'Meta returned no landing_page_view events. The page-speed ratio is shown as "not tracked" rather than a number, because the only number available would be a guess that always passes. Fire the LandingPageView event in Funnelish for a real reading.'
    });
  }
  if (State.droppedFields && State.droppedFields.length) {
    items.push({
      severity: 'info',
      title: 'Meta no longer serves some fields',
      body: `Skipped: ${State.droppedFields.join(', ')}. Everything else synced normally — only the metrics built on those fields are blank.`
    });
  }
  const box = document.getElementById('guardrails');
  box.innerHTML = items.map(i => `
    <div class="guardrail ${i.severity}">
      <strong>${esc(i.title)}</strong>
      <span>${esc(i.body)}</span>
    </div>`).join('');
}

/* ========================================================================== *
 *  KPIs + FUNNEL
 * ========================================================================== */
function totals() {
  return State.campaigns.reduce((a, c) => {
    a.spend += c.spend; a.revenue += c.revenue; a.purchases += c.purchases;
    a.clicks += c.clicks; a.lpv += c.lpv; a.atc += c.atc; a.ic += c.ic;
    a.impressions += c.impressions || 0;
    return a;
  }, { spend: 0, revenue: 0, purchases: 0, clicks: 0, lpv: 0, atc: 0, ic: 0, impressions: 0 });
}

function renderKpis() {
  const t = totals();
  const verified = State.truthStatus && State.truthStatus.state === 'ok';
  // When Shopify is connected, the account headline is the whole order book,
  // not just the part that matched a campaign — otherwise unattributed orders
  // vanish from the top line and the account looks smaller than it is.
  const revenue = verified ? State.truth.net : t.revenue;
  const roas = t.spend > 0 ? revenue / t.spend : 0;
  const ber = State.econ && State.econ.valid ? State.econ.ber : 0;
  const gm = ber ? 1 / ber : 0;
  const contribution = gm ? revenue * gm - t.spend : null;

  document.getElementById('kpi-roas').innerText = roas.toFixed(2);
  const roasSub = document.getElementById('kpi-roas-sub');
  roasSub.innerText = ber ? (roas >= ber ? `Above break-even ${ber.toFixed(2)}` : `Below break-even ${ber.toFixed(2)}`) : 'Set your unit economics';
  roasSub.className = 'kpi-trend ' + (ber ? (roas >= ber ? 'positive' : 'negative') : 'neutral');

  document.getElementById('kpi-total-spend').innerText = fmtMoney(t.spend, 0);
  document.getElementById('kpi-spend-sub').innerText = `${State.campaigns.length} campaign${State.campaigns.length === 1 ? '' : 's'}`;
  document.getElementById('kpi-revenue').innerText = fmtMoney(revenue, 0);
  const revSub = document.getElementById('kpi-revenue-sub');
  revSub.innerText = verified ? 'Shopify, net of refunds' : 'Meta-attributed, unverified';
  revSub.className = 'kpi-trend ' + (verified ? 'positive' : 'neutral');

  /* Profit is the number he actually takes home, so it gets its own tile
     rather than hiding as a sub-line under revenue. It is null whenever the
     unit economics are unset — showing €0 there would read as break-even. */
  const profitEl = document.getElementById('kpi-profit');
  const profitSub = document.getElementById('kpi-profit-sub');
  profitEl.innerText = contribution === null ? '—' : fmtMoney(contribution, 0);
  profitEl.className = 'kpi-value' +
    (contribution === null ? '' : contribution >= 0 ? ' pos' : ' neg');
  profitSub.innerText = contribution === null ? 'Set your unit economics'
    : verified ? `At ${(gm * 100).toFixed(0)}% margin, Shopify revenue`
               : `At ${(gm * 100).toFixed(0)}% margin, Meta revenue`;
  profitSub.className = 'kpi-trend ' + (contribution === null ? 'neutral'
    : contribution >= 0 ? 'positive' : 'negative');

  const orders = verified ? State.truth.orders : t.purchases;
  document.getElementById('kpi-total-purchases').innerText = fmtInt(orders);
  document.getElementById('kpi-orders-sub').innerText = verified ? 'Shopify orders' : 'Meta-reported';

  const cpaEl = document.getElementById('kpi-cpa');
  const cpaSub = document.getElementById('kpi-cpa-sub');
  cpaEl.innerText = orders ? fmtMoney(t.spend / orders) : '—';
  /* A CPA is only good or bad against what an order is worth, so say it. */
  if (orders && revenue) {
    const aov = revenue / orders;
    cpaSub.innerText = `AOV ${fmtMoney(aov)}`;
    const cpa = t.spend / orders;
    cpaSub.className = 'kpi-trend ' + (gm && cpa < aov * gm ? 'positive' : gm ? 'negative' : 'neutral');
  } else {
    cpaSub.innerText = 'Spend ÷ orders';
    cpaSub.className = 'kpi-trend neutral';
  }

  const imps = t.impressions || State.ads.reduce((s, a) => s + (parseInt(a['Impressions']) || 0), 0);
  const clicks = t.clicks || State.ads.reduce((s, a) => s + (parseInt(a['Link Clicks']) || 0), 0);
  document.getElementById('kpi-ctr').innerText = imps ? ((clicks / imps) * 100).toFixed(2) + '%' : '0.00%';

  const vids = State.ads.filter(a => a['Creative Type'] === 'Video');
  const vi = vids.reduce((s, a) => s + (parseInt(a['Impressions']) || 0), 0);
  const v3 = vids.reduce((s, a) => s + (parseInt(a['Video 3s Views']) || 0), 0);
  document.getElementById('kpi-hook-rate').innerText = vi ? ((v3 / vi) * 100).toFixed(1) + '%' : '—';
}

const FUNNEL_NOTES = {
    impossible: 'More page views than clicks. The two counts are not the same people — usually direct or organic traffic landing on the page, or a view that fires twice. Nothing can be concluded from the ratio until that is settled.',
  pageLoad: {
    healthy: 'Clicks are reaching the page. Nothing to fix here.',
    warning: 'Some clicks never load the page. Compress hero images and cut third-party scripts.',
    alert: 'Most clicks never see the page. This is a speed problem, and no budget change fixes it.',
    untracked: 'Not measured. Meta is returning no landing-page-view events, so this ratio cannot be computed. Fire the LandingPageView event in Funnelish.'
  },
    impossible: 'More carts than page views. The counts are measuring different people or different moments, so this says nothing about the offer. Check the events in Funnelish before changing price or creative.',
  offer: {
    healthy: 'People land and add to cart. The offer is working.',
    warning: 'Add-to-cart is soft. Test the price, the hero image and the first screen.',
    alert: 'They look and leave. Price or first screen is wrong — creative is not the problem.',
    untracked: 'Not measured. The add-to-cart event does not fire on these funnels, so a 0% here means nothing about the offer.'
  },
    impossible: 'More checkouts than carts. Checkout is being reached without an add-to-cart event, so this ratio has no denominator you can trust.',
  intent: {
    healthy: 'Carts move into checkout cleanly.',
    warning: 'Some carts stall. Show shipping cost earlier so it is not a surprise.',
    alert: 'Carts are not becoming checkouts. Almost always an unexpected shipping cost.',
    untracked: 'Not measured. Without add-to-cart there is no denominator for this ratio.'
  },
    impossible: 'More purchases than checkouts. Orders are arriving through a path that never fires initiate-checkout — a saved cart, a second device, or a direct link. The percentage is an artefact, not a conversion rate.',
  completion: {
    healthy: 'Checkouts finish. Payment is not blocking anyone.',
    warning: 'Some checkouts drop. Check the mobile layout and trust badges.',
    alert: 'Checkouts start and die. Verify Klarna, PayPal and Stripe are all live.',
    untracked: 'Not measured.'
  }
};

function renderFunnel() {
  const t = totals();
  const f = VE.funnel({ clicks: t.clicks, lpv: t.lpv, atc: t.atc, ic: t.ic, purchases: t.purchases });
  const map = [['ratio-lpv-clicks', 'pageLoad'], ['ratio-atc-lpv', 'offer'], ['ratio-ic-atc', 'intent'], ['ratio-pur-ic', 'completion']];
  const untrackedKeys = {
    pageLoad: State.lpvEstimated,
    offer: State.atcBroken,
    intent: State.atcBroken,
    completion: false
  };

  map.forEach(([prefix, key]) => {
    const d = f[key];
    const bar = document.getElementById(prefix + '-bar');
    const text = document.getElementById(prefix + '-text');
    const badge = document.getElementById(prefix + '-status');
    const note = document.getElementById('note-' + prefix);
    if (!bar) return;

    if (untrackedKeys[key]) {
      bar.style.width = '0%';
      bar.className = 'funnel-bar untracked';
      text.innerText = '—';
      badge.className = 'funnel-status-badge untracked';
      badge.innerText = 'Not tracked';
      note.className = 'funnel-diagnostic-note note-untracked';
      note.innerText = FUNNEL_NOTES[key].untracked;
      return;
    }

    /* A stage cannot convert more than 100% of the stage above it. When it
       reads over 100 the two event counts are not covering the same people or
       the same moment, and every diagnosis drawn from the ratio is worthless.
       Velmira showed 166.7% checkout completion and the dashboard still called
       it a weak offer. Say "can't tell" rather than invent a cause. */
    if (d.value > 100) {
      bar.style.width = '100%';
      bar.className = 'funnel-bar impossible';
      text.innerText = d.value + '%';
      badge.className = 'funnel-status-badge impossible';
      badge.innerText = "Can't tell";
      note.className = 'funnel-diagnostic-note note-impossible';
      note.innerText = FUNNEL_NOTES[key].impossible;
      return;
    }

    const pct = Math.min(100, (d.value / (d.target * 1.4)) * 100);
    bar.style.width = pct + '%';
    bar.className = 'funnel-bar ' + d.status;
    text.innerText = d.value + '%';
    badge.className = 'funnel-status-badge ' + d.status;
    badge.innerText = d.status === 'healthy' ? 'Healthy' : d.status === 'warning' ? 'Watch' : 'Leak';
    note.className = 'funnel-diagnostic-note note-' + d.status;
    note.innerText = FUNNEL_NOTES[key][d.status];
  });
}

/* ========================================================================== *
 *  PLAYBOOK PANEL (live, not static text)
 * ========================================================================== */
function renderPlaybook() {
  const win = activeWindow();
  const cols = { morning: ['ctr', 'cpc', 'cpm', 'lpv'], evening: ['atc', 'ic', 'cpa'], midnight: ['purchases', 'roas', 'cpa', 'frequency'] }[win];
  highlightColumns(cols);

  const counts = {};
  State.campaigns.forEach(c => counts[c.verdict.code] = (counts[c.verdict.code] || 0) + 1);

  const bodies = {
    morning: {
      goal: 'Is the creative buying good clicks, and do those clicks reach the page?',
      checks: [
        ['🔍', 'CTR', 'Above 2%. Below that the hook is weak — change the first frame, not the offer.'],
        ['💰', 'CPC', 'Rising CPC on flat CTR means the auction got harder, not that the ad broke.'],
        ['📣', 'CPM', 'High CPM on a broad audience usually means the creative is being ignored.'],
        ['⚡', 'LPV ÷ Clicks', '70–90%. Under that you are paying for clicks that never see the page.']
      ],
      rule: 'Day 1 at 11:00 — the only day a midday read kills a campaign. From day 2 the midday read is diagnostic only.'
    },
    evening: {
      goal: 'They arrived. Do they want it, and can they buy it?',
      checks: [
        ['🛒', 'ATC ÷ LPV', '5–10%. Under 5% is an offer problem — price, hero, first screen.'],
        ['💳', 'IC ÷ ATC', '30–60%. Under that, shipping cost is showing up too late.'],
        ['✅', 'Purchases ÷ IC', '50%+. Under that, the payment methods or trust block are failing.'],
        ['💸', 'CPA', 'Compare against your contribution per order, not against yesterday.']
      ],
      rule: 'Evening read never changes budget. It tells you what to fix on the page tonight.'
    },
    midnight: {
      goal: 'Scale, keep, descale or kill.',
      checks: [
        ['📈', 'ROAS vs BER', 'Above break-even = it makes money. That is the only definition that counts.'],
        ['💵', 'Contribution margin', 'Over 20% → +35%. 15–20% → +20%. Under 15% → leave it alone.'],
        ['📉', 'Unprofitable', 'Descale 40% and let it re-optimise. Two bad days after two descales → kill.'],
        ['🔄', 'Frequency', `Over ${VE.RULES.frequency.fatigue} means the same people keep seeing it. New creative.`]
      ],
      rule: 'Weekends override this: Saturday and Sunday, ROAS 3+ → ×5, ROAS 5+ → ×10, twice a day. Pull back Sunday night.'
    }
  }[win];

  const actionable = (counts.KILL || 0) + (counts.DESCALE || 0) + (counts.SCALE || 0) + (counts.SURF || 0) + (counts.PRICE_DROP || 0);

  document.getElementById('playbook-content').innerHTML = `
    <div class="playbook-question-box">
      <strong>${esc(bodies.goal)}</strong>
      ${actionable
        ? `${actionable} campaign${actionable === 1 ? '' : 's'} need${actionable === 1 ? 's' : ''} an action right now — see the cards above.`
        : 'Nothing needs an action right now. Read the numbers and leave the budgets alone.'}
    </div>
    <div class="playbook-list">
      ${bodies.checks.map(([icon, name, text]) => `
        <div class="playbook-checklist-item">
          <span>${icon}</span>
          <div><strong>${esc(name)}</strong> — ${esc(text)}</div>
        </div>`).join('')}
    </div>
    <div class="playbook-rule">📖 ${esc(bodies.rule)}</div>`;
}

function highlightColumns(cols) {
  document.querySelectorAll('.ads-table th, .ads-table td').forEach(el => el.classList.remove('highlight-col'));
  (cols || []).forEach(c =>
    document.querySelectorAll(`.ads-table [data-col="${c}"]`).forEach(el => el.classList.add('highlight-col')));
}

/* ========================================================================== *
 *  AD TABLE
 * ========================================================================== */
function setupTableControls() {
  document.getElementById('search-ads').addEventListener('input', renderTable);
  document.getElementById('filter-type').addEventListener('change', renderTable);
}

function sortData(column) {
  if (State.sort.column === column) State.sort.direction = State.sort.direction === 'asc' ? 'desc' : 'asc';
  else { State.sort.column = column; State.sort.direction = 'desc'; }
  renderTable();
}
window.sortData = sortData;

const NUMERIC_COLS = ['Score (1-10)', 'Spend ($)', 'Link CTR (%)', 'CPC ($)', 'CPM ($)', 'Purchases',
  'Purchase ROAS', 'Cost per Purchase', 'Link Clicks', 'Landing Page Views', 'Adds to Cart',
  'Checkouts Initiated', 'Frequency'];

function renderTable() {
  const tbody = document.getElementById('ads-table-body');
  const q = document.getElementById('search-ads').value.toLowerCase();
  const type = document.getElementById('filter-type').value;

  const rows = State.ads.filter(a =>
    ((a['Ad Name'] || '') + (a['Headline'] || '') + (a['Campaign'] || '')).toLowerCase().includes(q) &&
    (type === 'All' || a['Creative Type'] === type));

  rows.sort((a, b) => {
    let x = a[State.sort.column], y = b[State.sort.column];
    if (NUMERIC_COLS.includes(State.sort.column)) { x = parseFloat(x) || 0; y = parseFloat(y) || 0; }
    else { x = String(x || '').toLowerCase(); y = String(y || '').toLowerCase(); }
    return x < y ? (State.sort.direction === 'asc' ? -1 : 1) : x > y ? (State.sort.direction === 'asc' ? 1 : -1) : 0;
  });

  document.querySelectorAll('.ads-table th').forEach(th => {
    const col = (th.getAttribute('onclick') || '').match(/'([^']+)'/);
    const icon = th.querySelector('.sort-icon');
    if (col && icon) icon.innerText = col[1] === State.sort.column ? (State.sort.direction === 'asc' ? '▲' : '▼') : '↕';
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="15" class="empty-cell">No ads match.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(ad => {
    const score = parseInt(ad['Score (1-10)']) || 0;
    const scoreClass = score >= 8 ? 'score-high' : score >= 5 ? 'score-mid' : 'score-low';
    const type = ad['Creative Type'] || 'Image';
    const typeClass = type === 'Video' ? 'badge-video' : type === 'Carousel' ? 'badge-carousel' : 'badge-image';
    const id = ad['Ad ID'];
    const n = (k) => parseFloat(ad[k]) || 0;
    const i = (k) => parseInt(ad[k]) || 0;
    const cpa = n('Cost per Purchase');
    const roas = n('Purchase ROAS');
    const freq = n('Frequency');
    const clicks = i('Link Clicks'), lpv = i('Landing Page Views'), atc = i('Adds to Cart'), ic = i('Checkouts Initiated'), pur = i('Purchases');
    const pct = (a, b) => b > 0 ? ((a / b) * 100).toFixed(1) + '%' : '—';

    const triggers = (ad['Emotional Triggers'] || '').split(',').map(s => s.trim()).filter(s => s && s !== 'None');
    const feedback = (ad['Actionable Feedback'] || '').split('|').map(s => s.trim()).filter(Boolean);

    return `
      <tr id="row-${id}">
        <td><button class="expand-btn" onclick="toggleRowDetails('${id}')">▶</button></td>
        <td><span class="score-badge ${scoreClass}">${score}</span></td>
        <td class="cell-ad">
          <span class="ad-name" onclick="toggleRowDetails('${id}')">${esc(ad['Ad Name'])}</span>
          <div class="ad-sub"><span class="badge ${typeClass}">${esc(type)}</span>${ad['Campaign'] ? ' · ' + esc(ad['Campaign']) : ''}</div>
        </td>
        <td data-col="spend">${fmtMoney(n('Spend ($)'), 0)}</td>
        <td data-col="purchases" class="strong">${pur}</td>
        <td data-col="roas" class="strong ${roas >= 2 ? 'pos' : ''}">${roas.toFixed(2)}</td>
        <td data-col="cpa">${cpa ? fmtMoney(cpa) : '—'}</td>
        <td data-col="cpm">${fmtMoney(n('CPM ($)'))}</td>
        <td data-col="ctr" class="strong">${n('Link CTR (%)').toFixed(2)}%</td>
        <td data-col="cpc">${fmtMoney(n('CPC ($)'))}</td>
        <td data-col="clicks">${fmtInt(clicks)}</td>
        <td data-col="lpv">${State.lpvEstimated ? '—' : fmtInt(lpv)}</td>
        <td data-col="atc">${State.atcBroken ? '—' : fmtInt(atc)}</td>
        <td data-col="ic">${State.atcBroken ? '—' : fmtInt(ic)}</td>
        <td data-col="frequency" class="${freq > VE.RULES.frequency.fatigue ? 'warn' : ''}">${freq.toFixed(2)}</td>
      </tr>
      <tr id="details-${id}" class="details-row">
        <td colspan="15">
          <div class="details-container">
            <div class="details-grid">
              <div class="details-panel">
                <h4>Copy</h4>
                <span class="micro-label">Headline</span>
                <div class="details-headline">${esc(ad['Headline'] || '—')}</div>
                <span class="micro-label">Primary text</span>
                <div class="details-copy">${esc(ad['Primary Text Snippet'] || '—')}</div>
                <div class="triggers-container">${triggers.length ? triggers.map(t => `<span class="trigger-tag active">${esc(t)}</span>`).join('') : '<span class="hint">No trigger words found</span>'}</div>
              </div>
              <div class="details-panel">
                <h4>Funnel for this ad</h4>
                <ul class="feedback-list small">
                  <li class="feedback-item"><span class="feedback-bullet">⚡</span><span>LPV ÷ Clicks — <strong>${State.lpvEstimated ? 'not tracked' : pct(lpv, clicks)}</strong></span></li>
                  <li class="feedback-item"><span class="feedback-bullet">🛒</span><span>ATC ÷ LPV — <strong>${State.atcBroken ? 'not tracked' : pct(atc, lpv)}</strong></span></li>
                  <li class="feedback-item"><span class="feedback-bullet">💳</span><span>IC ÷ ATC — <strong>${State.atcBroken ? 'not tracked' : pct(ic, atc)}</strong></span></li>
                  <li class="feedback-item"><span class="feedback-bullet">✅</span><span>Purchases ÷ IC — <strong>${State.atcBroken ? 'not tracked' : pct(pur, ic)}</strong></span></li>
                </ul>
              </div>
              <div class="details-panel">
                <h4>What to do</h4>
                <ul class="feedback-list">
                  ${feedback.map(f => `<li class="feedback-item"><span class="feedback-bullet">↳</span><span>${esc(f)}</span></li>`).join('')}
                </ul>
              </div>
            </div>
          </div>
        </td>
      </tr>`;
  }).join('');

  highlightColumns({ morning: ['ctr', 'cpc', 'cpm', 'lpv'], evening: ['atc', 'ic', 'cpa'], midnight: ['purchases', 'roas', 'cpa', 'frequency'] }[activeWindow()]);
}

function toggleRowDetails(id) {
  const row = document.getElementById('row-' + id);
  const details = document.getElementById('details-' + id);
  if (!row || !details) return;
  const open = details.classList.contains('show');
  document.querySelectorAll('.details-row').forEach(e => e.classList.remove('show'));
  document.querySelectorAll('.ads-table tbody tr').forEach(e => e.classList.remove('expanded-header'));
  if (!open) { details.classList.add('show'); row.classList.add('expanded-header'); }
}
window.toggleRowDetails = toggleRowDetails;
window.markApplied = markApplied;
window.editBer = editBer;
window.editProductMap = editProductMap;

/* ========================================================================== *
 *  CHARTS
 * ========================================================================== */
function renderCharts() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  const grid = light ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.06)';
  const text = light ? '#1f2937' : '#9ca3af';
  if (typeof Chart === 'undefined') return;

  /* ---- Account trend: 14 days of spend against ROAS -------------------- */
  const byDate = {};
  State.campaigns.forEach(c => (c.series || []).forEach(d => {
    const e = byDate[d.date] = byDate[d.date] || { spend: 0, revenue: 0 };
    e.spend += d.spend; e.revenue += d.revenue;
  }));
  const dates = Object.keys(byDate).sort();

  if (State.charts.trend) State.charts.trend.destroy();
  const ctrend = document.getElementById('trendChart');
  if (ctrend && dates.length > 1) {
    const ber = State.econ && State.econ.valid ? State.econ.ber : null;
    State.charts.trend = new Chart(ctrend.getContext('2d'), {
      data: {
        labels: dates.map(d => d.slice(5)),
        datasets: [
          { type: 'bar', label: `Spend (${sym().trim()})`, data: dates.map(d => byDate[d].spend),
            backgroundColor: 'rgba(99,102,241,.35)', borderColor: 'rgba(99,102,241,.7)', borderWidth: 1, yAxisID: 'ySpend', borderRadius: 3, order: 2 },
          { type: 'line', label: 'ROAS (Meta-reported)', data: dates.map(d => byDate[d].spend > 0 ? byDate[d].revenue / byDate[d].spend : 0),
            borderColor: '#10b981', backgroundColor: '#10b981', borderWidth: 3, pointRadius: 3, tension: .25, yAxisID: 'yRoas', order: 1 },
          ...(ber ? [{ type: 'line', label: `Break-even ${ber.toFixed(2)}`, data: dates.map(() => ber),
            borderColor: '#ef4444', borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, yAxisID: 'yRoas', order: 0 }] : [])
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: text, boxWidth: 12 } } },
        scales: {
          x: { grid: { display: false }, ticks: { color: text, maxRotation: 0, autoSkipPadding: 12 } },
          ySpend: { position: 'left', grid: { color: grid }, ticks: { color: text, callback: v => sym() + v }, beginAtZero: true },
          yRoas: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: text }, beginAtZero: true }
        }
      }
    });
  }

  const top = [...State.ads].sort((a, b) => (parseFloat(b['Spend ($)']) || 0) - (parseFloat(a['Spend ($)']) || 0)).slice(0, 8);

  if (State.charts.cpcCtr) State.charts.cpcCtr.destroy();
  const c1 = document.getElementById('cpcCtrChart');
  if (c1) {
    State.charts.cpcCtr = new Chart(c1.getContext('2d'), {
      type: 'bar',
      data: {
        labels: top.map(a => (a['Ad Name'] || '').length > 22 ? a['Ad Name'].slice(0, 20) + '…' : a['Ad Name']),
        datasets: [
          { label: `CPC (${sym().trim()})`, data: top.map(a => parseFloat(a['CPC ($)']) || 0), backgroundColor: 'rgba(99,102,241,.7)', borderColor: 'rgba(99,102,241,1)', borderWidth: 1.5, yAxisID: 'yCPC', borderRadius: 4 },
          { label: 'CTR (%)', data: top.map(a => parseFloat(a['Link CTR (%)']) || 0), type: 'line', fill: false, borderColor: '#f472b6', backgroundColor: '#f472b6', borderWidth: 3, pointRadius: 4, yAxisID: 'yCTR' }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: text } } },
        scales: {
          x: { grid: { color: grid }, ticks: { color: text } },
          yCPC: { type: 'linear', position: 'left', grid: { color: grid }, ticks: { color: text, callback: v => sym() + v } },
          yCTR: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, ticks: { color: text, callback: v => v + '%' } }
        }
      }
    });
  }

  if (State.charts.spend) State.charts.spend.destroy();
  const c2 = document.getElementById('spendCreativeChart');
  if (c2) {
    const byType = {};
    State.ads.forEach(a => { const t = a['Creative Type'] || 'Other'; byType[t] = (byType[t] || 0) + (parseFloat(a['Spend ($)']) || 0); });
    State.charts.spend = new Chart(c2.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: Object.keys(byType),
        datasets: [{ data: Object.values(byType), backgroundColor: ['rgba(99,102,241,.85)', 'rgba(236,72,153,.85)', 'rgba(20,184,166,.85)', 'rgba(245,158,11,.85)'], borderColor: light ? '#fff' : '#0b0f19', borderWidth: 2 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: text, padding: 14 } },
          tooltip: { callbacks: { label: ctx => {
            const total = ctx.dataset.data.reduce((a, b) => a + b, 0) || 1;
            return `${ctx.label}: ${fmtMoney(ctx.raw, 0)} (${((ctx.raw / total) * 100).toFixed(0)}%)`;
          } } }
        }
      }
    });
  }
}

/* ========================================================================== *
 *  COPY GRADER
 * ========================================================================== */
function setupGrader() {
  const h = document.getElementById('sandbox-headline');
  const p = document.getElementById('sandbox-primary');
  h.value = 'Endlich wieder frei atmen';
  p.value = 'Ich habe drei Wochen lang jeden Abend gehustet. Seit ich das benutze, schlafe ich wieder durch. Meine Frau hat es zuerst gemerkt.';
  [h, p].forEach(el => el.addEventListener('input', runGrader));
  runGrader();
}

function runGrader() {
  const h = document.getElementById('sandbox-headline').value;
  const p = document.getElementById('sandbox-primary').value;
  document.getElementById('char-count-headline').innerText = `${h.length} chars · ${h.trim() ? h.trim().split(/\s+/).length : 0} words`;
  document.getElementById('char-count-primary').innerText = `${p.length} chars`;

  const text = (h + ' ' + p).toLowerCase();
  const triggers = EMOTIONAL_TRIGGERS_LIST.filter(t => text.includes(t));
  const hasCTA = CTA_VERBS_LIST.some(v => new RegExp('\\b' + v, 'i').test(text));
  const hasNumber = /\d/.test(text);
  const words = h.trim() ? h.trim().split(/\s+/).length : 0;
  const sentences = p.split(/[.!?]+/).filter(s => s.trim()).length;
  const firstPerson = /\b(i|my|me|ich|mein|mir|mich)\b/i.test(p);

  let score = 3;
  const notes = [];

  if (words > 0 && words <= 6) { score += 1.5; notes.push(['ok', 'Headline length', `${words} words — inside the 6-word limit.`]); }
  else if (words > 6) notes.push(['bad', 'Headline too long', `${words} words. The rule is max 6 — cut it down.`]);
  else notes.push(['bad', 'No headline', 'Put the offer or the single emotional benefit here.']);

  if (sentences >= 1 && sentences <= 3) { score += 1.5; notes.push(['ok', 'Primary text length', `${sentences} sentence${sentences === 1 ? '' : 's'} — right where it should be.`]); }
  else if (sentences > 3) notes.push(['bad', 'Primary text too long', `${sentences} sentences. Cut to 1–3 or Facebook hides it behind "See more".`]);

  if (firstPerson) { score += 2; notes.push(['ok', 'Written as a personal story', 'First person keeps it compliant — an experience, not a promise.']); }
  else notes.push(['bad', 'Not personal', 'Rewrite as something that happened to a person. "I sleep through the night again" passes review; "helps you sleep" does not.']);

  if (triggers.length >= 2) { score += 1; notes.push(['ok', 'Emotional triggers', triggers.join(', ')]); }
  else notes.push(['bad', 'Flat copy', 'No urgency or emotion words found.']);

  if (hasNumber) { score += 0.5; notes.push(['ok', 'Specifics', 'A number makes it believable.']); }
  if (hasCTA) score += 0.5;

  const claims = /(\d+\s?(kg|kilo|pfund|cm)|heilt|cure|guaranteed results|garantiert)/i.test(p) && !firstPerson;
  if (claims) { score -= 2; notes.push(['bad', 'Policy risk', 'A hard result claim not framed as personal experience. Rephrase as "I lost…", not "You will lose…".']); }

  score = Math.max(1, Math.min(10, score)).toFixed(1);
  const el = document.getElementById('sandbox-grade');
  el.innerText = score;
  el.style.color = score >= 8 ? 'var(--color-success)' : score >= 5.5 ? 'var(--color-warning)' : 'var(--color-danger)';

  document.getElementById('sandbox-active-triggers').innerHTML =
    triggers.length ? triggers.map(t => `<span class="trigger-tag active">${esc(t)}</span>`).join('') : '<span class="hint">None found</span>';

  document.getElementById('sandbox-recommendations').innerHTML = notes.map(([tone, title, body]) =>
    `<div class="grader-note"><span class="bullet-${tone === 'ok' ? 'green' : 'red'}">${tone === 'ok' ? '✔' : '✗'}</span><strong>${esc(title)}:</strong> ${esc(body)}</div>`).join('');
}

/* ========================================================================== *
 *  CSV UPLOAD (fallback path)
 * ========================================================================== */
function handleCsvUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const rows = parseCSV(ev.target.result);
    if (!rows.length) { showModal('Could not read that file', 'The CSV had no rows this dashboard recognises.'); return; }
    State.ads = rows.map(normalizeAd);
    State.campaigns = campaignsFromAds(State.ads);
    State.source = 'csv';
    State.truth = null;
    State.truthStatus = null;
    State.truthMatch = null;
    setApiStatus('offline');
    document.getElementById('brand-sub').innerText = `CSV: ${file.name}`;
    renderAll();
  };
  reader.readAsText(file);
}

function campaignsFromAds(ads) {
  const groups = {};
  ads.forEach(a => {
    const key = a['Campaign'] || 'All ads';
    const g = groups[key] = groups[key] || { id: 'csv-' + key, name: key, status: 'ACTIVE', budget: 0, daysLive: 1,
      spend: 0, revenue: 0, purchases: 0, clicks: 0, lpv: 0, atc: 0, ic: 0, impressions: 0, freqSum: 0, n: 0, history: [] };
    const n = k => parseFloat(a[k]) || 0;
    g.spend += n('Spend ($)');
    g.revenue += n('Spend ($)') * n('Purchase ROAS');
    g.purchases += n('Purchases');
    g.clicks += n('Link Clicks');
    g.lpv += n('Landing Page Views');
    g.atc += n('Adds to Cart');
    g.ic += n('Checkouts Initiated');
    g.impressions += n('Impressions');
    g.freqSum += n('Frequency'); g.n++;
  });
  return Object.values(groups).map(g => ({ ...g, roas: g.spend > 0 ? g.revenue / g.spend : 0, frequency: g.n ? g.freqSum / g.n : 0 }));
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = splitCsvLine(line);
    const o = {};
    headers.forEach((h, i) => o[h] = (vals[i] || '').replace(/^"|"$/g, ''));
    return o;
  });
}

function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/* ========================================================================== *
 *  MODAL HELPER
 * ========================================================================== */
function showModal(title, html) {
  const old = document.getElementById('info-modal');
  if (old) old.remove();
  const el = document.createElement('div');
  el.id = 'info-modal';
  el.className = 'modal-overlay show';
  el.innerHTML = `
    <div class="modal-card card">
      <div class="modal-header"><h3>${esc(title)}</h3><button class="modal-close-btn">&times;</button></div>
      <div class="modal-body info-modal-body">${html}</div>
      <div class="modal-footer"><button class="btn btn-primary full" data-dismiss="1">OK</button></div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', ev => {
    if (ev.target === el || ev.target.classList.contains('modal-close-btn') || ev.target.dataset.dismiss) el.remove();
  });
}

/* ========================================================================== *
 *  STYLES for the pieces this file adds
 * ========================================================================== */
function injectStyles() {
  if (document.getElementById('truth-styles')) return;
  const s = document.createElement('style');
  s.id = 'truth-styles';
  s.textContent = `
  /* Profit and cost-per-purchase are their own tiles now, so they need the
     accent and the sign colouring that style.css only defines for the two
     tiles that existed before. */
  .kpi-card.accent-green { border-left: 4px solid var(--color-success, #10b981); }
  .kpi-value.pos { color: var(--color-success, #10b981); }
  .kpi-value.neg { color: var(--color-danger, #ef4444); }

  /* A funnel stage reading over 100% is neither good nor bad — it is
     unreadable. Amber-striped so it cannot be mistaken for either. */
  .funnel-bar.impossible { background: repeating-linear-gradient(45deg,
      var(--color-warning, #f59e0b), var(--color-warning, #f59e0b) 6px,
      transparent 6px, transparent 12px); opacity: .75; }
  .funnel-status-badge.impossible { background: rgba(245,158,11,.15);
      color: var(--color-warning, #f59e0b); border: 1px solid rgba(245,158,11,.35); }
  .note-impossible { color: var(--color-warning, #f59e0b); }

  /* Account tabs — style.css predates them, so they are defined here. */
  .account-tab-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .9rem;
    padding: .55rem 0 .7rem; }
  .acct-tabs { display: flex; flex-wrap: wrap; gap: .4rem; }
  .acct-tab { padding: .32rem .8rem; border-radius: 999px; font-size: 13px; cursor: pointer;
    border: 1px solid var(--color-border, rgba(255,255,255,.14));
    background: transparent; color: inherit; opacity: .65; transition: opacity .12s, background .12s; }
  .acct-tab:hover { opacity: .9; }
  .acct-tab.active { opacity: 1; font-weight: 600;
    background: var(--accent-secondary, #8b5cf6); border-color: transparent; color: #fff; }
  .acct-hint { font-size: 12px; opacity: .6; }
  .acct-hint.acct-hint-warn { color: var(--color-warning, #f59e0b); opacity: 1; }

  /* Date bar — style.css predates it too. */
  .date-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
    gap: .6rem 1rem; padding: .7rem .9rem; margin: 0 0 .5rem; }
  .date-bar-left, .date-bar-right { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
  .date-presets { display: flex; flex-wrap: wrap; gap: .35rem; }
  .date-btn { padding: .3rem .7rem; border-radius: 8px; font-size: 12.5px; cursor: pointer;
    border: 1px solid var(--color-border, rgba(255,255,255,.14));
    background: transparent; color: inherit; opacity: .7; transition: opacity .12s, background .12s; }
  .date-btn:hover { opacity: 1; }
  .date-btn.active { opacity: 1; font-weight: 600; color: #fff;
    background: var(--accent-secondary, #8b5cf6); border-color: transparent; }
  .date-btn-nav { font-size: 16px; line-height: 1; padding: .22rem .6rem; }
  .date-input { padding: .26rem .5rem; border-radius: 8px; font-size: 12.5px;
    background: transparent; color: inherit;
    border: 1px solid var(--color-border, rgba(255,255,255,.18)); }
  .date-sep { opacity: .5; font-size: 12px; }
  .date-note { font-size: 12.5px; opacity: .72; margin: 0 0 .85rem; }
  @media (max-width: 760px) { .date-bar { flex-direction: column; align-items: stretch; } }

  /* Data strip */
  #data-strip { margin: 0 0 .85rem; }
  .dstrip { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem;
    padding: .6rem .9rem; border-radius: 10px; font-size: 13px;
    border: 1px solid var(--color-border, rgba(255,255,255,.1));
    background: var(--color-surface, rgba(255,255,255,.03)); }
  .dstrip.running { border-left: 4px solid var(--color-warning, #f59e0b); }
  .dstrip-dates strong { font-variant-numeric: tabular-nums; }
  .dstrip-tz { opacity: .6; margin-left: .35rem; font-size: 12px; }
  .dstrip-flag { color: var(--color-warning, #f59e0b); }
  .dstrip-flag.done { color: var(--color-success, #10b981); }
  .dstrip-src { margin-left: auto; opacity: .7; font-size: 12px; }
  .dstrip-src em { color: var(--color-danger, #ef4444); font-style: normal; }
  @media (max-width: 760px) { .dstrip-src { margin-left: 0; } }

  #truth-panel { margin: 0 0 1rem; }
  .truth-card { border-radius: 12px; padding: 1rem 1.15rem; border: 1px solid var(--color-border, rgba(255,255,255,.1));
    background: var(--color-surface, rgba(255,255,255,.03)); }
  .truth-card.ok   { border-left: 4px solid var(--color-success, #10b981); }
  .truth-card.bad  { border-left: 4px solid var(--color-danger, #ef4444); }
  .truth-card.off  { border-left: 4px solid var(--color-warning, #f59e0b); }
  .truth-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: .6rem; flex-wrap: wrap; }
  .truth-chip { font-size: .72rem; padding: .2rem .5rem; border-radius: 99px; white-space: nowrap;
    background: rgba(148,163,184,.18); }
  .truth-chip.ok   { background: rgba(16,185,129,.18); color: #10b981; }
  .truth-chip.warn { background: rgba(245,158,11,.18); color: #f59e0b; }
  .truth-grid { display: flex; flex-wrap: wrap; gap: 1.4rem; margin: .5rem 0 .75rem; }
  .truth-grid > div { display: flex; flex-direction: column; }
  .truth-big { font-size: 1.35rem; font-weight: 650; line-height: 1.1; }
  .truth-big.bad { color: var(--color-danger, #ef4444); }
  .truth-cap { font-size: .7rem; opacity: .65; margin-top: .15rem; }
  .truth-foot { font-size: .78rem; opacity: .75; margin: .2rem 0 0; line-height: 1.5; }
  .truth-warnings { margin: .7rem 0 0; padding-left: 1.1rem; font-size: .8rem; line-height: 1.55; }
  .truth-warnings li { margin-bottom: .4rem; }

  .rev-line { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap;
    font-size: .78rem; padding: .4rem .6rem; border-radius: 8px; margin-bottom: .5rem; }
  .rev-line.verified   { background: rgba(16,185,129,.1); }
  .rev-line.unverified { background: rgba(245,158,11,.12); }
  .rev-line.demo       { background: rgba(148,163,184,.12); }
  .rev-badge { font-weight: 650; white-space: nowrap; }
  .rev-badge.ok   { color: #10b981; }
  .rev-badge.warn { color: #f59e0b; }
  .lock-chip { font-size: .68rem; opacity: .9; margin-left: .35rem; white-space: nowrap; }

  .evidence-line { margin: 0 0 .5rem; }
  .eq { font-size: .72rem; padding: .22rem .55rem; border-radius: 99px; display: inline-block; }
  .eq.ok   { background: rgba(16,185,129,.14); color: #10b981; }
  .eq.thin { background: rgba(245,158,11,.14); color: #f59e0b; }
  .eq.none { background: rgba(148,163,184,.16); color: #94a3b8; }
  .vstat-cap .ci { opacity: .6; font-variant-numeric: tabular-nums; }

  .fchip.untracked { background: rgba(148,163,184,.16) !important; color: #94a3b8 !important;
    border-color: transparent !important; font-style: italic; }
  .funnel-bar.untracked { background: rgba(148,163,184,.3) !important; }
  .funnel-status-badge.untracked { background: rgba(148,163,184,.18); color: #94a3b8; }
  .note-untracked { opacity: .7; font-style: italic; }
  .verdict-reasons li.conflict { color: var(--color-warning, #f59e0b); }

  .truth-settings { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--color-border, rgba(255,255,255,.1)); }
  .truth-settings h4 { margin: 0 0 .35rem; display: flex; align-items: center; gap: .5rem; }
  .truth-pill { font-size: .65rem; font-weight: 500; padding: .15rem .45rem; border-radius: 99px;
    background: rgba(16,185,129,.18); color: #10b981; }
  .truth-help { font-size: .78rem; opacity: .75; line-height: 1.5; margin: 0 0 .75rem; }
  .truth-settings label { display: block; font-size: .78rem; margin-bottom: .6rem; }
  .truth-settings input { width: 100%; margin-top: .25rem; }
  .truth-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
  .truth-test { font-size: .78rem; margin-top: .6rem; line-height: 1.5; }
  .truth-test.ok  { color: #10b981; }
  .truth-test.bad { color: #ef4444; }
  .truth-test-list { margin-top: .4rem; opacity: .8; font-size: .74rem; }

  .map-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
  .map-table td { padding: .5rem .4rem; border-bottom: 1px solid var(--color-border, rgba(255,255,255,.08)); vertical-align: top; }
  .map-table select { width: 100%; }
  .map-sub { font-size: .7rem; opacity: .65; margin-top: .15rem; }
  .map-foot { margin-top: 1rem; }

  /* ---- creative desk ---- */
  .creative-card { margin-bottom: 1rem; }
  .creative-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: .6rem; }
  .creative-head h3 { margin: 0; }
  .creative-sub { font-size: .75rem; opacity: .65; }
  .brief { border-radius: 10px; padding: .8rem 1rem; margin-bottom: .9rem;
    background: rgba(99,102,241,.1); border-left: 3px solid rgba(99,102,241,.7); }
  .brief.urgent { background: rgba(239,68,68,.1); border-left-color: var(--color-danger, #ef4444); }
  .brief-head { font-weight: 650; margin-bottom: .5rem; }
  .brief-line { font-size: .82rem; line-height: 1.6; }
  .brief-gap { height: .5rem; }
  .brief .btn-mini { margin-top: .7rem; }
  .brief-pre { white-space: pre-wrap; font-size: .78rem; }

  .ad-grid { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
  .ad-card { border-radius: 10px; padding: .7rem .85rem;
    background: var(--color-surface, rgba(255,255,255,.03));
    border: 1px solid var(--color-border, rgba(255,255,255,.08)); }
  .ad-card.tone-danger  { border-left: 3px solid var(--color-danger, #ef4444); }
  .ad-card.tone-success { border-left: 3px solid var(--color-success, #10b981); }
  .ad-card.tone-warning { border-left: 3px solid var(--color-warning, #f59e0b); }
  .ad-head { display: flex; justify-content: space-between; gap: .5rem; align-items: flex-start; }
  .ad-head strong { font-size: .84rem; line-height: 1.3; }
  .ad-chip { font-size: .68rem; padding: .15rem .45rem; border-radius: 99px; white-space: nowrap; }
  .ad-chip.success { background: rgba(16,185,129,.18); color: #10b981; }
  .ad-chip.danger  { background: rgba(239,68,68,.18);  color: #ef4444; }
  .ad-chip.warning { background: rgba(245,158,11,.18); color: #f59e0b; }
  .ad-chip.neutral { background: rgba(148,163,184,.18); color: #94a3b8; }
  .ad-nums { font-size: .76rem; opacity: .75; margin: .3rem 0; }
  .ad-why  { font-size: .76rem; line-height: 1.5; margin-bottom: .5rem; }

  .ret { display: flex; align-items: flex-end; gap: 3px; height: 54px; margin: .4rem 0 .2rem; }
  .ret-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end;
    align-items: center; height: 100%; position: relative; }
  .ret-fill { width: 100%; background: linear-gradient(180deg, rgba(99,102,241,.85), rgba(99,102,241,.35));
    border-radius: 2px 2px 0 0; }
  .ret-lab { font-size: .6rem; opacity: .55; margin-top: 2px; }
  .ret-val { font-size: .58rem; opacity: .4; }
  .ret-cap { font-size: .7rem; opacity: .6; margin-bottom: .45rem; }

  .ad-stages { display: flex; flex-wrap: wrap; gap: .25rem; margin-bottom: .45rem; }
  .schip { font-size: .64rem; padding: .12rem .4rem; border-radius: 4px; background: rgba(148,163,184,.14); }
  .schip.healthy { background: rgba(16,185,129,.16); color: #10b981; }
  .schip.warning { background: rgba(245,158,11,.16); color: #f59e0b; }
  .schip.alert   { background: rgba(239,68,68,.16);  color: #ef4444; }
  .schip.untracked { opacity: .45; font-style: italic; }
  .ad-fix { font-size: .74rem; line-height: 1.5; padding-top: .45rem;
    border-top: 1px solid var(--color-border, rgba(255,255,255,.07)); }
  `;
  document.head.appendChild(s);
}

/* ========================================================================== *
 *  RENDER ALL
 * ========================================================================== */
function renderAll() {
  computeVerdicts();
  renderCommandBar();
  renderDateBar();
  renderDataStrip();
  renderTruthPanel();
  renderVerdicts();
  renderCreativeDesk();
  renderGuardrails();
  renderKpis();
  renderFunnel();
  renderTable();
  renderPlaybook();
  renderCharts();
}

/* ========================================================================== *
 *  DEMO DATA — exercises every branch of the rule engine
 * ========================================================================== */
function buildDemoData() {
  const day = i => {
    const d = new Date(); d.setDate(d.getDate() - i);
    return d.toISOString().slice(0, 10);
  };
  const hist = (arr) => arr.map((roas, i) => ({
    date: day(arr.length - i), spend: 100, revenue: 100 * roas, roas
  }));
  const withSeries = c => ({
    ...c,
    series: [...(c.history || []), { date: day(0), spend: c.spend, revenue: c.revenue, roas: c.spend > 0 ? c.revenue / c.spend : 0 }]
  });

  const campaigns = [
    { id: 'c1', name: 'AtemFrei | 1.50 | 67', status: 'ACTIVE', budget: 100, daysLive: 4, learning: true,
      spend: 104.20, revenue: 302.18, purchases: 11, clicks: 640, lpv: 552, atc: 41, ic: 19,
      impressions: 41000, frequency: 1.32, history: hist([1.9, 2.4, 2.7]) },

    { id: 'c2', name: 'Celsior | 1.60 | 62', status: 'ACTIVE', budget: 50, daysLive: 1,
      spend: 43.90, revenue: 0, purchases: 0, clicks: 310, lpv: 268, atc: 5, ic: 1,
      impressions: 22000, frequency: 1.08, history: [] },

    { id: 'c3', name: 'ErdKraft | 1.80 | 56', status: 'ACTIVE', budget: 150, daysLive: 5,
      spend: 152.40, revenue: 185.90, purchases: 4, clicks: 720, lpv: 401, atc: 44, ic: 12,
      impressions: 68000, frequency: 2.71, history: hist([2.1, 1.4, 1.2, 1.5]) },

    { id: 'c4', name: 'HautGlenz | 1.50 | 67', status: 'ACTIVE', budget: 200, daysLive: 7,
      spend: 198.75, revenue: 407.44, purchases: 14, clicks: 890, lpv: 762, atc: 62, ic: 26,
      impressions: 74000, frequency: 1.91, history: hist([2.2, 2.05, 2.1, 2.0, 2.15, 2.05]) }
  ].map(c => withSeries({ ...c, roas: c.spend > 0 ? c.revenue / c.spend : 0, metaRevenue: c.revenue, metaRoas: c.spend > 0 ? c.revenue / c.spend : 0, metaPurchases: c.purchases }));

  const ads = [
    { 'Ad Name': 'AtemFrei | UGC Husten Hook', 'Campaign': 'AtemFrei', 'Creative Type': 'Video', 'Hook Rate (%)': '31.40',
      'Link CTR (%)': '2.35', 'Spend ($)': '58.20', 'Reach': '19000', 'Headline': 'Endlich wieder durchschlafen',
      'Primary Text Snippet': 'Ich habe drei Wochen lang jede Nacht gehustet. Seit ich das benutze, schlafe ich wieder durch.',
      'CPM ($)': '2.55', 'CPC ($)': '0.16', 'Impressions': '22800', 'Link Clicks': '360', 'Landing Page Views': '312',
      'Adds to Cart': '24', 'Checkouts Initiated': '11', 'Purchases': '7', 'Purchase ROAS': '3.02', 'Cost per Purchase': '8.31',
      'Frequency': '1.28', 'Video 3s Views': '7160', 'Thruplay Views': '2410', 'Ad ID': 'a1', 'Creative ID': 'cr1' },

    { 'Ad Name': 'AtemFrei | Statisch Vorher-Nachher', 'Campaign': 'AtemFrei', 'Creative Type': 'Image', 'Hook Rate (%)': '0',
      'Link CTR (%)': '1.62', 'Spend ($)': '46.00', 'Reach': '15500', 'Headline': 'Frei atmen ab heute',
      'Primary Text Snippet': 'Meine Frau hat den Unterschied zuerst gemerkt. Nach zwei Wochen war das nächtliche Husten weg.',
      'CPM ($)': '2.52', 'CPC ($)': '0.16', 'Impressions': '18200', 'Link Clicks': '280', 'Landing Page Views': '240',
      'Adds to Cart': '17', 'Checkouts Initiated': '8', 'Purchases': '4', 'Purchase ROAS': '2.44', 'Cost per Purchase': '11.50',
      'Frequency': '1.36', 'Video 3s Views': '0', 'Thruplay Views': '0', 'Ad ID': 'a2', 'Creative ID': 'cr2' },

    { 'Ad Name': 'Celsior | Leggings Split', 'Campaign': 'Celsior', 'Creative Type': 'Video', 'Hook Rate (%)': '12.10',
      'Link CTR (%)': '1.41', 'Spend ($)': '43.90', 'Reach': '20400', 'Headline': 'Sofort schlanker aussehen',
      'Primary Text Snippet': 'Die Leggings die alles glättet. Jetzt 50% Rabatt.',
      'CPM ($)': '2.00', 'CPC ($)': '0.14', 'Impressions': '22000', 'Link Clicks': '310', 'Landing Page Views': '268',
      'Adds to Cart': '5', 'Checkouts Initiated': '1', 'Purchases': '0', 'Purchase ROAS': '0', 'Cost per Purchase': '',
      'Frequency': '1.08', 'Video 3s Views': '2662', 'Thruplay Views': '640', 'Ad ID': 'a3', 'Creative ID': 'cr3' },

    { 'Ad Name': 'ErdKraft | Grounding Matte Demo', 'Campaign': 'ErdKraft', 'Creative Type': 'Video', 'Hook Rate (%)': '22.80',
      'Link CTR (%)': '1.06', 'Spend ($)': '152.40', 'Reach': '25100', 'Headline': 'Schlaf wie mit 25',
      'Primary Text Snippet': 'Seit ich auf der Matte schlafe, wache ich nicht mehr um drei Uhr auf. Ich hätte nicht gedacht dass es funktioniert.',
      'CPM ($)': '2.24', 'CPC ($)': '0.21', 'Impressions': '68000', 'Link Clicks': '720', 'Landing Page Views': '401',
      'Adds to Cart': '44', 'Checkouts Initiated': '12', 'Purchases': '4', 'Purchase ROAS': '1.22', 'Cost per Purchase': '38.10',
      'Frequency': '2.71', 'Video 3s Views': '15504', 'Thruplay Views': '3900', 'Ad ID': 'a4', 'Creative ID': 'cr4' },

    { 'Ad Name': 'HautGlenz | Glow Oil Ritual', 'Campaign': 'HautGlenz', 'Creative Type': 'Video', 'Hook Rate (%)': '28.60',
      'Link CTR (%)': '2.11', 'Spend ($)': '198.75', 'Reach': '38700', 'Headline': 'Meine Haut nach 14 Tagen',
      'Primary Text Snippet': 'Ich habe jahrelang teure Cremes probiert. Das hier war das erste das meine Freundinnen bemerkt haben.',
      'CPM ($)': '2.69', 'CPC ($)': '0.22', 'Impressions': '74000', 'Link Clicks': '890', 'Landing Page Views': '762',
      'Adds to Cart': '62', 'Checkouts Initiated': '26', 'Purchases': '14', 'Purchase ROAS': '2.05', 'Cost per Purchase': '14.20',
      'Frequency': '1.91', 'Video 3s Views': '21164', 'Thruplay Views': '6800', 'Ad ID': 'a5', 'Creative ID': 'cr5' }
  ].map(normalizeAd);

  return { campaigns, ads };
}
