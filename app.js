/* ==========================================================================
   CGO Media Buyer — Verdict Dashboard
   App layer: settings, Meta Graph API, rendering. The decision logic lives
   in rules.js (VerdictEngine) and is unit-tested separately.
   ========================================================================== */

const VE = window.VerdictEngine;

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
  lpvEstimated: false,
  accountTz: null,      // ad account timezone — the only clock the daily rules mean anything against
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
  initTheme();
  loadEconomics();
  setupModals();
  setupWindowTabs();
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

/* ========================================================================== *
 *  UNIT ECONOMICS
 * ========================================================================== */
function loadEconomics() {
  const saved = LS.json('cgo_econ', { price: 29.95, cogs: 7, shipping: 2, feePct: 3 });
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
      <div><span class="econ-big">${fmtMoney(e.contribution)}</span><span class="econ-cap">Profit per order before ads</span></div>
    </div>
    <p class="econ-note">
      Name campaigns <code>Product | ${e.ber.toFixed(2)} | ${e.grossMarginPct}</code> and every verdict reads it automatically.
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
    LS.set('cgo_econ', JSON.stringify(inputs));
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
    LS.set('meta_access_token', tok);
    LS.set('meta_date_preset', dateEl.value);
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

/* Ban prevention means several small ad accounts, so the dashboard reads all
   of them and shows one merged picture. */
function accountIds() {
  const raw = LS.get('meta_account_ids', '') || LS.get('meta_account_id', '');
  return raw.split(/[\s,;]+/).filter(Boolean)
    .map(a => (a.startsWith('act_') ? a : 'act_' + a));
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

const AD_FIELDS = [
  'ad_id', 'ad_name', 'campaign_name', 'spend', 'impressions', 'reach', 'frequency',
  'inline_link_clicks', 'inline_link_click_ctr', 'cost_per_inline_link_click',
  'cpc', 'cpm', 'ctr', 'actions', 'action_values', 'purchase_roas',
  'video_play_actions', 'video_thruplay_watched_actions'
].join(',');

async function fetchAccount(acc, preset) {
  const [account, campaigns, adsets, judged, history, adInsights, adsMeta] = await Promise.all([
    graph(acc, { fields: 'name,currency,timezone_name' }),
    graph(`${acc}/campaigns`, { fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,created_time', limit: 200 }),
    graph(`${acc}/adsets`, { fields: 'id,campaign_id,daily_budget,effective_status,learning_stage_info', limit: 300 }),
    // the window being judged, aggregated by Meta — not summed by us
    graph(`${acc}/insights`, { level: 'campaign', fields: CAMPAIGN_FIELDS, date_preset: preset, limit: 200 }),
    // history for sparklines and streaks (ends yesterday, which is what we want)
    graph(`${acc}/insights`, { level: 'campaign', fields: 'campaign_id,spend,actions,action_values,purchase_roas', date_preset: 'last_30d', time_increment: 1, limit: 800 }),
    graph(`${acc}/insights`, { level: 'ad', fields: AD_FIELDS, date_preset: preset, limit: 300 }),
    graph(`${acc}/ads`, { fields: 'id,name,campaign_id,effective_status,creative{id,title,body,object_type}', limit: 300 })
  ]);

  const built = buildFromApi({
    campaigns: campaigns.data || [], adsets: adsets.data || [],
    judged: judged.data || [], history: history.data || [],
    adInsights: adInsights.data || [], adsMeta: adsMeta.data || [], preset,
    accountId: acc, accountName: account.name || acc
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

    if (!State.campaigns.length) {
      setApiStatus('offline');
      showModal('Connected, but no spend found', `The ${accounts.length === 1 ? 'account' : 'accounts'} answered fine, but there is no campaign data for <strong>${preset.replace(/_/g, ' ')}</strong>. Pick a wider window in the Meta API panel, or wait until spend starts.`);
      loadDemoFallback();
      return;
    }

    State.accountTz = (ok[0] && ok[0].account && ok[0].account.timezone_name) || null;
    setApiStatus('online', `Live · ${accountClock()}`);
    document.getElementById('brand-sub').innerText = ok.length === 1
      ? `${ok[0].account.name || acc} · ${State.currency} · ${ok[0].account.timezone_name || ''}`
      : `${ok.length} ad accounts · ${State.currency}`;
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
  renderAll();
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

function buildFromApi({ campaigns, adsets, judged, history, adInsights, adsMeta, preset, accountId, accountName }) {
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

    return normalizeAd({
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
  if (lpv && atc < lpv * 0.05) fb.push('Add-to-cart under 5% — offer or price problem, not a creative problem.');
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
function actionLog() { return LS.json('cgo_action_log', {}); }
function saveActionLog(l) { LS.set('cgo_action_log', JSON.stringify(l)); }

function berFor(campaign) {
  const parsed = VE.parseCampaignName(campaign.name);
  const override = LS.json('cgo_ber_overrides', {})[campaign.id];
  const ber = override || parsed.ber || (State.econ && State.econ.valid ? State.econ.ber : 0);
  return {
    ber,
    grossMargin: ber > 0 ? 1 / ber : 0,
    source: override ? 'override' : parsed.ber ? 'name' : (State.econ && State.econ.valid ? 'economics' : 'none')
  };
}

function computeVerdicts() {
  const now = new Date();
  const ctxDay = VE.dayContext(now, State.accountTz);
  const win = activeWindow();
  const log = actionLog();

  State.campaigns.forEach(c => {
    const { ber, grossMargin, source } = berFor(c);
    const entry = log[c.id] || {};
    c.descaleCount = entry.descaleCount || 0;
    c.profitableStreak = VE.countProfitableStreak(c.history, ber);
    c.berSource = source;
    c.surfedRecently = ['SURF', 'SCALE'].includes(entry.lastCode) && daysAgo(entry.last) <= 2;
    c.verdict = VE.verdict(c, {
      ber, grossMargin, window: win,
      isSaturday: ctxDay.isSaturday, isSunday: ctxDay.isSunday,
      learning: c.learning,
      currency: State.currency
    });
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
           aria-label="ROAS over the last ${days.length} days, ending at ${last.roas.toFixed(2)} against break-even ${ber.toFixed(2)}">
        <path class="spark-area" d="${area}"/>
        <line class="spark-ber" x1="${pad}" x2="${W - pad}" y1="${berY}" y2="${berY}"/>
        <path class="spark-line" d="${line}"/>
        <circle class="spark-dot" cx="${x(days.length - 1).toFixed(1)}" cy="${y(last.roas).toFixed(1)}" r="3"/>
      </svg>
      <span class="spark-cap">${days.length}d ROAS · dashed line is break-even · ${drift >= 0 ? '+' : ''}${drift}% since day one</span>
    </div>`;
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

    return `
      <article class="card verdict-card tone-${v.tone}">
        <header class="verdict-head">
          <div class="verdict-name">
            <h3>${esc(VE.productLabel(c.name))}</h3>
            <span class="verdict-fullname" title="${esc(c.name)}">${esc(c.name)}</span>
            <span class="verdict-meta">Day ${m.daysLive} · ${esc(c.status || '—')}${c.learning ? ' · <b class="learning-chip">learning</b>' : ''}${State.multiAccount && c.accountName ? ' · ' + esc(c.accountName) : ''}</span>
          </div>
          <div class="verdict-badge tone-${v.tone}">${VERDICT_ICON[v.code] || ''} ${esc(v.headline)}</div>
        </header>

        ${budgetLine}

        <div class="verdict-stats">
          <div class="vstat tone-${roasTone}"><span class="vstat-val">${m.roas.toFixed(2)}</span><span class="vstat-cap">ROAS</span></div>
          <div class="vstat"><span class="vstat-val">${m.ber ? m.ber.toFixed(2) : '—'}</span><span class="vstat-cap">BER</span></div>
          <div class="vstat tone-${marginTone}"><span class="vstat-val">${m.marginPct > -100 ? m.marginPct + '%' : '—'}</span><span class="vstat-cap">Margin</span></div>
          <div class="vstat"><span class="vstat-val">${fmtMoney(m.spend, 0)}</span><span class="vstat-cap">Spent</span></div>
          <div class="vstat"><span class="vstat-val">${m.purchases}</span><span class="vstat-cap">Sales</span></div>
          <div class="vstat ${m.frequency > VE.RULES.frequency.fatigue ? 'tone-warning' : ''}"><span class="vstat-val">${m.frequency.toFixed(2)}</span><span class="vstat-cap">Freq</span></div>
        </div>

        ${sparkline(c.series, m.ber)}

        <ul class="verdict-reasons">
          ${v.reasons.map(r => `<li>${esc(r)}</li>`).join('')}
          ${v.notes.map(n => `<li class="note">${esc(n)}</li>`).join('')}
          ${m.cpa && m.maxCpa ? `<li class="${m.cpa <= m.maxCpa ? 'note' : ''}">CPA ${fmtMoney(m.cpa)} against a break-even CPA of ${fmtMoney(m.maxCpa)}${m.cpa > m.maxCpa ? ' — you are paying more per order than an order is worth.' : '.'}</li>` : ''}
          ${m.pacingPct !== null && m.pacingPct < 70 && c.budget ? `<li class="note">Spent only ${m.pacingPct}% of the ${fmtMoney(c.budget, 0)} budget — the auction cannot fill it.</li>` : ''}
        </ul>

        <div class="verdict-funnel">
          ${['pageLoad', 'offer', 'intent', 'completion'].map(k => `
            <span class="fchip ${v.funnel[k].status}" title="target ${v.funnel[k].target}%+">
              ${({ pageLoad: 'Speed', offer: 'Offer', intent: 'Intent', completion: 'Close' })[k]} ${v.funnel[k].value}%
            </span>`).join('')}
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
  const overrides = LS.json('cgo_ber_overrides', {});
  const n = parseFloat(String(val).replace(',', '.'));
  if (!val.trim() || !(n > 0)) delete overrides[id]; else overrides[id] = n;
  LS.set('cgo_ber_overrides', JSON.stringify(overrides));
  renderAll();
}

/* ========================================================================== *
 *  GUARDRAILS
 * ========================================================================== */
function renderGuardrails() {
  const preset = LS.get('meta_date_preset', 'today');
  const dayIsOver = activeWindow() === 'midnight' || preset === 'yesterday';

  // Delivery alarms come first — a stopped campaign matters more than a
  // mediocre one.
  const items = VE.deliveryAlarms(State.campaigns, State.adStatuses || [], { dayIsOver })
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
      severity: 'info',
      title: 'Landing page views are estimated',
      body: 'Meta returned no landing_page_view events, so LPV is estimated at 82% of link clicks. Fire the LandingPageView event in Funnelish for a real page-speed reading.'
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
  const roas = t.spend > 0 ? t.revenue / t.spend : 0;
  const ber = State.econ && State.econ.valid ? State.econ.ber : 0;
  const gm = ber ? 1 / ber : 0;
  const profit = gm ? t.revenue * gm - t.spend : null;

  document.getElementById('kpi-roas').innerText = roas.toFixed(2);
  const roasSub = document.getElementById('kpi-roas-sub');
  roasSub.innerText = ber ? (roas >= ber ? `Above break-even ${ber.toFixed(2)}` : `Below break-even ${ber.toFixed(2)}`) : 'Set your unit economics';
  roasSub.className = 'kpi-trend ' + (ber ? (roas >= ber ? 'positive' : 'negative') : 'neutral');

  document.getElementById('kpi-total-spend').innerText = fmtMoney(t.spend, 0);
  document.getElementById('kpi-spend-sub').innerText = `${State.campaigns.length} campaign${State.campaigns.length === 1 ? '' : 's'}`;
  document.getElementById('kpi-revenue').innerText = fmtMoney(t.revenue, 0);
  const profitEl = document.getElementById('kpi-profit-sub');
  profitEl.innerText = profit === null ? 'Profit —' : `Profit ${fmtMoney(profit, 0)}`;
  profitEl.className = 'kpi-trend ' + (profit === null ? 'neutral' : profit >= 0 ? 'positive' : 'negative');

  document.getElementById('kpi-total-purchases').innerText = fmtInt(t.purchases);
  document.getElementById('kpi-cpa-sub').innerText = t.purchases ? `CPA ${fmtMoney(t.spend / t.purchases)}` : 'CPA —';

  const imps = t.impressions || State.ads.reduce((s, a) => s + (parseInt(a['Impressions']) || 0), 0);
  const clicks = t.clicks || State.ads.reduce((s, a) => s + (parseInt(a['Link Clicks']) || 0), 0);
  document.getElementById('kpi-ctr').innerText = imps ? ((clicks / imps) * 100).toFixed(2) + '%' : '0.00%';

  const vids = State.ads.filter(a => a['Creative Type'] === 'Video');
  const vi = vids.reduce((s, a) => s + (parseInt(a['Impressions']) || 0), 0);
  const v3 = vids.reduce((s, a) => s + (parseInt(a['Video 3s Views']) || 0), 0);
  document.getElementById('kpi-hook-rate').innerText = vi ? ((v3 / vi) * 100).toFixed(1) + '%' : '—';
}

const FUNNEL_NOTES = {
  pageLoad: {
    healthy: 'Clicks are reaching the page. Nothing to fix here.',
    warning: 'Some clicks never load the page. Compress hero images and cut third-party scripts.',
    alert: 'Most clicks never see the page. This is a speed problem, and no budget change fixes it.'
  },
  offer: {
    healthy: 'People land and add to cart. The offer is working.',
    warning: 'Add-to-cart is soft. Test the price, the hero image and the first screen.',
    alert: 'They look and leave. Price or first screen is wrong — creative is not the problem.'
  },
  intent: {
    healthy: 'Carts move into checkout cleanly.',
    warning: 'Some carts stall. Show shipping cost earlier so it is not a surprise.',
    alert: 'Carts are not becoming checkouts. Almost always an unexpected shipping cost.'
  },
  completion: {
    healthy: 'Checkouts finish. Payment is not blocking anyone.',
    warning: 'Some checkouts drop. Check the mobile layout and trust badges.',
    alert: 'Checkouts start and die. Verify Klarna, PayPal and Stripe are all live.'
  }
};

function renderFunnel() {
  const t = totals();
  const f = VE.funnel({ clicks: t.clicks, lpv: t.lpv, atc: t.atc, ic: t.ic, purchases: t.purchases });
  const map = [['ratio-lpv-clicks', 'pageLoad'], ['ratio-atc-lpv', 'offer'], ['ratio-ic-atc', 'intent'], ['ratio-pur-ic', 'completion']];
  map.forEach(([prefix, key]) => {
    const d = f[key];
    const bar = document.getElementById(prefix + '-bar');
    const text = document.getElementById(prefix + '-text');
    const badge = document.getElementById(prefix + '-status');
    const note = document.getElementById('note-' + prefix);
    if (!bar) return;
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
        ['💸', 'CPA', 'Compare against your profit per order, not against yesterday.']
      ],
      rule: 'Evening read never changes budget. It tells you what to fix on the page tonight.'
    },
    midnight: {
      goal: 'Scale, keep, descale or kill.',
      checks: [
        ['📈', 'ROAS vs BER', 'Above break-even = it makes money. That is the only definition that counts.'],
        ['💵', 'Profit margin', 'Over 20% → +35%. 15–20% → +20%. Under 15% → leave it alone.'],
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
        <td data-col="lpv">${fmtInt(lpv)}</td>
        <td data-col="atc">${fmtInt(atc)}</td>
        <td data-col="ic">${fmtInt(ic)}</td>
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
                  <li class="feedback-item"><span class="feedback-bullet">⚡</span><span>LPV ÷ Clicks — <strong>${pct(lpv, clicks)}</strong></span></li>
                  <li class="feedback-item"><span class="feedback-bullet">🛒</span><span>ATC ÷ LPV — <strong>${pct(atc, lpv)}</strong></span></li>
                  <li class="feedback-item"><span class="feedback-bullet">💳</span><span>IC ÷ ATC — <strong>${pct(ic, atc)}</strong></span></li>
                  <li class="feedback-item"><span class="feedback-bullet">✅</span><span>Purchases ÷ IC — <strong>${pct(pur, ic)}</strong></span></li>
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
          { type: 'line', label: 'ROAS', data: dates.map(d => byDate[d].spend > 0 ? byDate[d].revenue / byDate[d].spend : 0),
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
  h.value = 'Breathe freely again';
  p.value = 'I coughed every evening for three weeks. Since using this I sleep through. My wife noticed first.';
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
      <div class="modal-footer"><button class="btn btn-primary full">OK</button></div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', ev => { if (ev.target === el || ev.target.closest('button')) el.remove(); });
}

/* ========================================================================== *
 *  RENDER ALL
 * ========================================================================== */
function renderAll() {
  computeVerdicts();
  renderCommandBar();
  renderVerdicts();
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
    { id: 'c1', name: 'Product A | 1.50 | 67', status: 'ACTIVE', budget: 100, daysLive: 4, learning: true,
      spend: 104.20, revenue: 302.18, purchases: 11, clicks: 640, lpv: 552, atc: 41, ic: 19,
      impressions: 41000, frequency: 1.32, history: hist([1.9, 2.4, 2.7]) },

    { id: 'c2', name: 'Product B | 1.60 | 62', status: 'ACTIVE', budget: 50, daysLive: 1,
      spend: 43.90, revenue: 0, purchases: 0, clicks: 310, lpv: 268, atc: 5, ic: 1,
      impressions: 22000, frequency: 1.08, history: [] },

    { id: 'c3', name: 'Product C | 1.80 | 56', status: 'ACTIVE', budget: 150, daysLive: 5,
      spend: 152.40, revenue: 185.90, purchases: 4, clicks: 720, lpv: 401, atc: 44, ic: 12,
      impressions: 68000, frequency: 2.71, history: hist([2.1, 1.4, 1.2, 1.5]) },

    { id: 'c4', name: 'Product D | 1.50 | 67', status: 'ACTIVE', budget: 200, daysLive: 7,
      spend: 198.75, revenue: 407.44, purchases: 14, clicks: 890, lpv: 762, atc: 62, ic: 26,
      impressions: 74000, frequency: 1.91, history: hist([2.2, 2.05, 2.1, 2.0, 2.15, 2.05]) }
  ].map(c => withSeries({ ...c, roas: c.spend > 0 ? c.revenue / c.spend : 0 }));

  const ads = [
    { 'Ad Name': 'Product A | UGC hook', 'Campaign': 'Product A', 'Creative Type': 'Video', 'Hook Rate (%)': '31.40',
      'Link CTR (%)': '2.35', 'Spend ($)': '58.20', 'Reach': '19000', 'Headline': 'Sleep through the night again',
      'Primary Text Snippet': 'I coughed every night for three weeks. Since using this I sleep through again.',
      'CPM ($)': '2.55', 'CPC ($)': '0.16', 'Impressions': '22800', 'Link Clicks': '360', 'Landing Page Views': '312',
      'Adds to Cart': '24', 'Checkouts Initiated': '11', 'Purchases': '7', 'Purchase ROAS': '3.02', 'Cost per Purchase': '8.31',
      'Frequency': '1.28', 'Video 3s Views': '7160', 'Thruplay Views': '2410', 'Ad ID': 'a1', 'Creative ID': 'cr1' },

    { 'Ad Name': 'Product A | Static before-after', 'Campaign': 'Product A', 'Creative Type': 'Image', 'Hook Rate (%)': '0',
      'Link CTR (%)': '1.62', 'Spend ($)': '46.00', 'Reach': '15500', 'Headline': 'Breathe freely from today',
      'Primary Text Snippet': 'My wife noticed the difference first. After two weeks the night cough was gone.',
      'CPM ($)': '2.52', 'CPC ($)': '0.16', 'Impressions': '18200', 'Link Clicks': '280', 'Landing Page Views': '240',
      'Adds to Cart': '17', 'Checkouts Initiated': '8', 'Purchases': '4', 'Purchase ROAS': '2.44', 'Cost per Purchase': '11.50',
      'Frequency': '1.36', 'Video 3s Views': '0', 'Thruplay Views': '0', 'Ad ID': 'a2', 'Creative ID': 'cr2' },

    { 'Ad Name': 'Product B | Split test', 'Campaign': 'Product B', 'Creative Type': 'Video', 'Hook Rate (%)': '12.10',
      'Link CTR (%)': '1.41', 'Spend ($)': '43.90', 'Reach': '20400', 'Headline': 'Look slimmer instantly',
      'Primary Text Snippet': 'The leggings that smooth everything. 50% off now.',
      'CPM ($)': '2.00', 'CPC ($)': '0.14', 'Impressions': '22000', 'Link Clicks': '310', 'Landing Page Views': '268',
      'Adds to Cart': '5', 'Checkouts Initiated': '1', 'Purchases': '0', 'Purchase ROAS': '0', 'Cost per Purchase': '',
      'Frequency': '1.08', 'Video 3s Views': '2662', 'Thruplay Views': '640', 'Ad ID': 'a3', 'Creative ID': 'cr3' },

    { 'Ad Name': 'Product C | Demo video', 'Campaign': 'Product C', 'Creative Type': 'Video', 'Hook Rate (%)': '22.80',
      'Link CTR (%)': '1.06', 'Spend ($)': '152.40', 'Reach': '25100', 'Headline': 'Sleep like you did at 25',
      'Primary Text Snippet': 'Since sleeping on the mat I no longer wake at three. I did not expect it to work.',
      'CPM ($)': '2.24', 'CPC ($)': '0.21', 'Impressions': '68000', 'Link Clicks': '720', 'Landing Page Views': '401',
      'Adds to Cart': '44', 'Checkouts Initiated': '12', 'Purchases': '4', 'Purchase ROAS': '1.22', 'Cost per Purchase': '38.10',
      'Frequency': '2.71', 'Video 3s Views': '15504', 'Thruplay Views': '3900', 'Ad ID': 'a4', 'Creative ID': 'cr4' },

    { 'Ad Name': 'Product D | Routine video', 'Campaign': 'Product D', 'Creative Type': 'Video', 'Hook Rate (%)': '28.60',
      'Link CTR (%)': '2.11', 'Spend ($)': '198.75', 'Reach': '38700', 'Headline': 'My skin after 14 days',
      'Primary Text Snippet': 'I tried expensive creams for years. This was the first one my friends noticed.',
      'CPM ($)': '2.69', 'CPC ($)': '0.22', 'Impressions': '74000', 'Link Clicks': '890', 'Landing Page Views': '762',
      'Adds to Cart': '62', 'Checkouts Initiated': '26', 'Purchases': '14', 'Purchase ROAS': '2.05', 'Cost per Purchase': '14.20',
      'Frequency': '1.91', 'Video 3s Views': '21164', 'Thruplay Views': '6800', 'Ad ID': 'a5', 'Creative ID': 'cr5' }
  ].map(normalizeAd);

  return { campaigns, ads };
}
