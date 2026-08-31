/* ==========================================================================
   VERDICT ENGINE — Samuel Ecom Scaling Cheat Sheet, encoded
   --------------------------------------------------------------------------
   Pure functions only. No DOM, no fetch. This file is unit-tested in Node
   (see tests/rules.test.js) and loaded as a plain <script> in the browser.
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
    minSpendForVerdict: 5
  };

  /* ------------------------------------------------------------------
     2. UNIT ECONOMICS
     ------------------------------------------------------------------
     grossMargin = (price - cogs - shipping - fees) / price
     BER         = 1 / grossMargin           (break-even ROAS)
     netMargin   = grossMargin - 1 / ROAS    (live campaign profit margin)

     The last identity is what makes the sheet self-consistent:
     ROAS > BER  <=>  netMargin > 0.
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

  /** Live profit margin of a campaign, as a percentage. */
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
     3. CAMPAIGN NAME PARSER
     ------------------------------------------------------------------
     The BER is found by shape, not by position, because real campaign
     names are not tidy. All of these must work:

       Product | 1.50 | 67
       Brand | CM074 | Product Name | 1.58
       Brand | CM066 | Other Product | 1.36 - V2- Q4
       Brand|  CM002 | Third Product | 1.55

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

  /* ------------------------------------------------------------------
     4. CHECK WINDOW — which of the 3 daily reads are we in?
     ------------------------------------------------------------------ */
  /* The read windows must follow the AD ACCOUNT's clock, not the laptop's.
     Meta rolls the advertising day over in the account timezone, so that is
     the only clock the daily rules mean anything against. Reading the browser
     clock instead silently shifts every window by your UTC offset — sitting
     in the browser (UTC+3) against a Berlin account (UTC+2) tips you into the
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
     5b. BREAK-EVEN CPA
     ------------------------------------------------------------------
     ROAS tells you whether you are winning. Break-even CPA tells you by
     how much, in the unit you actually bid in. maxCPA is the most you can
     pay for a customer and still not lose money:

       maxCPA = AOV x grossMargin        (and BER = 1 / grossMargin)

     headroom is how much room is left before the campaign turns. A
     campaign at 30% headroom can absorb a CPM rise; one at 1% cannot.
     ------------------------------------------------------------------ */
  function cpaPicture(c, grossMargin) {
    const spend = num(c.spend), purchases = num(c.purchases), revenue = num(c.revenue);
    const aov = purchases > 0 ? revenue / purchases : 0;
    const cpa = purchases > 0 ? spend / purchases : null;
    const maxCPA = aov > 0 && grossMargin > 0 ? aov * grossMargin : null;
    return {
      cpa: cpa === null ? null : round2(cpa),
      aov: round2(aov),
      maxCPA: maxCPA === null ? null : round2(maxCPA),
      // Positive = room to spend more per customer. Negative = losing money.
      headroomPct: (cpa !== null && maxCPA) ? round1(((maxCPA - cpa) / maxCPA) * 100) : null,
      profit: maxCPA !== null ? round2((maxCPA - cpa) * purchases) : null
    };
  }

  /* ------------------------------------------------------------------
     5c. DAY PACING
     ------------------------------------------------------------------
     You cannot judge a running day by its spend alone. At 11:00 a €40
     spend means something very different than at 23:00. This projects
     where the day lands so the day-1 thresholds are read in context.
     Meta's delivery is not linear, but it is close enough to linear
     after the first couple of hours to be a useful guide — and being
     roughly right beats being precisely blind.
     ------------------------------------------------------------------ */
  function dayPacing(c, ctx) {
    if (!ctx || typeof ctx.accountHour !== 'number') return null;
    const elapsed = ctx.accountHour + (ctx.accountMinute || 0) / 60;
    if (elapsed < 1) return null;                 // too early to extrapolate
    const fraction = elapsed / 24;
    const spend = num(c.spend), budget = num(c.budget);
    const projectedSpend = round2(spend / fraction);
    return {
      elapsedHours: round1(elapsed),
      dayFractionPct: round1(fraction * 100),
      projectedSpend,
      // Under-delivery: budget it is not managing to spend.
      budgetUsedPct: budget > 0 ? round1((spend / budget) * 100) : null,
      willUnderDeliver: budget > 0 && projectedSpend < budget * RULES.pacing.underDelivering,
      projectedPurchases: spend > 0 ? round1(num(c.purchases) / fraction) : 0
    };
  }

  /* ------------------------------------------------------------------
     5d. BROKEN FUNNEL STAGE
     ------------------------------------------------------------------
     Different from biggestLeak, which grades a stage as weak. This finds
     a stage that is flatly DEAD — zero events where the stage above it
     produced plenty. That is a bug on the page, not a bad offer, and no
     budget or price change will touch it. Learned the hard way: 11 carts
     and 0 checkouts is a broken button, not a pricing objection.
     ------------------------------------------------------------------ */
  const STAGE_MIN = 8;       // mid-funnel: this many above, zero below = broken
  const PURCHASE_MIN = 12;   // the purchase step needs more evidence, see below

  /* opts.includePurchaseStep — the checkout→purchase step is the one
     ambiguous link. Zero purchases from a handful of checkouts can be a
     dead payment provider OR simply a price objection, which the sheet
     already handles with a price drop. So day-1 triage looks only at the
     unambiguous mid-funnel steps; the account-wide alarm looks at all of
     them and says what it sees. */
  function brokenStage(c, opts) {
    const includePurchase = !opts || opts.includePurchaseStep !== false;
    const clicks = num(c.clicks), lpv = num(c.lpv), atc = num(c.atc),
          ic = num(c.ic), purchases = num(c.purchases);
    const chain = [
      { from: 'clicks',    to: 'landing page views', up: clicks, down: lpv,
        msg: 'Clicks are not turning into page views. The page is not loading — check the domain, the redirect and load speed.' },
      { from: 'page views', to: 'add-to-carts', up: lpv, down: atc,
        msg: 'Page views produce no add-to-carts. Either the button is broken or the add-to-cart event is not firing.' },
      { from: 'add-to-carts', to: 'checkouts', up: atc, down: ic,
        msg: 'Carts never reach checkout. The checkout button or its event is broken — a discount cannot fix this.' },
      { from: 'checkouts', to: 'purchases', up: ic, down: purchases, purchaseStep: true,
        msg: 'Checkouts never complete. Check the payment providers — Klarna, PayPal and Stripe — and the purchase event.' }
    ];
    for (let i = 0; i < chain.length; i++) {
      const st = chain[i];
      if (st.purchaseStep && !includePurchase) continue;
      const floor = st.purchaseStep ? PURCHASE_MIN : STAGE_MIN;
      if (st.up < floor || st.down !== 0) continue;
      // A zero stage with live traffic BELOW it is a skipped step, not a
      // broken one. Funnelish one-page funnels go straight to checkout, so
      // they never fire add-to-cart — that is architecture, not a bug.
      const downstreamAlive = chain.slice(i + 1).some(later => later.down > 0);
      if (downstreamAlive) continue;
      return { from: st.from, to: st.to, upCount: st.up, message: st.msg, purchaseStep: !!st.purchaseStep };
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
     ctx = { ber, grossMargin, window, isSaturday, isSunday, currency }
     ------------------------------------------------------------------ */
  let _ctx = null;   // set by verdict(), read by build() for pacing/economics

  function verdict(campaign, ctx) {
    const c = normalizeCampaign(campaign);
    _ctx = ctx || {};
    const ber = num(ctx.ber);
    const gm = ctx.grossMargin || grossMarginFromBer(ber);
    const win = ctx.window || 'midnight';
    const f = funnel(c);
    const margin = netMarginPct(c.roas, gm);
    const profitable = ber > 0 && c.roas > ber;
    const unprofitableStreak = countUnprofitableStreak(c.history, ber);
    const notes = [];

    // ---- guard: not enough data to judge -------------------------------
    if (!ber || ber <= 0) {
      return build('NEEDS_SETUP', c, {
        headline: 'Set the BER first',
        reasons: ['No break-even ROAS for this campaign. Name it "Product | BER | Margin" or set the unit economics.'],
        rule: 'Campaign name: Productname | BER | Profit margin'
      }, f, margin, ber);
    }
    /* A paused campaign is not a candidate for any budget move. It still
       shows up while it has spend in the window being viewed, because you
       need to see how the day it was stopped actually ended — but telling
       someone to scale a campaign they just switched off is nonsense, and
       acting on it would mean turning it back on by accident. Report the
       outcome; leave the decision to restart to the person. */
    if (/PAUSED|ARCHIVED|DELETED/i.test(c.status || '')) {
      const outcome = c.purchases > 0
        ? `It ended on ROAS ${c.roas.toFixed(2)} against break-even ${ber.toFixed(2)} — ${profitable ? 'profitable' : 'under water'}.`
        : `It ended with ${money(c.spend, ctx.currency)} spent and no sales.`;
      const broken = brokenStage(c, { includePurchaseStep: false });
      return build('PAUSED', c, {
        headline: profitable ? 'Paused — it was working when you stopped it' : 'Paused',
        reasons: [
          outcome,
          broken
            ? `${broken.upCount} ${broken.from} produced 0 ${broken.to}. Fix that before switching it back on.`
            : profitable
              ? 'Switching it back on is a decision for you — the sheet does not scale a campaign that is off.'
              : 'Leave it off until the creative or the funnel behind it has changed.'
        ],
        rule: 'Paused campaigns are never scaled, descaled or killed — these numbers are final for this window.'
      }, f, margin, ber, notes);
    }

    if (c.spend < RULES.minSpendForVerdict) {
      return build('MONITOR', c, {
        headline: 'Too early to call',
        reasons: [`Only ${money(c.spend, ctx.currency)} spent. Let it gather data.`],
        rule: 'Do not act on noise.'
      }, f, margin, ber);
    }

    // ---- WEEKEND SURFSCALING ------------------------------------------
    // Applies Sat + Sun, at both the 11AM and midnight reads.
    if (ctx.isSaturday || (ctx.isSunday && win !== 'midnight')) {
      for (const tier of RULES.weekend.surf) {
        if (c.roas >= tier.minRoas) {
          return build('SURF', c, {
            headline: `Surf ×${tier.multiplier}`,
            newBudget: c.budget * tier.multiplier,
            reasons: [
              `ROAS ${c.roas.toFixed(2)} is at or above ${tier.minRoas} on a weekend.`,
              `Weekend surf multiplies budget ×${tier.multiplier}. You can do this twice today.`,
              'Remember to pull back Sunday night — Monday always dips.',
              ctx.learning ? 'This ad set is still in learning and a ×' + tier.multiplier + ' change will reset it. That is the accepted price of surfing a weekend winner.' : ''
            ].filter(Boolean),
            rule: `Weekend Surfscaling: ROAS ${tier.minRoas}+ → Budget ×${tier.multiplier}`
          }, f, margin, ber);
        }
      }
      notes.push('Weekend, but ROAS is under 3 — no surf. Normal rules apply.');
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
      }, f, margin, ber, c.surfedRecently ? [] : ['No weekend scale-up recorded for this one — if you never raised its budget this weekend, leave it alone.']);
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
        if (atcRate < RULES.day1.atcRateLow) {
          return build('KILL', c, {
            headline: 'Kill it',
            newBudget: 0,
            reasons: [
              `${money(c.spend, ctx.currency)} spent, 0 sales.`,
              `Add-to-cart rate is ${atcRate}% — under ${RULES.day1.atcRateLow}%. Nobody wants the offer.`
            ],
            rule: 'Adspend ≤ 40 and 0 sales with low ATC rate → KILL CAMPAIGN'
          }, f, margin, ber);
        }
        // High ATC but nobody reaches checkout is a broken funnel, not a
        // price objection — dropping the price on it just burns €30 more.
        const broken = brokenStage(c, { includePurchaseStep: false });
        if (broken) {
          return build('KILL', c, {
            headline: `Stop it — ${broken.to} are not happening at all`,
            newBudget: 0,
            reasons: [
              `${money(c.spend, ctx.currency)} spent, 0 sales, and ${broken.upCount} ${broken.from} produced 0 ${broken.to}.`,
              broken.message,
              'Pause it, fix that step, then retest at full price.'
            ],
            rule: 'Adspend ≤ 40 and 0 sales → kill; price drop only applies when the funnel still works'
          }, f, margin, ber);
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
        }, f, margin, ber);
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
        }, f, margin, ber);
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
        }, f, margin, ber);
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
      }, f, margin, ber, notes);
    }

    /* ================= EVENING READ ==================================
       Funnel quality. Never a budget move — this read tells you what to
       fix on the page, not what to do with money.
       ================================================================= */
    if (win === 'evening') {
      const d1 = dayOne();
      if (d1) return d1;
      const leak = biggestLeak(f);
      return build('DIAGNOSE', c, {
        headline: leak ? `Fix: ${stageLabel(leak.stage)}` : 'Funnel is clean',
        reasons: leak
          ? [leak.message,
             `Page speed ${f.pageLoad.value}% · Offer ${f.offer.value}% · Intent ${f.intent.value}% · Completion ${f.completion.value}%`]
          : ['Every stage of the funnel is inside benchmark. Nothing to fix on the page tonight.',
             `Page speed ${f.pageLoad.value}% · Offer ${f.offer.value}% · Intent ${f.intent.value}% · Completion ${f.completion.value}%`],
        rule: 'Evening check = funnel quality. No budget changes.'
      }, f, margin, ber, notes);
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
            `But profit margin is only ${margin}% — under 15%. Scaling now would eat the margin.`,
            'Leave the budget exactly where it is and let it optimise.'
          ],
          rule: 'ROAS > BER and profit margin < 15% → DON\'T CHANGE BUDGET, LET IT RUN'
        }, f, margin, ber, notes.concat(creativeNote(c)));
      }
      return build('SCALE', c, {
        headline: `Scale +${tier.pct}%`,
        newBudget: c.budget * (1 + tier.pct / 100),
        reasons: [
          `ROAS ${c.roas.toFixed(2)} is above break-even ${ber.toFixed(2)}.`,
          `Profit margin is ${margin}% ${tier.minMargin === 20 ? '(over 20%)' : '(15–20%)'} → increase budget ${tier.pct}%.`
        ],
        rule: `ROAS > BER and profit margin ${tier.minMargin === 20 ? '> 20%' : '= 15-20%'} → +${tier.pct}% BUDGET INCREASE`
      }, f, margin, ber, notes.concat(creativeNote(c)));
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
      }, f, margin, ber, notes);
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
      }, f, margin, ber, notes);
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
    }, f, margin, ber, notes);
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
    KILL: 'danger',
    PAUSED: 'neutral'
  };

  function build(code, c, spec, f, margin, ber, notes) {
    const newBudget = spec.newBudget === undefined ? null : round2(spec.newBudget);
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
        learning: c.learning,
        // Profit and headroom in euros — what ROAS actually means in the bank.
        aov: cpaPicture(c, ber > 0 ? 1 / ber : 0).aov,
        headroomPct: cpaPicture(c, ber > 0 ? 1 / ber : 0).headroomPct,
        profit: cpaPicture(c, ber > 0 ? 1 / ber : 0).profit,
        pacing: dayPacing(c, _ctx),
        broken: brokenStage(c)
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
  function numLoose(v) { return num(String(v).replace(',', '.').replace(/[^\d.\-]/g, '')); }
  function round1(v) { return Math.round(v * 10) / 10; }
  function round2(v) { return Math.round(v * 100) / 100; }

  return {
    RULES, economics, netMarginPct, grossMarginFromBer, parseCampaignName,
    clockIn, detectWindow, dayContext, funnel, biggestLeak,
    cpaPicture, dayPacing, brokenStage, verdict, guardrails, deliveryAlarms, productLabel,
    countUnprofitableStreak, countProfitableStreak, money
  };
});
