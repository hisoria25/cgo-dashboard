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

  /* rules.js loads before this file in the browser and is required ahead of it
     in Node. Resolve it at call time rather than capturing it at load time, so
     the order of <script> tags cannot silently disable product matching. */
  function productLabelOf(name) {
    const VE = (typeof globalThis !== 'undefined' && globalThis.VerdictEngine) || root.VerdictEngine;
    return (VE && VE.productLabel) ? VE.productLabel(name) : name;
  }

  function round2(v) { const n = parseFloat(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }

  return { fetchTruth, match, rangeForPreset, tzDayRange, tzOffsetMinutes,
           key, headKey, cmForProduct, rangeForDays, FUNNELS, PRESET_RANGE };
});
