/* ==========================================================================
   VERDICT ENGINE — Samuel Ecom Scaling Cheat Sheet, encoded
   --------------------------------------------------------------------------
   Pure functions only. No DOM, no fetch. This file is unit-tested in Node
   (see tests/rules.test.js) and loaded as a plain <script> in the browser.

   REVENUE PROVENANCE (added 8 Nov 2026)
   Every verdict below is only as good as the revenue fed into it. On this
   account Meta's PER-CAMPAIGN revenue was proved wrong against Shopify and
   Funnelish: over 28 Oct – 3 Nov the account total agreed within 1.9% but the
   per-campaign split was out by up to EUR 869, because every pixel is
   installed store-wide and 1d-view credit lets any campaign claim any sale.

   So the engine now asks where the revenue came from, via ctx.revenueSource:
     'shopify'  — reconciled against the order book. Every verdict available.
     'meta'     — Meta's attributed figure. KILL, DESCALE, HOLD and the
                  diagnostics stay available; SCALE and SURF are locked,
                  because scaling on a number that has already been wrong
                  twice is how GLATTR got +35% while below break-even.
     anything else ('demo', 'csv', undefined) — treated as un-flagged. Nothing
                  is locked, because these are not live money decisions.
   ========================================================================== */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VerdictEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /* ------------------------------------------------------------------
     1. THE RULE BOOK — every number here comes straight from the sheet
     ------------------------------------------------------------------ */
  const RULES = {
    day1: {
      // "Adspend <= 40$ and 0 sales with low ATC rate, KILL CAMPAIGN"
      decisionSpend: 40,
      // What counts as a "low ATC rate": adds-to-cart per landing page view
      atcRateLow: 5.0,          // %
      // "lower product price by 20-30% and spend another 30$"
      priceDropPct: [20, 30],
      extraSpendAfterPriceDrop: 30,
      // "let it spend until 80-90$"
      proveWindow: [80, 90]
    },
    scale: {
      // "profit margin > 20%, +35% BUDGET INCREASE"
      tiers: [
        { minMargin: 20, pct: 35 },
        { minMargin: 15, pct: 20 },
        { minMargin: -Infinity, pct: 0 }   // <15% → don't touch
      ]
    },
    descale: {
      pct: 40,                              // "DESCALE WITH 40%"
      hardDescalePct: 60,                   // "if it's SUPER unprofitable"
      superUnprofitableRatio: 0.5,          // ROAS below 50% of BER
      killAfterUnprofitableDays: 2          // "unprofitable 2 days in a row"
    },
    weekend: {
      // "ROAS = 3+, Budget x5 | ROAS = 5+, Budget x10"
      surf: [
        { minRoas: 5, multiplier: 10 },
        { minRoas: 3, multiplier: 5 }
      ],
      // Sunday night pull-back
      sundayNight: [
        { minRoas: 5, descalePct: 30 },
        { minRoas: 3, descalePct: 35 },
        { minRoas: 0, descalePct: 40 }
      ]
    },
    frequency: { fatigue: 2.5 },
    // Learning phase. Meta resets learning on a "significant edit", and a
    // budget change above roughly 20% counts as one. That does NOT mean never
    // scale — it means know the cost. Blocking scaling outright would stop a
    // daily-scaling playbook dead, because campaigns that scale every night
    // rarely leave learning at all. So: warn, offer the safer step, never block.
    learning: { blockScaling: false, safeBudgetChangePct: 20 },
    // Budget it cannot spend is the auction telling you something.
    pacing: { underDelivering: 0.7 },
    // Benchmarks: `good` is the bottom of the healthy range from the sheet,
    // `poor` is where it stops being a warning and becomes a leak.
    funnel: {
      pageLoad:   { good: 70, poor: 50 },   // LPV ÷ Clicks        — healthy 70-90%
      offer:      { good: 5,  poor: 3  },   // ATC ÷ LPV           — healthy 5-10%
      intent:     { good: 30, poor: 20 },   // IC  ÷ ATC           — healthy 30-60%
      completion: { good: 50, poor: 30 }    // Purchases ÷ IC      — healthy 50%+
    },
    guardrails: {
      maxActiveCampaignsPerAccount: 3,      // ban prevention
      creativeRefreshAfterProfitableDays: 3
    },
    // Consistency floor: never act on noise
    minSpendForVerdict: 5,

    /* ----------------------------------------------------------------
       CONFIDENCE — added 8 Nov 2026
       ----------------------------------------------------------------
       The ladder's thresholds are narrow and this account's daily order
       counts are small. At ~7 orders per campaign per day the random
       spread on ROAS is roughly ±38%, which is wider than the gap
       between "cut 40%" and "scale 35%". Noise alone will flip a
       campaign between them night after night — and did: GLATTR read
       3.89 one day and 1.15 another with nothing changed.

       Fixing Meta's attribution removed a BIAS. This removes the
       VARIANCE. Both were needed.

       z is 1.282 (80%), a business threshold rather than a laboratory
       one. The asymmetry below is deliberate: adding money to a
       campaign that has not proved itself compounds a loss, while
       cutting one that was actually fine is recoverable by scaling it
       back up. So scaling demands proof and cutting demands only a
       reasonable sample.
       ---------------------------------------------------------------- */
    confidence: {
      z: 1.282,                 // 80% interval
      minOrdersForVerdict: 4,   // under this, no call of any kind
      minOrdersToCut: 8         // enough to stop the bleeding, not enough to prove it
    },

    /* Weekend surfing is a claim about DEMAND, not about one day's ROAS.
       Multiplying a budget by 10 because a campaign printed a 3.0 on a
       sample of seven orders is a coin flip, and it resets learning on
       every campaign at once. So the lift has to be measured on this
       account's own history before any of it is allowed. */
    weekend_evidence: {
      minWeekendDays: 4,        // at least two weekends of data
      minWeekdayDays: 10,
      liftToBudgetFactor: 3,    // a 25% measured lift earns up to +75%
      maxSurfPct: 100           // never more than double in one step
    },

    /* The budget sweet spot. Scaling is only worth it while the EXTRA spend
       still earns money; past some level a campaign makes less in total,
       not more. That level is read from the campaign's own days. */
    curve: {
      minDays: 9,               // three days per band at the very least
      minDaysPerBand: 3,
      minOrdersPerBand: 15,     // a band on a dozen orders is a coin toss
      minSpread: 1.5,           // the budget has to have actually moved
      dropPct: 15,              // the top band must earn this much less...
      dropAbs: 10,              // ...and at least this many euros a day less
      overshoot: 1.05           // tolerance before a budget counts as past the ceiling
    }
  };

  /* ------------------------------------------------------------------
     2. UNIT ECONOMICS
     ------------------------------------------------------------------
     grossMargin = (price - cogs - shipping - fees) / price
     BER         = 1 / grossMargin           (break-even ROAS)
     netMargin   = grossMargin - 1 / ROAS    (live contribution margin)

     The last identity is what makes the sheet self-consistent:
     ROAS > BER  <=>  netMargin > 0.

     Note on the name: this is CONTRIBUTION margin, not profit. It deducts
     COGS, shipping and payment fees, and nothing else. Refunds are only
     deducted when revenue itself arrives net of them, which is the case when
     revenue comes from Shopify (ctx.revenueSource === 'shopify') and not when
     it comes from Meta. Fixed costs are never in it.
     ------------------------------------------------------------------ */
  function economics({ price = 0, cogs = 0, shipping = 0, feePct = 0 }) {
    const p = num(price);
    if (p <= 0) return { price: 0, grossMargin: 0, ber: 0, valid: false };
    const fees = p * (num(feePct) / 100);
    const contribution = p - num(cogs) - num(shipping) - fees;
    const grossMargin = contribution / p;
    return {
      price: p,
      cogs: num(cogs),
      shipping: num(shipping),
      fees: round2(fees),
      contribution: round2(contribution),
      grossMargin: grossMargin,
      grossMarginPct: round1(grossMargin * 100),
      ber: grossMargin > 0 ? round2(1 / grossMargin) : 0,
      valid: grossMargin > 0
    };
  }

  /** Live contribution margin of a campaign, as a percentage. */
  function netMarginPct(roas, grossMargin) {
    if (!roas || roas <= 0 || !grossMargin) return -100;
    return round1((grossMargin - 1 / roas) * 100);
  }

  /** grossMargin implied by a BER pulled out of a campaign name. */
  function grossMarginFromBer(ber) {
    const b = num(ber);
    return b > 0 ? 1 / b : 0;
  }

  /* ------------------------------------------------------------------
     2b. REVENUE PROVENANCE
     ------------------------------------------------------------------ */
  /** True when the revenue behind this verdict came from the order book. */
  function revenueVerified(ctx) {
    return (ctx && ctx.revenueSource) === 'shopify';
  }

  /** True when the revenue is Meta's own attribution, which may not scale on. */
  function scalingLocked(ctx) {
    return (ctx && ctx.revenueSource) === 'meta';
  }

  /** What the margin figure actually means, given where revenue came from. */
  function marginLabel(ctx) {
    return revenueVerified(ctx)
      ? 'Contribution margin (after refunds)'
      : 'Contribution margin (before refunds)';
  }

  /* ------------------------------------------------------------------
     2c. CONFIDENCE
     ------------------------------------------------------------------
     Orders arrive roughly as a Poisson process, so the relative standard
     error on a count of n is 1/√n. Revenue inherits that, and ROAS is
     revenue over a spend figure that is known exactly — so the spread on
     ROAS is driven by how many orders it rests on, and nothing else.

     n=4  → ±64%      n=10 → ±41%      n=25 → ±26%      n=100 → ±13%

     That is the whole argument for not acting on a single thin day.
     ------------------------------------------------------------------ */
  function roasInterval(roas, orders, z) {
    const n = num(orders), r = num(roas);
    if (!(n > 0) || !(r > 0)) return null;
    const zz = num(z) || RULES.confidence.z;
    const half = zz / Math.sqrt(n);
    return {
      roas: round2(r),
      orders: n,
      lo: round2(Math.max(0, r * (1 - half))),
      hi: round2(r * (1 + half)),
      rsePct: round1((1 / Math.sqrt(n)) * 100)
    };
  }

  /** How many orders it would take to separate this ROAS from this BER.
      Answers "how much longer do I wait" instead of leaving a card silent. */
  function ordersNeeded(roas, ber, z) {
    const r = num(roas), b = num(ber);
    if (!(r > 0) || !(b > 0)) return null;
    const gap = Math.abs(r - b) / r;
    if (!(gap > 0)) return null;
    const zz = num(z) || RULES.confidence.z;
    return Math.ceil(Math.pow(zz / gap, 2));
  }

  /** True when the whole interval sits above break-even — the only state
      in which more money is justified. */
  function provenAbove(interval, ber) {
    return !!interval && num(ber) > 0 && interval.lo > num(ber);
  }

  /* ------------------------------------------------------------------
     2d. WEEKEND LIFT, MEASURED
     ------------------------------------------------------------------
     Pools every Saturday and Sunday in the history against every weekday
     and reports the real difference. One weekend proves nothing, so the
     result carries `reliable` and the caller must respect it.
     ------------------------------------------------------------------ */
  function weekendLift(history) {
    const rows = (history || []).filter(d => num(d.spend) > 0 && d.date);
    const bucket = { we: { spend: 0, revenue: 0, days: 0 }, wd: { spend: 0, revenue: 0, days: 0 } };

    rows.forEach(d => {
      const t = new Date(String(d.date) + 'T12:00:00Z');
      if (isNaN(t.getTime())) return;
      const dow = t.getUTCDay();
      const b = (dow === 0 || dow === 6) ? bucket.we : bucket.wd;
      b.spend += num(d.spend);
      b.revenue += num(d.revenue);
      b.days += 1;
    });

    const weRoas = bucket.we.spend > 0 ? bucket.we.revenue / bucket.we.spend : 0;
    const wdRoas = bucket.wd.spend > 0 ? bucket.wd.revenue / bucket.wd.spend : 0;
    const reliable = bucket.we.days >= RULES.weekend_evidence.minWeekendDays &&
                     bucket.wd.days >= RULES.weekend_evidence.minWeekdayDays &&
                     wdRoas > 0;

    return {
      weekendRoas: round2(weRoas),
      weekdayRoas: round2(wdRoas),
      weekendDays: bucket.we.days,
      weekdayDays: bucket.wd.days,
      lift: reliable ? round2((weRoas / wdRoas) - 1) : null,
      reliable
    };
  }

  /** Budget increase a measured lift earns, capped. Returns 0 when the
      evidence does not support moving anything. */
  function surfPctFromLift(lift) {
    const l = num(lift);
    if (!(l > 0)) return 0;
    return Math.min(
      RULES.weekend_evidence.maxSurfPct,
      Math.round(l * 100 * RULES.weekend_evidence.liftToBudgetFactor)
    );
  }

  /* The weekend surf may never scale something the ordinary ladder would
     refuse, so it borrows the ladder's own lowest scaling tier. */
  const SURF_MARGIN_FLOOR = RULES.scale.tiers[RULES.scale.tiers.length - 2].minMargin;

  const UNVERIFIED_WHY =
    'Meta per-campaign revenue is not trustworthy on this account: the account total is right ' +
    'within about 2%, but the per-campaign split has been out by up to EUR 869 because every ' +
    'pixel is installed store-wide and view-through credit lets any campaign claim any sale.';

  /* ------------------------------------------------------------------
     3. CAMPAIGN NAME PARSER
     ------------------------------------------------------------------
     The BER is found by shape, not by position, because real campaign
     names are not tidy. All of these must work:

       AtemFrei | 1.50 | 67
       Dr Whilinis | CM074 | AtemFrei™Königskerze-Tropfen | 1.58
       Hautglenz | CM066 | LidLux™ | 1.36 - V2- Q4
       Celsior|  CM002 | CelsiorLeggings | 1.55

     A BER always has a decimal point. That single fact separates it from
     product codes (CM074), version tags (V2), quarters (Q4) and margins
     (67), all of which are whole numbers. When several fields qualify the
     last one wins, because that is where the BER sits in practice.
     ------------------------------------------------------------------ */
  const BER_MIN = 1.01, BER_MAX = 20;

  function parseCampaignName(name) {
    const raw = (name || '').toString();
    const parts = raw.split('|').map(s => s.trim()).filter(Boolean);
    const out = { product: parts[0] || raw, ber: null, margin: null, berField: null, conforms: false };

    const candidates = [];
    parts.forEach((part, i) => {
      const m = part.match(/(?:^|[\s(])(\d{1,2}[.,]\d{1,2})(?!\d)/);
      if (!m) return;
      const v = parseFloat(m[1].replace(',', '.'));
      if (v >= BER_MIN && v <= BER_MAX) candidates.push({ value: v, index: i, field: part });
    });

    if (candidates.length) {
      const pick = candidates[candidates.length - 1];
      out.ber = pick.value;
      out.berField = pick.field;
      out.conforms = true;

      // A margin, when present, is a bare whole number after the BER.
      for (let i = pick.index + 1; i < parts.length; i++) {
        const m = parts[i].match(/^(\d{1,3})\s*%?$/);
        if (m) {
          const v = parseInt(m[1], 10);
          if (v > 0 && v < 100) { out.margin = v; break; }
        }
      }
    }
    return out;
  }

  /** Which product this campaign is for — the longest word-bearing field
      that is not a code and not the BER. Keeps card titles readable. */
  function productLabel(name) {
    const parsed = parseCampaignName(name);
    const parts = (name || '').toString().split('|').map(s => s.trim()).filter(Boolean);
    const meaningful = parts.filter(p =>
      p !== parsed.berField &&
      !/^[A-Z]{1,4}\d{2,6}$/i.test(p) &&          // product codes: CM074
      /[a-z]{3}/i.test(p));                        // has real words
    // Brand comes first, product comes later — so the last real field is the
    // product. With only one field, that field is the product.
    return meaningful[meaningful.length - 1] || parts[0] || name;
  }

  /** The CM code in a campaign name, if there is one. This is the join key
      between Meta campaigns, ClickUp tasks and Shopify products. CM063 is
      written both "CM063" and "CM0063" in ClickUp, so leading zeros after
      the prefix are normalised away. */
  function cmCode(name) {
    const m = String(name || '').match(/\bCM0*(\d{1,5})\b/i);
    return m ? 'CM' + m[1].padStart(3, '0') : null;
  }

  /* ------------------------------------------------------------------
     4. CHECK WINDOW — which of the 3 daily reads are we in?
     ------------------------------------------------------------------ */
  /* The read windows must follow the AD ACCOUNT's clock, not the laptop's.
     Meta rolls the advertising day over in the account timezone, so that is
     the only clock the daily rules mean anything against. Reading the browser
     clock instead silently shifts every window by your UTC offset — sitting
     in Cairo (UTC+3) against a Berlin account (UTC+2) tips you into the
     evening read an hour early, every single day, which suppresses the
     day-1 kill and price-drop calls. */
  function clockIn(date, tz) {
    if (!tz) return { h: date.getHours(), m: date.getMinutes(), dow: date.getDay() };
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit',
        weekday: 'short', hour12: false
      }).formatToParts(date);
      const get = t => (parts.find(p => p.type === t) || {}).value;
      const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      let h = parseInt(get('hour'), 10);
      if (!isFinite(h)) h = date.getHours();
      if (h === 24) h = 0;
      const m = parseInt(get('minute'), 10);
      const dow = DOW[get('weekday')];
      return { h, m: isFinite(m) ? m : 0, dow: dow === undefined ? date.getDay() : dow };
    } catch (e) {
      return { h: date.getHours(), m: date.getMinutes(), dow: date.getDay() };
    }
  }

  function detectWindow(date = new Date(), tz = null) {
    const { h, m } = clockIn(date, tz);
    if (h >= 9 && h < 15) return 'morning';                 // ~11:00 read
    if (h >= 15 && (h < 23 || (h === 23 && m < 30))) return 'evening';
    return 'midnight';                                       // 23:30 – 08:59
  }

  function dayContext(date = new Date(), tz = null) {
    const { h, m, dow } = clockIn(date, tz);                 // 0 Sun … 6 Sat
    return {
      date,
      tz,
      accountHour: h,
      accountMinute: m,
      window: detectWindow(date, tz),
      isSaturday: dow === 6,
      isSunday: dow === 0,
      isWeekend: dow === 6 || dow === 0
    };
  }

  /* ------------------------------------------------------------------
     5. FUNNEL RATIOS
     ------------------------------------------------------------------ */
  function funnel(m) {
    const clicks = num(m.clicks), lpv = num(m.lpv), atc = num(m.atc),
          ic = num(m.ic), purchases = num(m.purchases);
    const r = (a, b) => (b > 0 ? (a / b) * 100 : 0);
    const pageLoad   = r(lpv, clicks);
    const offer      = r(atc, lpv);
    const intent     = r(ic, atc);
    const completion = r(purchases, ic);
    return {
      pageLoad:   { value: round1(pageLoad),   ...grade(pageLoad,   RULES.funnel.pageLoad) },
      offer:      { value: round1(offer),      ...grade(offer,      RULES.funnel.offer) },
      intent:     { value: round1(intent),     ...grade(intent,     RULES.funnel.intent) },
      completion: { value: round1(completion), ...grade(completion, RULES.funnel.completion) }
    };
  }

  function grade(value, band) {
    /* A stage cannot convert more than everyone who reached the stage above
       it. Over 100% the two event counts are not the same people or the same
       moment — a view firing twice, organic traffic landing mid-funnel, an
       order placed on a second device. Grading it 'healthy' is how a broken
       pixel reads as a working funnel, and grading it 'alert' invents a leak
       that is not there. Neither: the ratio carries no information. */
    if (value > 100) return { status: 'impossible', target: band.good };
    if (value >= band.good) return { status: 'healthy', target: band.good };
    if (value >= band.poor) return { status: 'warning', target: band.good };
    return { status: 'alert', target: band.good };
  }

  /** The single biggest leak in the funnel, in plain language. */
  function biggestLeak(f) {
    const order = [
      ['pageLoad',   'Page speed — clicks are not reaching the page. Fix Funnelish/Shopify load time before touching budget.'],
      ['offer',      'Offer strength — they land but do not add to cart. Price, hero image or first screen is the problem.'],
      ['intent',     'Checkout intent — carts do not start checkout. Usually a shipping-cost shock.'],
      ['completion', 'Checkout completion — checkouts do not finish. Check Klarna/PayPal/Stripe and trust badges.']
    ];
    for (const [key, msg] of order) {
      if (f[key] && f[key].status === 'alert') return { stage: key, message: msg };
    }
    for (const [key, msg] of order) {
      if (f[key] && f[key].status === 'warning') return { stage: key, message: msg };
    }
    return null;
  }

  /* ------------------------------------------------------------------
     6. THE VERDICT
     ------------------------------------------------------------------
     campaign = {
       id, name, budget, status,
       daysLive,                 // days with spend > 0
       spend, purchases, revenue, roas, frequency,
       clicks, lpv, atc, ic,
       history: [{date, spend, roas}],   // oldest → newest, today last
       descaleCount              // times descaled since last profitable day
     }
     ctx = { ber, grossMargin, window, isSaturday, isSunday, currency,
             revenueSource,      // 'shopify' | 'meta' | other — see header
             atcTrackingBroken } // true when the ATC event does not fire
     ------------------------------------------------------------------ */
  function verdict(campaign, ctx) {
    const c = normalizeCampaign(campaign);
    const ber = num(ctx.ber);
    const gm = ctx.grossMargin || grossMarginFromBer(ber);
    const win = ctx.window || 'midnight';
    const f = funnel(c);
    const margin = netMarginPct(c.roas, gm);
    const profitable = ber > 0 && c.roas > ber;
    const unprofitableStreak = countUnprofitableStreak(c.history, ber);
    const notes = [];
    const locked = scalingLocked(ctx);

    /* How much this verdict actually knows. Everything below that adds
       money has to clear it. */
    const zUsed = (ctx.confidence && ctx.confidence.z) || RULES.confidence.z;
    const interval = roasInterval(c.roas, c.purchases, zUsed);
    const proven = provenAbove(interval, ber);
    const needed = ordersNeeded(c.roas, ber, zUsed);

    // ---- guard: not enough data to judge -------------------------------
    if (!ber || ber <= 0) {
      return build('NEEDS_SETUP', c, {
        headline: 'Set the BER first',
        reasons: ['No break-even ROAS for this campaign. Name it "Product | BER | Margin" or set the unit economics.'],
        rule: 'Campaign name: Productname | BER | Profit margin'
      }, f, margin, ber, notes, ctx);
    }
    if (c.spend < RULES.minSpendForVerdict) {
      return build('MONITOR', c, {
        headline: 'Too early to call',
        reasons: [`Only ${money(c.spend, ctx.currency)} spent. Let it gather data.`],
        rule: 'Do not act on noise.'
      }, f, margin, ber, notes, ctx);
    }

    /* A kill or a descale driven by comparing revenue against break-even is
       still allowed on Meta's numbers — but it is worth saying out loud that
       the comparison rests on a figure that has been wrong before. This is
       not hypothetical: SchnarchFrei was killed on a Meta ROAS of 0.24 when
       its true ROAS was 1.58 against a BER of 1.47, i.e. profitable. */
    const unverifiedCutNote = locked
      ? ['This cut is computed from Meta revenue, which is unverified. A campaign has already been killed here on a Meta figure that turned out to be profitable — confirm against Shopify if the amount matters.']
      : [];

    // ---- WEEKEND SURFSCALING ------------------------------------------
    // Applies Sat + Sun, at both the 11AM and midnight reads.
    if (ctx.isSaturday || (ctx.isSunday && win !== 'midnight')) {
      /* The original rule read one day's ROAS and multiplied the budget by
         5 or 10. At this account's order counts a 3.0 on a Saturday is
         frequently just a good Saturday, and a ×10 resets learning on every
         campaign at once — which is most of why Monday hurts.

         Surfing is a claim about weekend DEMAND. So measure the demand on
         this account's own history, and only then spend against it. */
      const ev = ctx.weekendLift || weekendLift(c.history);
      const pct = ev.reliable ? surfPctFromLift(ev.lift) : 0;
      const liftPct = ev.lift === null ? null : Math.round(ev.lift * 100);

      if (!ev.reliable) {
        notes.push(`Weekend, but there is no measured lift yet — ${ev.weekendDays} weekend day(s) and ${ev.weekdayDays} weekday(s) on file, and the rule needs ${RULES.weekend_evidence.minWeekendDays} and ${RULES.weekend_evidence.minWeekdayDays}. Surfing stays off until this account's own history shows weekends really are better. Normal rules apply.`);
      } else if (pct <= 0) {
        notes.push(`Measured weekend lift is ${liftPct}% (weekend ROAS ${ev.weekendRoas} against weekday ${ev.weekdayRoas} over ${ev.weekendDays + ev.weekdayDays} days). Weekends are not better on this account, so there is nothing to surf. Normal rules apply.`);
      } else if (locked) {
        return lockedScale(c, `a measured weekend surf of +${pct}%`, c.budget * (1 + pct / 100),
          `Weekend ROAS runs ${liftPct}% above weekday on this account (${ev.weekendRoas} against ${ev.weekdayRoas}).`,
          f, margin, ber, ctx, notes);
      } else if (!proven) {
        notes.push(`The weekend lift is real (+${liftPct}%) but this campaign has not earned the extra budget: ROAS ${c.roas.toFixed(2)} on ${c.purchases} order(s) spans ${interval ? interval.lo + '–' + interval.hi : '—'}, which still crosses break-even ${ber.toFixed(2)}. Surf the campaigns that have proved themselves, not this one.`);
      } else if (margin < SURF_MARGIN_FLOOR) {
        /* The surf amplifies the ladder; it does not bypass it. On a 6%
           margin a doubled budget buys a little more volume at a worse CPA
           and lands in the red, lift or no lift. The normal ladder already
           refuses to scale under 15% and the weekend does not change that. */
        notes.push(`Weekend lift is real (+${liftPct}%), and this campaign is genuinely profitable, but ${marginLabel(ctx).toLowerCase()} is only ${margin}% — under the ${SURF_MARGIN_FLOOR}% the ladder requires before adding budget. CPA climbs as you scale, so surfing a margin this thin ends the weekend in the red. Left alone.`);
      } else {
        return build('SURF', c, {
          headline: `Surf +${pct}%`,
          newBudget: c.budget * (1 + pct / 100),
          reasons: [
            `Weekend ROAS on this account runs ${liftPct}% above weekday — ${ev.weekendRoas} against ${ev.weekdayRoas}, measured over ${ev.weekendDays} weekend days and ${ev.weekdayDays} weekdays.`,
            `This campaign has earned it: ROAS ${c.roas.toFixed(2)} on ${c.purchases} orders, and even the low end of that range (${interval.lo}) clears break-even ${ber.toFixed(2)}.`,
            `A ${liftPct}% lift supports roughly +${pct}% budget, capped at +${RULES.weekend_evidence.maxSurfPct}%. Bigger multiples are not supported by anything measurable.`,
            'Pull back Sunday night — Monday still dips.',
            ctx.learning ? `This ad set is in learning and a +${pct}% change will reset it. On a measured lift that is a reasonable trade; on a guess it was not.` : ''
          ].filter(Boolean),
          rule: `Weekend surf, sized to a measured lift of ${liftPct}% (was: ROAS 3+ → ×5, which rested on one day)`
        }, f, margin, ber, notes, ctx);
      }
    }

    // ---- SUNDAY NIGHT PULL-BACK ---------------------------------------
    // Only winners get pulled back — they are the ones that were scaled up
    // over the weekend. A loser on Sunday night is still a loser, and falls
    // through to the normal kill / descale rules below.
    if (ctx.isSunday && win === 'midnight' && profitable) {
      const tier = RULES.weekend.sundayNight.find(t => c.roas >= t.minRoas);
      return build('DESCALE', c, {
        headline: `Sunday pull-back −${tier.descalePct}%`,
        newBudget: c.budget * (1 - tier.descalePct / 100),
        reasons: [
          `Sunday night ROAS is ${c.roas.toFixed(2)}.`,
          'Always scale back Sunday night — Monday brings a hard dip.'
        ],
        rule: `Sunday night ROAS ${tier.minRoas === 0 ? '<3' : tier.minRoas + '+'} → descale ${tier.descalePct}%`
      }, f, margin, ber, c.surfedRecently ? [] : ['No weekend scale-up recorded for this one — if you never raised its budget this weekend, leave it alone.'], ctx);
    }

    /* ================= MORNING READ (≈11:00) =========================
       Day-1 triage. On later days the morning read is diagnostic only —
       budget moves happen after midnight.
       ================================================================= */
    /* Day-1 triage is driven by SPEND, not by the clock. A day-1 campaign
       that has burnt past the decision threshold with no sales is the same
       emergency at 15:30 as it is at 11:00, so this runs in the morning AND
       evening reads. Previously it lived only inside the morning branch,
       which meant opening the dashboard after 15:00 replaced a KILL with a
       funnel diagnosis and never mentioned the campaign should be closed. */
    const dayOne = () => {
      if (c.daysLive > 1) return null;

      // decision threshold reached, no sales
      if (c.spend >= RULES.day1.decisionSpend && c.purchases === 0) {
        const atcRate = f.offer.value;

        /* The ATC event does not fire at all on the Funnelish funnels. When
           that is true, ATC rate is structurally 0 for every campaign, the
           "nobody wants the offer" branch fires every time, and the price-drop
           branch becomes unreachable — so every new product gets killed with a
           reason that is simply false. Confirmed on CM063 and CM073, where
           CM073 recorded a real purchase while reporting ATC 0.
           With ATC untracked, fall back to landing-page views: traffic that
           arrives and never buys is still a kill, but say why honestly. */
        if (ctx.atcTrackingBroken) {
          return build('KILL', c, {
            headline: 'Kill it',
            newBudget: 0,
            reasons: [
              `${money(c.spend, ctx.currency)} spent, 0 sales.`,
              `${c.lpv} landing page views produced nothing.`,
              'Add-to-cart is not being tracked on this funnel, so the price-drop test cannot be run. Judged on traffic that arrived and did not buy.'
            ],
            rule: 'Adspend ≤ 40 and 0 sales → KILL CAMPAIGN (ATC untracked, so LPV→purchase was used instead)'
          }, f, margin, ber, ['Fix the AddToCart event on this funnel — until it fires, no new campaign can ever earn the price-drop branch.'], ctx);
        }

        if (atcRate < RULES.day1.atcRateLow) {
          return build('KILL', c, {
            headline: 'Kill it',
            newBudget: 0,
            reasons: [
              `${money(c.spend, ctx.currency)} spent, 0 sales.`,
              `Add-to-cart rate is ${atcRate}% — under ${RULES.day1.atcRateLow}%. Nobody wants the offer.`
            ],
            rule: 'Adspend ≤ 40 and 0 sales with low ATC rate → KILL CAMPAIGN'
          }, f, margin, ber, notes, ctx);
        }
        // High ATC but nobody reaches checkout is a broken funnel, not a
        // price objection — dropping the price on it just burns €30 more.
        const stalled = c.atc >= 5 && c.ic === 0;
        if (stalled) {
          return build('KILL', c, {
            headline: 'Stop it — the checkout is not receiving anyone',
            newBudget: 0,
            reasons: [
              `${money(c.spend, ctx.currency)} spent, 0 sales, and ${c.atc} add-to-carts produced 0 checkouts.`,
              'Cart-to-checkout is 0%. That is a broken step, not a price objection — a discount cannot fix it.',
              'Pause it, fix the checkout, then retest at full price.'
            ],
            rule: 'Adspend ≤ 40 and 0 sales → kill; price drop only applies when the funnel still works'
          }, f, margin, ber, notes, ctx);
        }
        return build('PRICE_DROP', c, {
          headline: 'Cut the price 20–30%, give it €30 more',
          newBudget: c.budget,
          reasons: [
            `${money(c.spend, ctx.currency)} spent, 0 sales — but ATC rate is ${atcRate}%, which is healthy.`,
            'People want it, the price is the blocker. Drop the price 20–30% and allow another €30 of spend.',
            'Still no sale after that extra €30 → kill it.'
          ],
          rule: 'Adspend ≤ 40 and 0 sales with high ATC rate → lower price 20-30%, spend another 30'
        }, f, margin, ber, notes, ctx);
      }
      // sales are coming in — let it prove itself
      if (c.purchases >= 1 && c.spend < RULES.day1.proveWindow[0]) {
        return build('PROVE', c, {
          headline: `Let it run to €${RULES.day1.proveWindow[0]}–${RULES.day1.proveWindow[1]}`,
          newBudget: c.budget,
          reasons: [
            `${c.purchases} sale${c.purchases > 1 ? 's' : ''} at ${money(c.spend, ctx.currency)}. Do not touch the budget.`,
            `By ${money(RULES.day1.proveWindow[1], ctx.currency)} it must be at or above break-even (ROAS ${ber.toFixed(2)}) or it dies tonight.`
          ],
          rule: 'Adspend ≤ 40 and 1+ sales → let it spend until 80-90'
        }, f, margin, ber, notes, ctx);
      }
      // past the prove window
      if (c.spend >= RULES.day1.proveWindow[0] && !profitable) {
        return build('KILL', c, {
          headline: 'Kill it',
          newBudget: 0,
          reasons: [
            `${money(c.spend, ctx.currency)} spent and ROAS ${c.roas.toFixed(2)} is still below break-even ${ber.toFixed(2)}.`,
            'It had its chance in the 80–90 window.'
          ],
          rule: 'By 80-90 it should be profitable or break-even. If not → KILL CAMPAIGN'
        }, f, margin, ber, unverifiedCutNote, ctx);
      }
      return null;
    };

    if (win === 'morning') {
      const d1 = dayOne();
      if (d1) return d1;
      // Day 2+ morning = watch only
      return build('MONITOR', c, {
        headline: profitable ? 'On track — no midday changes' : 'Watch it — decision comes tonight',
        reasons: [
          profitable
            ? `ROAS ${c.roas.toFixed(2)} is above break-even ${ber.toFixed(2)}.`
            : `ROAS ${c.roas.toFixed(2)} is under break-even ${ber.toFixed(2)}. If it stays there, descale after midnight.`,
          'Budget changes belong to the midnight read, not the midday one.'
        ],
        rule: 'Day 1 analysis around 11AM; scaling decisions after 12AM'
      }, f, margin, ber, notes, ctx);
    }

    /* ================= EVENING READ ==================================
       Funnel quality. Never a budget move — this read tells you what to
       fix on the page, not what to do with money.
       ================================================================= */
    if (win === 'evening') {
      const d1 = dayOne();
      if (d1) return d1;
      const leak = biggestLeak(f);
      const line = `Page speed ${f.pageLoad.value}% · Offer ${f.offer.value}% · Intent ${f.intent.value}% · Completion ${f.completion.value}%`;
      /* A stage reading over 100% is not a clean funnel — it is a funnel you
         cannot read. Saying "clean" there sends him away satisfied from a
         broken pixel. */
      const broken = ['pageLoad', 'offer', 'intent', 'completion']
        .filter(k => f[k] && f[k].status === 'impossible');
      if (!leak && broken.length) {
        return build('DIAGNOSE', c, {
          headline: 'Funnel cannot be read',
          reasons: [
            `${broken.map(stageLabel).join(' and ')} reads over 100%, which is impossible — those events are not counting the same people. Fix the tracking before judging the page.`,
            line
          ],
          rule: 'Evening check = funnel quality. No budget changes.'
        }, f, margin, ber, notes, ctx);
      }
      return build('DIAGNOSE', c, {
        headline: leak ? `Fix: ${stageLabel(leak.stage)}` : 'Funnel is clean',
        reasons: leak
          ? [leak.message, line]
          : ['Every stage of the funnel is inside benchmark. Nothing to fix on the page tonight.', line],
        rule: 'Evening check = funnel quality. No budget changes.'
      }, f, margin, ber, notes, ctx);
    }

    /* ================= MIDNIGHT READ (after 00:00) ===================
       Scale, keep, descale or kill.
       ================================================================= */
    if (profitable) {
      const tier = RULES.scale.tiers.find(t => margin > t.minMargin) || RULES.scale.tiers[RULES.scale.tiers.length - 1];
      if (ctx.learning && tier.pct > RULES.learning.safeBudgetChangePct) {
        notes.push(`Still in learning. A +${tier.pct}% change counts as a significant edit and restarts it — +${RULES.learning.safeBudgetChangePct}% (${money(c.budget * 1.2, ctx.currency)}) stays under the threshold if you would rather protect the learning it has already done.`);
      } else if (ctx.learning && tier.pct > 0) {
        notes.push(`Still in learning, but +${tier.pct}% is under the threshold that resets it. Safe to apply.`);
      }
      if (tier.pct === 0) {
        return build('HOLD', c, {
          headline: 'Profitable but thin — do not touch',
          newBudget: c.budget,
          reasons: [
            `ROAS ${c.roas.toFixed(2)} beats break-even ${ber.toFixed(2)}, so it makes money.`,
            `But ${marginLabel(ctx).toLowerCase()} is only ${margin}% — under 15%. Scaling now would eat the margin.`,
            'Leave the budget exactly where it is and let it optimise.'
          ],
          rule: 'ROAS > BER and profit margin < 15% → DON\'T CHANGE BUDGET, LET IT RUN'
        }, f, margin, ber, notes.concat(creativeNote(c)), ctx);
      }
      if (locked) {
        return lockedScale(c, `+${tier.pct}%`, c.budget * (1 + tier.pct / 100),
          `ROAS ${c.roas.toFixed(2)} is above break-even ${ber.toFixed(2)} and ${marginLabel(ctx).toLowerCase()} is ${margin}%.`,
          f, margin, ber, ctx, notes.concat(creativeNote(c)));
      }
      if (!proven) {
        return notYetProven(c, `+${tier.pct}%`, c.budget * (1 + tier.pct / 100),
          interval, needed, f, margin, ber, ctx, notes.concat(creativeNote(c)));
      }
      return build('SCALE', c, {
        headline: `Scale +${tier.pct}%`,
        newBudget: c.budget * (1 + tier.pct / 100),
        reasons: [
          `ROAS ${c.roas.toFixed(2)} is above break-even ${ber.toFixed(2)}.`,
          `${marginLabel(ctx)} is ${margin}% ${tier.minMargin === 20 ? '(over 20%)' : '(15–20%)'} → increase budget ${tier.pct}%.`
        ],
        rule: `ROAS > BER and profit margin ${tier.minMargin === 20 ? '> 20%' : '= 15-20%'} → +${tier.pct}% BUDGET INCREASE`
      }, f, margin, ber, notes.concat(creativeNote(c)), ctx);
    }

    // Unprofitable
    if (c.daysLive <= 1) {
      return build('KILL', c, {
        headline: 'Kill it',
        newBudget: 0,
        reasons: [
          `Day 1 closed at ROAS ${c.roas.toFixed(2)}, under break-even ${ber.toFixed(2)}.`,
          'Day-1 losers get killed, not descaled.'
        ],
        rule: 'Day 1 at night: ROAS < BER (unprofitable) → KILL CAMPAIGN'
      }, f, margin, ber, notes.concat(unverifiedCutNote), ctx);
    }

    if (unprofitableStreak >= RULES.descale.killAfterUnprofitableDays && c.descaleCount >= 2) {
      return build('KILL', c, {
        headline: 'Kill it — it had two chances',
        newBudget: 0,
        reasons: [
          `Unprofitable ${unprofitableStreak} days in a row and already descaled ${c.descaleCount} times.`,
          'Test new creatives or move to the next product.'
        ],
        rule: 'Unprofitable 2 days in a row after descaling twice → KILL CAMPAIGN and test new creatives'
      }, f, margin, ber, notes.concat(unverifiedCutNote), ctx);
    }

    /* Cutting needs a reasonable sample, not proof. Below break-even means
       money is leaving now, so waiting for statistical certainty is itself
       expensive — but three orders is not a sample. Zero orders never
       blocks a cut: zero is conclusive on its own. */
    if (c.purchases > 0 && c.purchases < RULES.confidence.minOrdersToCut) {
      return build('HOLD', c, {
        headline: 'Too few orders to cut on',
        newBudget: c.budget,
        reasons: [
          `ROAS ${c.roas.toFixed(2)} is under break-even ${ber.toFixed(2)}, but it rests on ${c.purchases} order${c.purchases === 1 ? '' : 's'}.`,
          interval ? `That puts the real figure somewhere between ${interval.lo} and ${interval.hi} — a range wide enough to contain a perfectly healthy campaign.` : '',
          `Cutting needs ${RULES.confidence.minOrdersToCut} orders in the window. Leave it, or widen the window to three days and look again.`
        ].filter(Boolean),
        rule: `A descale needs at least ${RULES.confidence.minOrdersToCut} orders behind it`
      }, f, margin, ber, notes, ctx);
    }

    const superBad = c.roas < ber * RULES.descale.superUnprofitableRatio && unprofitableStreak >= 2;
    const pct = superBad ? RULES.descale.hardDescalePct : RULES.descale.pct;
    return build('DESCALE', c, {
      headline: `Descale −${pct}%`,
      newBudget: c.budget * (1 - pct / 100),
      reasons: [
        `ROAS ${c.roas.toFixed(2)} is below break-even ${ber.toFixed(2)} (margin ${margin}%).`,
        superBad
          ? 'Deeply unprofitable and never consistent — cut harder than the standard 40%.'
          : 'Cut 40% and let it re-optimise tomorrow.',
        unprofitableStreak >= 1 ? `Unprofitable ${unprofitableStreak} day(s) running. One more and it dies.` : ''
      ].filter(Boolean),
      rule: 'ROAS < BER (unprofitable) → DESCALE WITH 40%, let it optimize the next day'
    }, f, margin, ber, notes.concat(unverifiedCutNote), ctx);
  }

  /* A scale the ladder earned but the revenue cannot justify. Shown as a HOLD
     so no money moves, but the card still says what it would have been — the
     number is the whole point, because it is what you get back by fixing
     tracking. */
  function lockedScale(c, intended, wouldBe, because, f, margin, ber, ctx, notes) {
    return build('HOLD', c, {
      headline: 'Scaling locked — revenue unverified',
      newBudget: c.budget,
      reasons: [
        because,
        `On these numbers the ladder says ${intended} (${money(c.budget, ctx.currency)} → ${money(wouldBe, ctx.currency)}).`,
        UNVERIFIED_WHY,
        'Confirm this campaign against the Shopify order book, then the scale unlocks. Killing and descaling stay available — those do not need exact revenue.'
      ],
      rule: 'Scaling requires Shopify-verified revenue. Meta alone can kill or descale, never scale.'
    }, f, margin, ber, (notes || []).concat([
      `Held at ${money(c.budget, ctx.currency)}. The locked move was ${intended}.`
    ]), ctx);
  }

  /* The ladder earned a scale, the revenue is verified, and the sample
     still cannot tell this campaign apart from break-even. Holding is the
     answer, but a silent hold teaches nothing — so the card says what the
     move would have been and how much more data would settle it. */
  function notYetProven(c, intended, wouldBe, interval, needed, f, margin, ber, ctx, notes) {
    const short = needed && interval ? Math.max(0, needed - interval.orders) : null;
    return build('HOLD', c, {
      headline: 'Not proven yet — hold',
      newBudget: c.budget,
      reasons: [
        `ROAS ${c.roas.toFixed(2)} beats break-even ${ber.toFixed(2)} on the face of it, and the ladder would say ${intended} (${money(c.budget, ctx.currency)} → ${money(wouldBe, ctx.currency)}).`,
        interval
          ? `But it rests on ${interval.orders} order${interval.orders === 1 ? '' : 's'}, so the real figure is somewhere between ${interval.lo} and ${interval.hi} — and that range still crosses break-even.`
          : 'There are no orders behind this figure yet.',
        short !== null && short > 0
          ? `About ${needed} orders in the window would settle it; this has ${interval.orders}, so roughly ${short} more at the current rate.`
          : 'Give it more volume in the window before adding budget.',
        'Adding budget now is a bet on noise. The campaign is not losing money — leave it to accumulate evidence.'
      ].filter(Boolean),
      rule: 'A scale requires the low end of the ROAS range to clear break-even'
    }, f, margin, ber, notes, ctx);
  }

  function creativeNote(c) {
    return c.profitableStreak >= RULES.guardrails.creativeRefreshAfterProfitableDays
      ? [`Profitable ${c.profitableStreak} days running — time to test new creatives and scale horizontally.`]
      : [];
  }

  /* ------------------------------------------------------------------
     6b. DELIVERY ALARMS
     The expensive failures are not bad ROAS — they are ads that stopped
     running while you were asleep. These check that money is moving at all.
     ------------------------------------------------------------------ */
  function deliveryAlarms(campaigns, ads, opts) {
    const o = opts || {};
    const out = [];

    // Only ads inside a live campaign matter. An account accumulates years of
    // rejected ads in paused campaigns; counting those turns the alarm into
    // noise, and an alarm that cries wolf gets ignored exactly when it is right.
    const liveCampaignIds = new Set(
      (campaigns || [])
        .filter(c => (c.status || '').toUpperCase() === 'ACTIVE')
        .map(c => c.id)
        .filter(Boolean));

    const inLiveCampaign = a =>
      !a.campaignId || liveCampaignIds.size === 0 || liveCampaignIds.has(a.campaignId);

    const disapproved = (ads || []).filter(a =>
      /DISAPPROVED|WITH_ISSUES|PENDING_REVIEW/i.test(a.effectiveStatus || '') &&
      !/CAMPAIGN_PAUSED|ADSET_PAUSED/i.test(a.effectiveStatus || '') &&
      inLiveCampaign(a));
    if (disapproved.length) {
      const rejected = disapproved.filter(a => /DISAPPROVED/i.test(a.effectiveStatus));
      out.push({
        severity: 'alert',
        title: rejected.length
          ? `${rejected.length} ad${rejected.length === 1 ? '' : 's'} rejected by Meta`
          : `${disapproved.length} ad${disapproved.length === 1 ? '' : 's'} held in review`,
        body: `${disapproved.map(a => a.name).slice(0, 4).join(', ')}${disapproved.length > 4 ? '…' : ''} — these are not delivering. Fix or replace them before judging the campaign's numbers.`
      });
    }

    // Live campaign, real budget, nothing spent — delivery has stopped.
    const stalled = (campaigns || []).filter(c =>
      (c.status || '').toUpperCase() === 'ACTIVE' &&
      c.budget > 0 &&
      c.spend < c.budget * 0.02 &&
      (c.history || []).some(d => num(d.spend) > 0));
    if (stalled.length) {
      out.push({
        severity: 'alert',
        title: `${stalled.length} campaign${stalled.length === 1 ? '' : 's'} stopped delivering`,
        body: `${stalled.map(c => c.name).join(', ')} — active with a budget but almost no spend today, and ${stalled.length === 1 ? 'it' : 'they'} spent on previous days. Check for rejected ads, a payment problem, or a paused ad set.`
      });
    }

    // Paused campaigns that were spending — did you mean to pause this?
    const paused = (campaigns || []).filter(c =>
      /PAUSED/i.test(c.status || '') && (c.history || []).some(d => num(d.spend) > 0));
    if (paused.length) {
      out.push({
        severity: 'warning',
        title: `${paused.length} campaign${paused.length === 1 ? '' : 's'} paused`,
        body: `${paused.map(c => c.name).join(', ')} — ${paused.length === 1 ? 'was' : 'were'} spending recently and ${paused.length === 1 ? 'is' : 'are'} now off. If that was not you, something paused it.`
      });
    }

    // Under-delivery: the auction cannot fill the budget you set.
    const under = (campaigns || []).filter(c =>
      (c.status || '').toUpperCase() === 'ACTIVE' &&
      c.budget > 0 && c.spend > c.budget * 0.05 &&
      c.spend < c.budget * RULES.pacing.underDelivering &&
      o.dayIsOver);
    if (under.length) {
      out.push({
        severity: 'warning',
        title: `${under.length} campaign${under.length === 1 ? '' : 's'} under-spending`,
        body: `${under.map(c => `${c.name} (${Math.round((c.spend / c.budget) * 100)}% of budget)`).join(', ')} — the auction cannot fill the budget. Usually fatigued creative or too narrow a bid, not a budget problem.`
      });
    }

    const learning = (campaigns || []).filter(c => c.learning);
    if (learning.length) {
      out.push({
        severity: 'info',
        title: `${learning.length} campaign${learning.length === 1 ? '' : 's'} still in learning`,
        body: `${learning.map(c => productLabel(c.name)).join(' · ')} — a budget change over ${RULES.learning.safeBudgetChangePct}% restarts learning. Scaling nightly means campaigns rarely leave it, which is a normal cost of this playbook, not a fault. Verdicts still tell you to scale; they just say what it costs.`
      });
    }

    return out;
  }

  /* ------------------------------------------------------------------
     7. ACCOUNT-LEVEL GUARDRAILS (ban prevention + fatigue)
     ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------
     DELIVERY, PER CAMPAIGN
     ------------------------------------------------------------------
     The account-wide alarm says "2 ads rejected". That is not enough to act
     on: you need to know WHICH campaign, WHY Meta refused, and whether
     anything in that campaign is still running. A campaign whose only two
     ads are rejected is not a weak campaign — it is a switched-off one, and
     judging its ROAS is judging nothing.

     ads    = [{ name, campaignId, effectiveStatus, issues, reviewFeedback }]
     adsets = [{ name, campaignId, effectiveStatus, issues }]            */
  const OFF_ON_PURPOSE = /^(PAUSED|ADSET_PAUSED|CAMPAIGN_PAUSED|ARCHIVED|DELETED)$/;

  /* Meta explains a refusal in one of two places. ad_review_feedback is a map
     of policy name -> explanation; issues_info is a list of error objects.
     Whichever is present, return one readable line. */
  function reviewReason(item) {
    const fb = item && item.reviewFeedback;
    const g = fb && (fb.global || fb.placement_specific || fb);
    if (g && typeof g === 'object') {
      const parts = Object.keys(g).map(k => {
        const v = g[k];
        if (v && typeof v === 'object') return Object.keys(v).join(', ');
        const name = String(k).replace(/_/g, ' ').trim();
        /* Meta's explanation runs to a paragraph of boilerplate. The policy
           name is the signal; one sentence of the text is enough context. */
        const why = (String(v || '').trim().match(/^[^.!?]*[.!?]?/) || [''])[0].trim();
        return why && why.toLowerCase() !== name.toLowerCase() ? `${name}: ${why}` : name;
      }).filter(Boolean);
      if (parts.length) return parts.join(' · ');
    }
    const issues = (item && item.issues) || [];
    const lines = issues.map(i => (i && (i.error_summary || i.error_message)) || '').filter(Boolean);
    return lines.length ? [...new Set(lines)].join(' · ') : '';
  }

  function campaignDelivery(campaign, ads, adsets) {
    const id = campaign && campaign.id;
    const mine = (ads || []).filter(a => a.campaignId === id);
    const considered = mine.filter(a => !OFF_ON_PURPOSE.test((a.effectiveStatus || '').toUpperCase()));
    const pick = re => considered
      .filter(a => re.test((a.effectiveStatus || '').toUpperCase()))
      .map(a => ({ name: a.name, reason: reviewReason(a) }));

    const rejected   = pick(/^DISAPPROVED$/);
    const inReview   = pick(/^(PENDING_REVIEW|IN_PROCESS)$/);
    const withIssues = pick(/^WITH_ISSUES$/);
    const billing    = pick(/^PENDING_BILLING_INFO$/);
    const delivering = considered.filter(a => (a.effectiveStatus || '').toUpperCase() === 'ACTIVE').length;

    const adsetIssues = (adsets || [])
      .filter(s => s.campaignId === id)
      .filter(s => /^WITH_ISSUES$/.test((s.effectiveStatus || '').toUpperCase()) || ((s.issues || []).length > 0))
      .filter(s => !OFF_ON_PURPOSE.test((s.effectiveStatus || '').toUpperCase()))
      .map(s => ({ name: s.name, reason: reviewReason(s) }));

    /* A campaign Meta marks WITH_ISSUES is one that is meant to be running. */
    const cStatus = ((campaign && campaign.status) || '').toUpperCase();
    const live = /^(ACTIVE|WITH_ISSUES|IN_PROCESS)$/.test(cStatus);
    const campaignIssues = reviewReason({ issues: campaign && campaign.issues }) ||
      (cStatus === 'WITH_ISSUES' ? 'Meta reports a problem with this campaign' : '');
    const blocked = rejected.length + inReview.length + withIssues.length + billing.length;

    /* Nothing running in a campaign that is meant to be live. */
    const allBlocked = live && considered.length > 0 && delivering === 0;

    let severity = null, headline = '';
    const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    if (allBlocked) {
      severity = 'alert';
      headline = 'No ad is delivering';
    } else if (rejected.length || billing.length) {
      severity = 'alert';
      headline = rejected.length ? n(rejected.length, 'ad rejected', 'ads rejected') : 'Billing is blocking delivery';
    } else if (withIssues.length || adsetIssues.length || campaignIssues) {
      severity = 'warning';
      headline = withIssues.length ? n(withIssues.length, 'ad has a delivery issue', 'ads have delivery issues')
        : adsetIssues.length ? 'Ad set has a delivery issue' : 'Campaign has a delivery issue';
    } else if (inReview.length) {
      severity = 'info';
      headline = n(inReview.length, 'ad still in review', 'ads still in review');
    }

    return {
      severity, headline, allBlocked,
      rejected, inReview, withIssues, billing, adsetIssues, campaignIssues,
      delivering, considered: considered.length, blocked,
      /* The numbers on the card describe only the ads that ran. */
      note: !severity ? ''
        : allBlocked ? 'Every ad in this campaign is stopped, so the figures on this card are not a verdict on the product. Fix delivery first.'
        : rejected.length ? `${delivering} of ${considered.length} ads are running. The card is judging the survivors, not the creative set you launched.`
        : ''
    };
  }

  /* ------------------------------------------------------------------
     ACCOUNT HEALTH — the problems that stop everything at once
     ------------------------------------------------------------------ */
  const ACCOUNT_STATUS = {
    2: ['alert', 'Ad account is DISABLED', 'Meta has disabled this ad account. Nothing will deliver until it is reinstated — check Account Quality.'],
    3: ['alert', 'Ad account has an unpaid balance', 'A payment failed and the account is unsettled. Delivery is stopped or about to stop — settle the balance in Billing.'],
    7: ['alert', 'Ad account is in risk review', 'Meta is reviewing this account. Delivery can be limited or stopped until the review ends.'],
    8: ['warning', 'Ad account is waiting on a payment', 'A payment is pending settlement. Delivery continues but will stop if it fails.'],
    9: ['warning', 'Ad account is in a payment grace period', 'A payment failed and Meta is giving a grace period. Fix the payment method before it runs out.'],
    100: ['alert', 'Ad account is pending closure', 'This account is scheduled to close.'],
    101: ['alert', 'Ad account is CLOSED', 'This account is closed and cannot deliver.']
  };
  const DISABLE_REASON = {
    1: 'ads integrity policy', 2: 'intellectual property review', 3: 'payment risk',
    4: 'account shut down', 5: 'advertising review', 6: 'business integrity review',
    7: 'permanent closure', 11: 'Business Manager policy', 12: 'misrepresentation',
    15: 'compromised account'
  };

  function accountHealth(account) {
    const out = [];
    if (!account) return out;
    const label = account.name ? `${account.name}: ` : '';

    const st = ACCOUNT_STATUS[parseInt(account.account_status, 10)];
    if (st) {
      const why = DISABLE_REASON[parseInt(account.disable_reason, 10)];
      out.push({ severity: st[0], title: label + st[1], body: st[2] + (why ? ` Reason Meta gives: ${why}.` : '') });
    }

    /* The spending limit stops ALL delivery the moment it is reached, with no
       notice on any campaign. Both figures are in the same unit, so the ratio
       is safe whatever that unit is. */
    const cap = num(account.spend_cap), spent = num(account.amount_spent);
    if (cap > 0) {
      const used = spent / cap;
      if (used >= 1) {
        out.push({ severity: 'alert', title: label + 'Account spending limit reached',
          body: 'The account has hit its spending limit, so every campaign has stopped. Raise or reset the limit in Billing & payments.' });
      } else if (used >= 0.9) {
        out.push({ severity: 'warning', title: `${label}${Math.round(used * 100)}% of the account spending limit is used`,
          body: 'When the limit is reached every campaign stops at once. Raise or reset it in Billing & payments before it does.' });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------
     BREAKDOWNS — country, placement
     ------------------------------------------------------------------
     rows = [{ key, label, spend, impressions, clicks, purchases, revenue }]
     Purchases here are Meta-attributed: Shopify cannot say which placement
     an order came from. So the flags are prompts to look, sized against the
     account's own cost per order, and they stay silent on thin evidence. */
  function breakdown(rows, opts) {
    const o = opts || {};
    const by = {};
    (rows || []).forEach(r => {
      const k = r.key || '—';
      const t = by[k] || (by[k] = { key: k, label: r.label || k, spend: 0, impressions: 0, clicks: 0, purchases: 0, revenue: 0 });
      t.spend += num(r.spend); t.impressions += num(r.impressions); t.clicks += num(r.clicks);
      t.purchases += num(r.purchases); t.revenue += num(r.revenue);
    });
    const list = Object.values(by).filter(r => r.spend > 0 || r.purchases > 0);
    const totalSpend = list.reduce((s, r) => s + r.spend, 0);
    const totalPurchases = list.reduce((s, r) => s + r.purchases, 0);
    const totalRevenue = list.reduce((s, r) => s + r.revenue, 0);

    /* Meta sometimes withholds conversions on a breakdown. If the parent has
       orders and the rows have none, the zeros are missing data, not facts. */
    const expected = num(o.expectedPurchases);
    const conversionsReported = totalPurchases > 0 || expected === 0;
    const cpaAll = totalPurchases > 0 ? totalSpend / totalPurchases : 0;

    const out = list.map(r => {
      const cpa = r.purchases > 0 ? r.spend / r.purchases : null;
      const row = {
        key: r.key, label: r.label,
        spend: round2(r.spend),
        sharePct: totalSpend > 0 ? round1((r.spend / totalSpend) * 100) : 0,
        impressions: r.impressions, clicks: r.clicks,
        purchases: r.purchases, revenue: round2(r.revenue),
        cpa: cpa === null ? null : round2(cpa),
        roas: r.spend > 0 && r.revenue > 0 ? round2(r.revenue / r.spend) : null,
        flag: null, flagText: ''
      };
      if (conversionsReported && cpaAll > 0) {
        if (r.purchases === 0 && r.spend >= cpaAll * 2) {
          row.flag = 'bleed';
          row.flagText = `Spent ${(r.spend / cpaAll).toFixed(1)}× the average cost of an order with no sale`;
        } else if (r.purchases >= 3 && cpa <= cpaAll * 0.75) {
          row.flag = 'strong';
          row.flagText = `Orders cost ${Math.round((1 - cpa / cpaAll) * 100)}% less here than average`;
        } else if (r.purchases >= 3 && cpa >= cpaAll * 1.5) {
          row.flag = 'weak';
          row.flagText = `Orders cost ${Math.round((cpa / cpaAll - 1) * 100)}% more here than average`;
        }
      }
      return row;
    }).sort((a, b) => b.spend - a.spend);

    return {
      rows: out,
      totalSpend: round2(totalSpend), totalPurchases, totalRevenue: round2(totalRevenue),
      avgCpa: cpaAll ? round2(cpaAll) : null,
      conversionsReported
    };
  }

  /* ------------------------------------------------------------------
     THE SPEND CURVE — where does this campaign stop paying for more budget?
     ------------------------------------------------------------------
     The ladder asks "is today profitable?". It cannot ask "was the LAST
     increase worth it?", and that is the question that matters when scaling
     keeps disappointing. A campaign at ROAS 2.2 on €250 a day can out-earn
     the same campaign at ROAS 1.7 on €450 a day: the bigger budget still
     looks profitable, and it is quietly making less money.

     So: take the campaign's own closed days, sort them by spend, cut them
     into a low, middle and high third, and compare PROFIT PER DAY — not
     ROAS — across the three. Revenue here is what Meta reported per day;
     Shopify is not split by day, so this reads the shape, not the cents.

     history = [{ date, spend, revenue, purchases? }]                      */
  const eur0 = v => '€' + Math.round(num(v));

  function spendCurve(history, ber) {
    const cfg = RULES.curve;
    const gm = num(ber) > 0 ? 1 / num(ber) : 0;
    const days = (history || [])
      .filter(d => d && d.date !== 'today' && num(d.spend) > 0)
      .map(d => ({ spend: num(d.spend), revenue: num(d.revenue),
                   purchases: d.purchases === undefined ? null : num(d.purchases) }));

    if (!gm) return { state: 'thin', days: days.length, reason: 'No break-even on file, so profit per day cannot be worked out.' };
    if (days.length < cfg.minDays) {
      return { state: 'thin', days: days.length,
               reason: `Only ${days.length} day${days.length === 1 ? '' : 's'} of history — it takes at least ${cfg.minDays} to see where extra budget stops paying.` };
    }

    days.sort((a, b) => a.spend - b.spend);
    const lo = days[0].spend, hi = days[days.length - 1].spend;
    if (hi / lo < cfg.minSpread) {
      return { state: 'flat', days: days.length,
               reason: `The budget has stayed between ${eur0(lo)} and ${eur0(hi)} a day, so there is nothing to compare yet. The ceiling only shows once spend has been at clearly different levels.` };
    }

    const third = Math.floor(days.length / 3);
    const cuts = [days.slice(0, third), days.slice(third, days.length - third), days.slice(days.length - third)];
    const knowsOrders = days.every(d => d.purchases !== null);
    const bands = cuts.map((list, i) => {
      const spend = list.reduce((s, d) => s + d.spend, 0);
      const revenue = list.reduce((s, d) => s + d.revenue, 0);
      return {
        level: ['low', 'middle', 'high'][i],
        days: list.length,
        from: round2(list[0].spend), to: round2(list[list.length - 1].spend),
        spendPerDay: round2(spend / list.length),
        roas: spend > 0 ? round2(revenue / spend) : 0,
        orders: knowsOrders ? list.reduce((s, d) => s + d.purchases, 0) : null,
        profitPerDay: round2((revenue * gm - spend) / list.length)
      };
    });

    const thinBand = bands.find(b => b.days < cfg.minDaysPerBand ||
                                     (b.orders !== null && b.orders < cfg.minOrdersPerBand));
    if (thinBand) {
      return { state: 'thin', days: days.length, bands,
               reason: `Too few orders at the ${thinBand.level} spend level to trust the comparison${thinBand.orders !== null ? ` (${thinBand.orders} orders in ${thinBand.days} days)` : ''}. The pattern needs more volume before it means anything.` };
    }

    const top = bands[2];
    const best = bands.reduce((a, b) => (b.profitPerDay > a.profitPerDay ? b : a));
    const base = { days: days.length, bands, best, top };

    if (best.profitPerDay <= 0) {
      return { ...base, state: 'unprofitable',
               reason: 'No spend level has been profitable on these days, so there is no sweet spot to find — the offer or the creative has to change first.' };
    }
    if (best === top) {
      return { ...base, state: 'room',
               reason: `Profit per day has been highest at the highest spend level so far (${eur0(top.from)}–${eur0(top.to)} a day). No ceiling found yet.` };
    }
    const gap = best.profitPerDay - top.profitPerDay;
    if (gap >= Math.max(cfg.dropAbs, Math.abs(best.profitPerDay) * cfg.dropPct / 100) && top.roas < best.roas) {
      return { ...base, state: 'ceiling',
               ceiling: { from: best.from, to: best.to, typical: best.spendPerDay },
               reason: `This campaign has earned most at ${eur0(best.from)}–${eur0(best.to)} a day (about ${eur0(best.profitPerDay)} profit a day at ROAS ${best.roas}). At ${eur0(top.from)}–${eur0(top.to)} a day it earned ${eur0(top.profitPerDay)} a day at ROAS ${top.roas} — more spend, not more money.` };
    }
    return { ...base, state: 'unclear',
             reason: 'Profit per day is about the same at every spend level it has run at, so the history does not point to a ceiling either way.' };
  }

  /* Turn the curve into a decision. A scale that would push the budget past
     the level where the campaign earned most is not a scale — it is the move
     that has already been tried and lost money. The cheat sheet's answer is
     the same one: find the sweet spot, then widen with new creatives. */
  function applyCeiling(v, curve) {
    if (!v || !curve || curve.state !== 'ceiling') return v;
    const top = curve.ceiling.to * RULES.curve.overshoot;
    const raising = v.budgetTo !== null && v.budgetFrom !== null && v.budgetTo > v.budgetFrom;

    if (raising && v.budgetTo > top) {
      return {
        ...v,
        code: 'HOLD', tone: TONE.HOLD || 'neutral',
        headline: 'At its ceiling — add creatives, not budget',
        ceilingBlocked: { wouldHaveBeen: v.code, budgetTo: v.budgetTo },
        budgetTo: null, budgetDelta: null,
        reasons: [
          `Today is profitable, and the ladder would raise the budget to ${eur0(v.budgetTo)}. But ${curve.reason.charAt(0).toLowerCase()}${curve.reason.slice(1)}`,
          'More budget on the same ads has already been tried here. The way up is new creatives: they reach people the current ads do not.'
        ],
        rule: 'If performance drops after scaling, find the budget sweet spot and test new creatives.'
      };
    }
    if (v.budgetFrom !== null && v.budgetFrom > top && v.budgetTo === null) {
      return {
        ...v,
        notes: (v.notes || []).concat(
          `The budget (${eur0(v.budgetFrom)}) is above the level this campaign has earned most at (${eur0(curve.ceiling.from)}–${eur0(curve.ceiling.to)} a day). If it stays weak, bring it back toward ${eur0(curve.ceiling.to)} rather than cutting it hard.`)
      };
    }
    return v;
  }

  function guardrails(campaigns) {
    const out = [];

    // Ban prevention is a per-ad-account rule, so count per account.
    const byAccount = {};
    campaigns.filter(c => (c.status || '').toUpperCase() === 'ACTIVE')
      .forEach(c => {
        const key = c.accountId || 'this account';
        (byAccount[key] = byAccount[key] || { name: c.accountName || key, n: 0 }).n++;
      });
    const crowded = Object.values(byAccount).filter(a => a.n > RULES.guardrails.maxActiveCampaignsPerAccount);
    if (crowded.length) {
      out.push({
        severity: 'alert',
        title: crowded.length === 1
          ? `${crowded[0].n} active campaigns in ${crowded[0].name}`
          : `${crowded.length} ad accounts are over the campaign limit`,
        body: `${crowded.map(a => `${a.name}: ${a.n}`).join(' · ')}. Keep it to ${RULES.guardrails.maxActiveCampaignsPerAccount} per account. One page, one domain, one profile, 2–3 campaigns — this is what keeps you unbanned.`
      });
    }
    const fatigued = campaigns.filter(c => num(c.frequency) > RULES.frequency.fatigue);
    if (fatigued.length) {
      out.push({
        severity: 'warning',
        title: `${fatigued.length} campaign(s) past frequency ${RULES.frequency.fatigue}`,
        body: `${fatigued.map(c => c.name).join(', ')} — the same people keep seeing it. Refresh the creative before the CPM climbs.`
      });
    }
    const unnamed = campaigns.filter(c => !parseCampaignName(c.name).conforms);
    if (unnamed.length) {
      out.push({
        severity: 'warning',
        title: `${unnamed.length} campaign${unnamed.length === 1 ? ' has' : 's have'} no break-even ROAS in the name`,
        body: `${unnamed.map(c => c.name).join(' · ')} — falling back to your unit economics, which may be wrong for ${unnamed.length === 1 ? 'this product' : 'these products'}. Put the BER in the campaign name as a decimal, e.g. "… | 1.58".`
      });
    }

    // Show what was read out of each name. A silently mis-parsed BER makes
    // every verdict wrong, so it has to be visible rather than trusted.
    const parsed = campaigns
      .map(c => ({ name: c.name, p: parseCampaignName(c.name) }))
      .filter(x => x.p.conforms);
    if (parsed.length) {
      out.push({
        severity: 'info',
        title: 'Break-even ROAS read from campaign names',
        body: parsed.map(x => `${productLabel(x.name)} → ${x.p.ber.toFixed(2)}`).join(' · ') +
              '. Check these are right — every verdict depends on them.'
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------
     7b. WINDOW AGREEMENT
     ------------------------------------------------------------------
     A single closed day is a noisy sample, and a multi-day pool hides a
     campaign that just turned. Neither is wrong, but quietly picking
     whichever one supports the answer you already wanted is. This returns
     the two verdicts side by side so the card can say when they disagree.

     `pooled` is the same campaign shape, aggregated over several days.
     ------------------------------------------------------------------ */
  function windowAgreement(campaign, pooled, ctx) {
    if (!pooled || !(num(pooled.spend) > 0)) return null;
    const a = verdict(campaign, ctx);
    const b = verdict({ ...campaign, ...pooled, daysLive: Math.max(2, num(pooled.days) || 2) }, ctx);
    const direction = v => (['SCALE', 'SURF'].includes(v.code) ? 'up'
      : ['KILL', 'DESCALE'].includes(v.code) ? 'down' : 'flat');
    return {
      day: { code: a.code, headline: a.headline, roas: round2(num(campaign.roas)) },
      pooled: { code: b.code, headline: b.headline, roas: round2(num(pooled.roas) || (num(pooled.revenue) / num(pooled.spend))), days: num(pooled.days) || null },
      agree: direction(a) === direction(b),
      conflict: direction(a) !== direction(b) ? { day: direction(a), pooled: direction(b) } : null
    };
  }

  /* ------------------------------------------------------------------
     8. HELPERS
     ------------------------------------------------------------------ */
  function countUnprofitableStreak(history, ber) {
    if (!Array.isArray(history) || !ber) return 0;
    let streak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const d = history[i];
      if (num(d.spend) <= 0) continue;
      if (num(d.roas) < ber) streak++;
      else break;
    }
    return streak;
  }

  function countProfitableStreak(history, ber) {
    if (!Array.isArray(history) || !ber) return 0;
    let streak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const d = history[i];
      if (num(d.spend) <= 0) continue;
      if (num(d.roas) >= ber) streak++;
      else break;
    }
    return streak;
  }

  function normalizeCampaign(c) {
    const spend = num(c.spend);
    const revenue = num(c.revenue);
    return {
      id: c.id,
      name: c.name || '',
      status: c.status || '',
      budget: num(c.budget),
      daysLive: Math.max(1, num(c.daysLive) || 1),
      spend,
      revenue,
      roas: num(c.roas) || (spend > 0 ? revenue / spend : 0),
      purchases: num(c.purchases),
      frequency: num(c.frequency),
      clicks: num(c.clicks),
      lpv: num(c.lpv),
      atc: num(c.atc),
      ic: num(c.ic),
      history: c.history || [],
      descaleCount: num(c.descaleCount),
      profitableStreak: num(c.profitableStreak),
      surfedRecently: !!c.surfedRecently,
      learning: !!c.learning,
      accountId: c.accountId || '',
      accountName: c.accountName || ''
    };
  }

  const TONE = {
    SCALE: 'success', SURF: 'success', PROVE: 'success',
    HOLD: 'neutral', MONITOR: 'neutral', DIAGNOSE: 'neutral', NEEDS_SETUP: 'neutral',
    DESCALE: 'warning', PRICE_DROP: 'warning',
    KILL: 'danger'
  };

  function build(code, c, spec, f, margin, ber, notes, ctx) {
    const newBudget = spec.newBudget === undefined ? null : round2(spec.newBudget);
    const source = (ctx && ctx.revenueSource) || null;
    return {
      code,
      tone: TONE[code] || 'neutral',
      headline: spec.headline,
      reasons: spec.reasons || [],
      rule: spec.rule || '',
      notes: (notes || []).filter(Boolean),
      budgetFrom: c.budget || null,
      budgetTo: newBudget,
      budgetDelta: newBudget !== null && c.budget ? round2(newBudget - c.budget) : null,
      revenue: {
        source,
        verified: source === 'shopify',
        scalingLocked: source === 'meta',
        marginMeans: marginLabel(ctx || {})
      },
      /* What this verdict actually knows, so the card can show it. */
      confidence: (() => {
        const iv = roasInterval(c.roas, c.purchases, (ctx && ctx.confidence && ctx.confidence.z) || RULES.confidence.z);
        return {
          orders: c.purchases,
          interval: iv,
          proven: provenAbove(iv, ber),
          ordersNeeded: ordersNeeded(c.roas, ber, (ctx && ctx.confidence && ctx.confidence.z) || RULES.confidence.z)
        };
      })(),
      metrics: {
        spend: round2(c.spend),
        revenue: round2(c.revenue),
        roas: round2(c.roas),
        ber: round2(ber),
        marginPct: margin,
        purchases: c.purchases,
        frequency: round2(c.frequency),
        daysLive: c.daysLive,
        cpa: c.purchases > 0 ? round2(c.spend / c.purchases) : null,
        // The most you can pay for an order and still break even.
        maxCpa: c.purchases > 0 && c.revenue > 0
          ? round2((c.revenue / c.purchases) * (ber > 0 ? 1 / ber : 0))
          : null,
        pacingPct: c.budget > 0 ? Math.round((c.spend / c.budget) * 100) : null,
        learning: c.learning
      },
      funnel: f
    };
  }

  function stageLabel(stage) {
    return { pageLoad: 'page speed', offer: 'the offer', intent: 'checkout entry', completion: 'checkout completion' }[stage] || stage;
  }

  function money(v, currency) {
    const symbol = { EUR: '€', USD: '$', GBP: '£' }[currency] || '€';
    return symbol + num(v).toFixed(2);
  }

  function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
  function round1(v) { return Math.round(v * 10) / 10; }
  function round2(v) { return Math.round(v * 100) / 100; }

  return {
    RULES, economics, netMarginPct, grossMarginFromBer, parseCampaignName, cmCode,
    clockIn, detectWindow, dayContext, funnel, biggestLeak, verdict, guardrails, deliveryAlarms, productLabel,
    campaignDelivery, accountHealth, breakdown, reviewReason, spendCurve, applyCeiling,
    countUnprofitableStreak, countProfitableStreak, money,
    revenueVerified, scalingLocked, marginLabel, windowAgreement,
    roasInterval, ordersNeeded, provenAbove, weekendLift, surfPctFromLift
  };
});
