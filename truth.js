/* ==========================================================================
   TRUTH LAYER — Shopify order book as the revenue source of record
   --------------------------------------------------------------------------
   Loaded before app.js. Pure-ish: it fetches, matches and reports. It does
   not render and it does not decide.

   WHY

   Meta's per-campaign revenue was proved wrong on this account against both
   Shopify and Funnelish. Over 28 Oct – 3 Nov 2026 the account total agreed
   within 1.9% but the per-campaign split was out by up to EUR 869. Shopify
   order #6639 is the clean example: Meta credited it to Rubinblüte CM073,
   which had 41 sessions and zero orders, while the sale was GLATTR's.

   Shopify's Admin API refuses browser CORS, so the numbers arrive through the
   CGO Truth Worker (cgo-truth-worker.js), which holds the Shopify token as a
   Cloudflare secret. This file talks to that Worker.

   MATCHING

   The Worker reports revenue per Shopify product title. Campaigns are named
   "Brand | CM066 | LidLux™ | 1.36". Nothing in Shopify carries the CM code,
   so the join is on the product name, and it is done out loud: every match,
   every miss, and every euro that could not be attributed is reported so it
   can be seen and corrected. A silent mismatch here would be the same class
   of error we are trying to escape.
   ========================================================================== */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Truth = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /* Meta's date presets, as day offsets from midnight today in the ad
     account's timezone. Meta's "last_7d" ends YESTERDAY — today is not in it,
     which is why `to` is 0 for every multi-day window. */
  const PRESET_RANGE = {
    today:     { from: 0,   to: 1 },
    yesterday: { from: -1,  to: 0 },
    last_3d:   { from: -3,  to: 0 },
    last_7d:   { from: -7,  to: 0 },
    last_14d:  { from: -14, to: 0 },
    last_30d:  { from: -30, to: 0 },
    last_90d:  { from: -90, to: 0 }
  };

  /* Shipping and warranty lines are upsells. The Worker already folds them
     into their parent product, but a title that slips through must never be
     treated as a product here either. */
  const UPSELL = /versand|garantie|shipping|warrant|express|priorit|protection|insurance|tracking/i;

  /* ------------------------------------------------------------------
     TIMEZONE
     The ad account bills in Berlin; Abdo reads this in Cairo. A "day" is
     always the account's day, or the Shopify window and the Meta window
     describe different spans of time and will never reconcile.
     ------------------------------------------------------------------ */
  function tzOffsetMinutes(date, tz) {
    try {
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      const p = {};
      dtf.formatToParts(date).forEach(x => { p[x.type] = x.value; });
      let h = parseInt(p.hour, 10);
      if (h === 24) h = 0;
      const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, h, +p.minute, +p.second);
      return (asUTC - date.getTime()) / 60000;
    } catch (e) {
      return -new Date().getTimezoneOffset();
    }
  }

  /** Midnight-to-midnight in `tz`, shifted by whole days, as real UTC instants. */
  function tzDayRange(tz, fromDays, toDays) {
    const now = new Date();
    let y, m, d;
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(now).split('-');
      y = +parts[0]; m = +parts[1]; d = +parts[2];
    } catch (e) {
      y = now.getUTCFullYear(); m = now.getUTCMonth() + 1; d = now.getUTCDate();
    }

    const wallToUtc = (dayShift) => {
      const wall = Date.UTC(y, m - 1, d + dayShift, 0, 0, 0);
      // Two passes: the first offset may be the wrong side of a DST change.
      let off = tzOffsetMinutes(new Date(wall), tz);
      let real = wall - off * 60000;
      off = tzOffsetMinutes(new Date(real), tz);
      return new Date(wall - off * 60000);
    };

    return { since: wallToUtc(fromDays), until: wallToUtc(toDays) };
  }

  function rangeForPreset(preset, tz) {
    const r = PRESET_RANGE[preset] || PRESET_RANGE.today;
    return tzDayRange(tz || 'Europe/Berlin', r.from, r.to);
  }

  /* ------------------------------------------------------------------
     FETCH
     ------------------------------------------------------------------ */
  /* `range` is an explicit {since,until} of YYYY-MM-DD account-local days,
     set by the date bar. It wins over the preset, so any day or span the
     dashboard shows can be reconciled against Shopify — not only the
     handful of named presets. */
  /* The account-local span covering `fromDay`..`toDay` inclusive (both
     YYYY-MM-DD), as the instants the Shopify API wants. `until` is midnight
     at the START of the day after toDay, so the last day is included whole.
     Uses the same two-pass DST correction as the presets, so a custom span
     and a preset can never disagree about where a day begins. */
  function midnightInTz(ymd, tz, dayShift) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    const wall = Date.UTC(y, m - 1, d + (dayShift || 0), 0, 0, 0);
    let off = tzOffsetMinutes(new Date(wall), tz);
    let real = wall - off * 60000;
    off = tzOffsetMinutes(new Date(real), tz);
    return new Date(wall - off * 60000);
  }

  function rangeForDays(fromDay, toDay, tz) {
    const zone = tz || 'Europe/Berlin';
    return {
      since: midnightInTz(fromDay, zone, 0),
      until: midnightInTz(toDay, zone, 1)
    };
  }

  async function fetchTruth({ workerUrl, dashKey, preset, tz, range }) {
    if (!workerUrl || !dashKey) {
      return { ok: false, reason: 'not-configured' };
    }
    const { since, until } = range
      ? rangeForDays(range.since, range.until, tz)
      : rangeForPreset(preset, tz);

    const base = String(workerUrl).trim().replace(/\/+$/, '');
    const url = `${base}/revenue?since=${encodeURIComponent(since.toISOString())}` +
                `&until=${encodeURIComponent(until.toISOString())}`;

    let res, body;
    try {
      res = await fetch(url, { headers: { 'X-Dash-Key': dashKey } });
    } catch (e) {
      return {
        ok: false, reason: 'unreachable',
        error: 'Could not reach the Truth Worker. Check the URL in ⚙️ Settings, and that the Worker is deployed.'
      };
    }
    try { body = await res.json(); }
    catch (e) { return { ok: false, reason: 'bad-response', error: `Worker returned a non-JSON reply (HTTP ${res.status}).` }; }

    if (!res.ok || !body || body.ok === false) {
      const msg = (body && body.error) || `HTTP ${res.status}`;
      return {
        ok: false,
        reason: /unauthorized/i.test(msg) ? 'unauthorized' : 'error',
        error: /unauthorized/i.test(msg)
          ? 'The Truth Worker rejected the key. Check the dashboard key in ⚙️ Settings matches the DASH_KEY secret in Cloudflare.'
          : msg
      };
    }

    return { ok: true, data: body, since, until };
  }

  /* ------------------------------------------------------------------
     MATCHING
     ------------------------------------------------------------------ */
  /* A comparable key: letters and digits only, lowercased, trademark marks
     and punctuation gone. "LidLux™ Augenserum" → "lidluxaugenserum". */
  function key(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  /* The first word of a product label is the brandable token and the one
     that appears in both systems: "LidLux™" → "lidlux". */
  function headKey(s) {
    const first = String(s || '').trim().split(/[\s\-–—|]+/)[0];
    return key(first);
  }

  /* ------------------------------------------------------------------
     THE FUNNEL REGISTER
     ------------------------------------------------------------------
     Confirmed against the live funnel list 8 Nov 2026. Matching on product
     names alone fails whenever the two systems disagree about the name —
     Shopify sells "ZahnPro™ Sonic360", the campaign is called "CM028 |
     Zahnpro™" — and a near-miss there silently drops real revenue out of a
     campaign's ROAS. The CM code is the one identifier both sides carry, so
     it is tried first and the name is only the fallback.

     Keys are head tokens of the Shopify product title. Add a line when a new
     funnel goes live; the UI's manual override still wins over this. */
  var FUNNELS = {
    zahnpro:      'CM028',
    schnarchfrei: 'CM077',
    glattr:       'CM064',
    hautschild:   'CM032',
    celsior:      'CM002',
    lavouria:     'CM078',
    lidlux:       'CM066',
    velmira:      'CM081',
    atemfrei:     'CM074'
  };

  function cmOf(name) {
    var VE = (typeof globalThis !== 'undefined' && globalThis.VerdictEngine) || root.VerdictEngine;
    if (VE && VE.cmCode) return VE.cmCode(name);
    var m = String(name || '').match(/\bCM0*(\d{1,5})\b/i);
    return m ? 'CM' + m[1].padStart(3, '0') : null;
  }

  /* The CM code a Shopify product belongs to, by its head token. */
  function cmForProduct(title, register) {
    var reg = register || FUNNELS;
    var h = headKey(title);
    if (reg[h]) return reg[h];
    /* "ZahnPro™ Sonic360" heads to "zahnpro"; but a title whose first word is
       a qualifier ("Dr.Willhelmshaus Velmira") still needs to find its funnel,
       so fall back to a contains scan over the whole normalised title. */
    var t = key(title);
    var hit = Object.keys(reg).filter(function (k) { return t.indexOf(k) !== -1; })
      .sort(function (a, b) { return b.length - a.length; })[0];
    return hit ? reg[hit] : null;
  }

  /**
   * Join the Worker's per-product revenue onto the live campaigns.
   *
   * @param campaigns  live campaign objects (need .name)
   * @param byProduct  Worker's { "<shopify title>": {orders,net,gross,refunded} }
   * @param overrides  { "<shopify title>": "<campaign id>" } set by hand in the UI
   * @returns { perCampaign, matches, unmatchedProducts, unmatchedCampaigns, attributed, unattributed }
   */
  function match(campaigns, byProduct, overrides) {
    const over = overrides || {};
    const perCampaign = {};      // campaignId -> { orders, net, gross, refunded, products[] }
    const matches = [];
    const unmatchedProducts = [];
    const titles = Object.keys(byProduct || {});

    // Index campaigns by their product token. Longer tokens win a tie, because
    // "LidLux" is more specific than a short shared prefix.
    const index = campaigns.map(c => {
      const label = productLabelOf(c.name) || c.name;
      return { id: c.id, name: c.name, label, head: headKey(label), full: key(label), cm: cmOf(c.name) };
    }).filter(x => x.head.length >= 3)
      .sort((a, b) => b.head.length - a.head.length);

    /* One campaign per CM code. Where two live campaigns carry the same code
       (a retest beside the original), the product's revenue cannot be split
       between them on this evidence, so neither gets it and the pair is
       reported instead of guessed at. */
    const byCm = {};
    index.forEach(x => {
      if (!x.cm) return;
      if (byCm[x.cm] === undefined) byCm[x.cm] = x;
      else byCm[x.cm] = null;               // ambiguous
    });

    const add = (campaignId, title, row) => {
      const p = perCampaign[campaignId] ||
        (perCampaign[campaignId] = { orders: 0, net: 0, gross: 0, refunded: 0, products: [] });
      p.orders += row.orders || 0;
      p.net += row.net || 0;
      p.gross += row.gross || 0;
      p.refunded += row.refunded || 0;
      p.products.push(title);
    };

    titles.forEach(title => {
      const row = byProduct[title] || {};

      if (over[title]) {
        const hit = index.find(x => x.id === over[title]);
        if (hit) {
          add(hit.id, title, row);
          matches.push({ title, campaignId: hit.id, campaign: hit.label, how: 'manual', net: row.net });
          return;
        }
      }

      if (UPSELL.test(title)) {
        unmatchedProducts.push({ title, net: row.net || 0, orders: row.orders || 0, why: 'looks like a shipping or warranty line' });
        return;
      }

      /* CM code first — it is the identifier both systems actually share. */
      const cm = cmForProduct(title, over.__register);
      if (cm && byCm[cm]) {
        const hit = byCm[cm];
        add(hit.id, title, row);
        matches.push({ title, campaignId: hit.id, campaign: hit.label, how: 'cm:' + cm, net: row.net });
        return;
      }
      if (cm && byCm[cm] === null) {
        unmatchedProducts.push({
          title, net: row.net || 0, orders: row.orders || 0,
          why: 'two live campaigns both carry ' + cm + ' — rename one, or map this product by hand'
        });
        return;
      }

      const t = key(title);
      const hit = index.find(x => t.startsWith(x.head) || t.includes(x.head) || x.full.includes(t));
      if (hit) {
        add(hit.id, title, row);
        matches.push({ title, campaignId: hit.id, campaign: hit.label, how: 'name', net: row.net });
      } else {
        unmatchedProducts.push({
          title, net: row.net || 0, orders: row.orders || 0,
          why: cm
            ? 'belongs to ' + cm + ', but no live campaign carries that code'
            : 'no live campaign with a matching product name, and no CM code on file'
        });
      }
    });

    const unmatchedCampaigns = campaigns
      .filter(c => !perCampaign[c.id] && c.spend > 0)
      .map(c => ({
        id: c.id,
        name: c.name,
        label: productLabelOf(c.name),
        spend: c.spend
      }));

    const attributed = Object.values(perCampaign).reduce((s, p) => s + p.net, 0);
    const unattributed = unmatchedProducts.reduce((s, p) => s + p.net, 0);

    return {
      perCampaign,
      matches,
      unmatchedProducts,
      unmatchedCampaigns,
      attributed: round2(attributed),
      unattributed: round2(unattributed)
    };
  }


  /* ------------------------------------------------------------------
     ORDERS BY AD
     Shopify cannot say which ad an order came from, but Funnelish can: it
     stores the ad name Meta put in the link. The Worker keeps those and
     reports revenue per ad name at /ads. The join to a Meta ad is on the
     NAME, so it is done out loud like the product match above: an ad whose
     name is shared by two live ads is never given a number, because half of
     it could belong to the other one.
     ------------------------------------------------------------------ */
  function adKey(s) {
    return String(s == null ? '' : s).normalize('NFC').split(/\s+/).join(' ').trim().toLowerCase();
  }

  async function fetchAdOrders({ workerUrl, dashKey, tz, fromDays, toDays }) {
    if (!workerUrl || !dashKey) return { ok: false, reason: 'not-configured' };
    const { since, until } = tzDayRange(tz, fromDays === undefined ? -7 : fromDays, toDays === undefined ? 0 : toDays);
    const base = String(workerUrl).trim().replace(/\/+$/, '');
    const url = `${base}/ads?since=${encodeURIComponent(since.toISOString())}` +
                `&until=${encodeURIComponent(until.toISOString())}`;
    let res, body;
    try { res = await fetch(url, { headers: { 'X-Dash-Key': dashKey } }); }
    catch (e) { return { ok: false, reason: 'unreachable', error: 'Could not reach the Truth Worker for ad orders.' }; }
    try { body = await res.json(); }
    catch (e) { return { ok: false, reason: 'bad-response', error: `Ad orders: non-JSON reply (HTTP ${res.status}).` }; }
    if (!res.ok || !body || body.ok === false) {
      return { ok: false, reason: 'error', error: (body && body.error) || `HTTP ${res.status}` };
    }
    return { ok: true, data: body, since, until };
  }

  /**
   * Gives every creative row its Shopify order count, or says why it has none.
   *   rows  — State.creative rows ({id, name, ...}); mutated: row.shop = {...}
   *   data  — the Worker's /ads body
   * Returns a summary of what could not be placed.
   */
  function matchAdOrders(rows, data) {
    const list = rows || [];
    const byAd = (data && data.byAd) || {};
    const covers = !!(data && data.coversWholeRange);

    const nameCount = Object.create(null);
    list.forEach(r => { const k = adKey(r.name); if (k) nameCount[k] = (nameCount[k] || 0) + 1; });

    const entries = Object.values(byAd);
    const byName = Object.create(null), byId = Object.create(null);
    entries.forEach(e => {
      if (e.name) byName[adKey(e.name)] = e;
      if (e.adId) byId[String(e.adId)] = e;
    });

    const used = new Set();
    let ambiguous = 0;
    list.forEach(r => {
      const k = adKey(r.name);
      const viaId = byId[String(r.id)];
      const viaName = byName[k];

      if (nameCount[k] > 1 && !viaId) {
        ambiguous++;
        if (viaName) used.add(viaName);
        r.shop = { state: 'ambiguous', orders: null, revenue: null, trusted: false };
        return;
      }
      /* An order tagged with the raw ad id adds to the same ad as its name. */
      const hit = [viaName, viaId].filter(Boolean);
      const uniq = hit.filter((e, i) => hit.indexOf(e) === i);
      uniq.forEach(e => used.add(e));
      const orders = uniq.reduce((s, e) => s + (e.orders || 0), 0);
      const revenue = round2(uniq.reduce((s, e) => s + (e.revenue || 0), 0));
      r.shop = { state: orders > 0 ? 'matched' : 'none', orders, revenue, trusted: covers };
    });

    const orphans = entries.filter(e => !used.has(e));
    return {
      covers,
      ads: list.length,
      ambiguous,
      orphanCount: orphans.length,
      orphanRevenue: round2(orphans.reduce((s, e) => s + (e.revenue || 0), 0)),
      orphans: orphans.sort((a, b) => b.revenue - a.revenue).slice(0, 8)
        .map(e => ({ name: e.name || e.adId, orders: e.orders, revenue: e.revenue })),
      untaggedRevenue: round2((data && data.untaggedRevenue) || 0),
      totalRevenue: round2((data && data.revenue) || 0),
      totalOrders: (data && data.orders) || 0,
      collectingSince: (data && data.collectingSince) || null
    };
  }

  /* rules.js loads before this file in the browser and is required ahead of it
     in Node. Resolve it at call time rather than capturing it at load time, so
     the order of <script> tags cannot silently disable product matching. */

  /* ------------------------------------------------------------------
     COST SHEET CHECK
     ------------------------------------------------------------------
     The dashboard reads each campaign's break-even (BER) from the campaign
     NAME. The product data sheet is where it is worked out. If the two
     drift apart — a supplier quote changes, a price is raised, a name is
     never updated — the dashboard quietly judges a campaign against the
     wrong line. This lines them up so the owner sees it.

     The sheet is private, so the dashboard reads a copy kept in the Worker
     (see saveCosts there). Nothing here moves a budget or changes a verdict. */
  var COST_TOLERANCE = 0.02;   // two decimals in a name: 1.32 vs 1.33 is rounding, not drift
  var COST_STALE_DAYS = 14;

  function berFromName(name) {
    var VE = (typeof globalThis !== 'undefined' && globalThis.VerdictEngine) || root.VerdictEngine;
    if (VE && VE.parseCampaignName) { var p = VE.parseCampaignName(name); return p && p.ber ? p.ber : null; }
    var parts = String(name || '').split('|');
    for (var i = parts.length - 1; i >= 0; i--) {
      var m = parts[i].trim().match(/^(\d\.\d{1,2})\b/);
      if (m) return parseFloat(m[1]);
    }
    return null;
  }

  function costCheck(campaigns, costs, nowMs) {
    var rows = (costs && costs.rows) || {};
    var savedMs = costs && costs.savedAt ? Date.parse(costs.savedAt) : NaN;
    var now = nowMs || Date.now();
    var ageDays = Number.isFinite(savedMs) ? Math.floor((now - savedMs) / 86400000) : null;
    var out = [];

    (campaigns || []).forEach(function (c) {
      var code = cmOf(c.name);
      var label = String(c.name || '').split('|').map(function (x) { return x.trim(); })[2] || c.name;
      var active = !/^(PAUSED|ADSET_PAUSED|CAMPAIGN_PAUSED|ARCHIVED|DELETED)$/.test(String(c.status || ''));
      var nameBer = berFromName(c.name);
      var row = code ? rows[code] : null;
      var r = { id: c.id, code: code, label: label, active: active, nameBer: nameBer,
                sheetBer: row && row.ber > 0 ? row.ber : null, price: row ? row.price : null, status: 'match', message: '' };

      if (!code) {
        r.status = 'no-code';
        r.message = 'The campaign name has no CM code, so it cannot be matched to the sheet.';
      } else if (!row) {
        r.status = 'no-row';
        r.message = code + ' is not in the sheet copy.';
      } else if (!(row.ber > 0) || !(row.price > 0)) {
        r.status = 'incomplete';
        r.message = code + ' has no price or break-even in the sheet yet, so there is nothing to check this campaign against.';
      } else if (nameBer === null) {
        r.status = 'no-ber';
        r.message = 'The name carries no break-even, so the dashboard uses the account figure. The sheet says ' + row.ber.toFixed(2) + '.';
      } else {
        var diff = Math.round((nameBer - row.ber) * 100) / 100;
        r.diff = diff;
        if (Math.abs(diff) > COST_TOLERANCE) {
          r.status = 'differs';
          r.message = 'The sheet says ' + row.ber.toFixed(2) + ' but the campaign name says ' + nameBer.toFixed(2) + '. ' +
            (diff < 0
              ? 'The dashboard is using the LOWER figure, so it can call this campaign profitable when it is not.'
              : 'The dashboard is using the HIGHER figure, so it can call this campaign unprofitable when it is not.') +
            ' One of the two is out of date.';
        }
      }
      out.push(r);
    });

    var order = { differs: 0, incomplete: 1, 'no-row': 2, 'no-code': 3, 'no-ber': 4, match: 5 };
    out.sort(function (a, b) {
      return (a.status === 'match') - (b.status === 'match') ||
             (b.active - a.active) || (order[a.status] - order[b.status]);
    });
    var count = function (st) { return out.filter(function (x) { return x.status === st; }).length; };
    return {
      rows: out, ageDays: ageDays, stale: ageDays !== null && ageDays > COST_STALE_DAYS, savedAt: costs ? costs.savedAt || null : null,
      counts: { match: count('match'), differs: count('differs'), incomplete: count('incomplete'),
                noRow: count('no-row') + count('no-code'), noBer: count('no-ber') },
      activeProblems: out.filter(function (x) { return x.active && (x.status === 'differs' || x.status === 'incomplete'); }).length
    };
  }

  /* ------------------------------------------------------------------
     SUPPLIER CHECK — the platform's own numbers
     ------------------------------------------------------------------
     Dropshipping Lite knows what each order really cost to make and ship.
     The Worker turns the last few weeks of orders into a real break-even per
     product; this lines it up with each campaign's name. Matching is by
     product name (LidLux™ = LidLux), so no CM code is needed. Where the
     supplier has too few orders to say, the sheet check is used instead. */
  var SUPPLIER_TOLERANCE = 0.04;
  var SUPPLIER_MIN_ORDERS = 8;

  function normProduct(s) {
    return String(s || '').toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9äöüß]+/g, ' ').trim();
  }

  function supplierCheck(campaigns, supplier, nowMs) {
    var rows = (supplier && supplier.rows) || {};
    var out = [];
    (campaigns || []).forEach(function (c) {
      var parts = String(c.name || '').split('|').map(function (x) { return x.trim(); });
      var label = parts[2] || c.name;
      var active = !/^(PAUSED|ADSET_PAUSED|CAMPAIGN_PAUSED|ARCHIVED|DELETED)$/.test(String(c.status || ''));
      var nameBer = berFromName(c.name);
      var row = rows[normProduct(label)] || null;
      var r = { id: c.id, code: cmOf(c.name), label: label, active: active, nameBer: nameBer, source: 'supplier',
                realBer: row && row.ber > 0 ? row.ber : null, orders: row ? row.orders : 0, status: 'match', message: '' };
      if (!row) {
        r.status = 'no-row';
        r.message = 'Dropshipping Lite has no recent orders for ' + label + '.';
      } else if (row.orders < SUPPLIER_MIN_ORDERS) {
        r.status = 'few';
        r.message = 'Only ' + row.orders + ' recent supplier order' + (row.orders === 1 ? '' : 's') + ' for ' + label + ' — too few to trust a real break-even yet.';
      } else if (!(row.ber > 0)) {
        r.status = 'incomplete';
        r.message = 'On the last ' + row.orders + ' orders the supplier cost and fees are above the sale price, so there is no break-even at the current price.';
      } else if (nameBer === null) {
        r.status = 'no-ber';
        r.message = 'The name carries no break-even. The real supplier cost says ' + row.ber.toFixed(2) + '.';
      } else {
        var diff = Math.round((nameBer - row.ber) * 100) / 100;
        r.diff = diff;
        if (Math.abs(diff) > SUPPLIER_TOLERANCE) {
          r.status = 'differs';
          r.message = 'Real supplier cost says break-even ' + row.ber.toFixed(2) + ' (last ' + row.orders + ' orders, average order €' + row.aov.toFixed(2) +
            ', cost €' + row.costPerOrder.toFixed(2) + ' + fees €' + row.feesPerOrder.toFixed(2) + '), but the campaign name says ' + nameBer.toFixed(2) + '. ' +
            (diff < 0
              ? 'The dashboard is using the LOWER figure, so it can call this campaign profitable when it is not.'
              : 'The dashboard is using the HIGHER figure, so it can call this campaign unprofitable when it is not.') +
            ' Rename the campaign to ' + row.ber.toFixed(2) + ' to fix it.';
        }
      }
      out.push(r);
    });
    return out;
  }

  /* Supplier rows win where they can speak (enough orders); the sheet fills
     the gaps. Same shape as costCheck so the rest of the dashboard is unchanged. */
  function mergeCostChecks(sheetChk, supplier, campaigns, nowMs) {
    var now = nowMs || Date.now();
    var sup = supplier && supplier.rows ? supplierCheck(campaigns, supplier, now) : [];
    var sheetById = {};
    if (sheetChk) sheetChk.rows.forEach(function (r) { sheetById[r.id] = r; });
    var speaks = { match: 1, differs: 1, incomplete: 1, 'no-ber': 1 };
    var rows = (campaigns || []).map(function (c, i) {
      var s = sup[i];
      if (s && speaks[s.status]) return s;
      var sh = sheetById[c.id];
      if (sh) { sh.source = 'sheet'; return sh; }
      return s || null;
    }).filter(Boolean);
    var order = { differs: 0, incomplete: 1, 'no-row': 2, 'no-code': 3, few: 4, 'no-ber': 5, match: 6 };
    rows.sort(function (a, b) {
      return (a.status === 'match') - (b.status === 'match') ||
             (b.active - a.active) || ((order[a.status] || 9) - (order[b.status] || 9));
    });
    var count = function (st) { return rows.filter(function (x) { return x.status === st; }).length; };
    var supMs = supplier && supplier.fetchedAt ? Date.parse(supplier.fetchedAt) : NaN;
    var usedSupplier = rows.some(function (r) { return r.source === 'supplier'; });
    var ageDays = usedSupplier && Number.isFinite(supMs) ? Math.floor((now - supMs) / 86400000)
                  : sheetChk ? sheetChk.ageDays : null;
    return {
      rows: rows, ageDays: ageDays,
      stale: usedSupplier ? (ageDays !== null && ageDays > 2) : !!(sheetChk && sheetChk.stale),
      savedAt: usedSupplier ? supplier.fetchedAt : (sheetChk ? sheetChk.savedAt : null),
      usedSupplier: usedSupplier,
      counts: { match: count('match'), differs: count('differs'), incomplete: count('incomplete'),
                noRow: count('no-row') + count('no-code'), noBer: count('no-ber'), few: count('few') },
      activeProblems: rows.filter(function (x) { return x.active && (x.status === 'differs' || x.status === 'incomplete'); }).length
    };
  }

  async function fetchSupplier({ workerUrl, dashKey }) {
    if (!workerUrl || !dashKey) return { ok: false, reason: 'not-configured' };
    var base = String(workerUrl).trim().replace(/\/+$/, '');
    var res, body;
    try { res = await fetch(base + '/supplier', { headers: { 'X-Dash-Key': dashKey } }); }
    catch (e) { return { ok: false, reason: 'unreachable', error: 'Could not reach the Truth Worker for the supplier read.' }; }
    try { body = await res.json(); }
    catch (e) { return { ok: false, reason: 'bad-response', error: 'Supplier read: non-JSON reply (HTTP ' + res.status + ').' }; }
    if (!res.ok || !body || body.ok === false) return { ok: false, reason: 'error', error: (body && body.error) || ('HTTP ' + res.status) };
    if (body.off) return { ok: false, reason: 'off', error: body.message };
    return { ok: true, data: body };
  }

  async function fetchCosts({ workerUrl, dashKey }) {
    if (!workerUrl || !dashKey) return { ok: false, reason: 'not-configured' };
    var base = String(workerUrl).trim().replace(/\/+$/, '');
    var res, body;
    try { res = await fetch(base + '/costs', { headers: { 'X-Dash-Key': dashKey } }); }
    catch (e) { return { ok: false, reason: 'unreachable', error: 'Could not reach the Truth Worker for the cost sheet copy.' }; }
    try { body = await res.json(); }
    catch (e) { return { ok: false, reason: 'bad-response', error: 'Cost sheet copy: non-JSON reply (HTTP ' + res.status + ').' }; }
    if (!res.ok || !body || body.ok === false) return { ok: false, reason: 'error', error: (body && body.error) || ('HTTP ' + res.status) };
    return { ok: true, data: body };
  }

  function productLabelOf(name) {
    const VE = (typeof globalThis !== 'undefined' && globalThis.VerdictEngine) || root.VerdictEngine;
    return (VE && VE.productLabel) ? VE.productLabel(name) : name;
  }

  function round2(v) { const n = parseFloat(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }

  return { fetchTruth, match, rangeForPreset, tzDayRange, tzOffsetMinutes,
           key, headKey, cmForProduct, rangeForDays, FUNNELS, PRESET_RANGE,
           adKey, fetchAdOrders, matchAdOrders, costCheck, fetchCosts, COST_TOLERANCE, COST_STALE_DAYS,
           supplierCheck, mergeCostChecks, fetchSupplier, normProduct, SUPPLIER_TOLERANCE, SUPPLIER_MIN_ORDERS };
});
