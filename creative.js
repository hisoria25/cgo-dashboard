/* ==========================================================================
   CREATIVE DESK — the ad-level layer
   --------------------------------------------------------------------------
   Budget verdicts decide how much money a campaign gets. This file decides
   which ads deserve it and what the editors should make next.

   WHY IT EXISTS

   The money is made and lost one ad at a time. LidLux ran thirteen ads
   against a 3–5 SOP; the real wins in this account came from pausing
   specific losers, not from moving campaign budgets by percentages. Until
   now the dashboard scored ads by counting trigger words in the copy, which
   is close to useless.

   WHAT IT READS

   Meta reports video retention in quartiles — how many viewers reached 25%,
   50%, 75% and 100% of the video. With the video's length that becomes a
   curve in seconds, which is as close to "second by second" as the API
   goes. Each drop between two points has a different creative cause and a
   different fix, and that mapping is what a creative director actually
   carries in their head:

     impression → 3s      the thumbnail and first frame        HOOK
     3s → 25%             whether the hook paid off            SECOND BEAT
     25% → 50%            whether the story holds              BODY
     50% → 75%            whether they believe it              PROOF
     75% → 100%           whether the offer lands              CLOSE
     impression → click   whether they want it enough          CLICK

   An ad that loses people at 3 seconds needs a new opening, not a new offer.
   An ad that holds to 75% and never gets clicked has a CTA problem, not a
   hook problem. Treating those the same is how creative budgets get burnt.

   WHAT IT DOES NOT DO

   It does not watch the video. It infers from the retention shape where the
   creative fails. For an ad that matters, a human — or Claude in a session
   with the file — should still look at the thing itself. The dashboard
   narrows seven campaigns and forty ads down to the two clips worth
   watching.
   ========================================================================== */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CreativeDesk = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /* Benchmarks for DACH direct-response video, paid cold traffic. These are
     working bands, not laws — `good` is where a stage stops being a concern
     and `poor` is where it becomes the thing to fix first. */
  const STAGES = [
    {
      key: 'hook', label: 'Hook', window: 'first 3 seconds',
      num: 'v3', den: 'impressions', good: 20, poor: 12,
      fails: 'The thumbnail and first frame are not stopping the scroll.',
      fix: 'Rebuild the first 3 seconds only. New opening frame, a face or the problem on screen immediately, movement inside the first half second. Do not touch the rest of the cut.',
      template: 'Split-Panel — the PAIN side makes a strong opening frame, with the red phrase top-left.'
    },
    {
      key: 'beat', label: 'Second beat', window: '3 seconds → 25%',
      num: 'p25', den: 'v3', good: 45, poor: 30,
      fails: 'The hook stops them but the next line does not pay it off.',
      fix: 'The promise made in second 1 has to be restated or advanced by second 5. Usually the fix is cutting whatever sits between them — a logo sting, a slow pan, a line of setup.',
      template: 'Keep the existing hook, re-cut the following 4 seconds. No new shoot needed.'
    },
    {
      key: 'body', label: 'Body', window: '25% → 50%',
      num: 'p50', den: 'p25', good: 60, poor: 45,
      fails: 'The middle drags. They were interested and the story lost them.',
      fix: 'Cut 20–30% of the runtime out of the middle. One idea per 3 seconds, a cut on every beat, and get the product on screen earlier.',
      template: 'Re-edit of the existing footage. Shorter is almost always the fix here.'
    },
    {
      key: 'proof', label: 'Proof', window: '50% → 75%',
      num: 'p75', den: 'p50', good: 70, poor: 55,
      fails: 'They stay for the story and leave before believing it.',
      fix: 'Add demonstration or testimony at the two-thirds mark — the product doing the thing, or a real person saying it worked. Claims without evidence lose people exactly here.',
      template: 'BEFORE & AFTER split (WITHOUT / WITH labels, never "Before"/"After"), or a UGC testimonial insert.'
    },
    {
      key: 'close', label: 'Close', window: '75% → 100%',
      num: 'p100', den: 'p75', good: 75, poor: 60,
      fails: 'They watch almost all of it and drop before the offer.',
      fix: 'The ending is too long or too soft. Put the offer on screen as a card — price, discount, guarantee — and end within 2 seconds of it.',
      template: 'Offer end-card. "⚡ 50% Off" plus the guarantee line, held for 2 seconds.'
    },
    {
      key: 'click', label: 'Click', window: 'impression → link click',
      num: 'clicks', den: 'impressions', good: 2, poor: 1,
      fails: 'People watch and do not click.',
      fix: 'Watching is not wanting. The offer is not clear enough or not urgent enough in the copy — rewrite the headline as the offer, and make the primary text a personal result rather than a product description.',
      template: 'Samuel ad-copy structure: 1–3 first-person benefit sentences, headline is the offer, CTA "Learn More".'
    }
  ];

  /* An image ad has no retention curve, so it is judged on the two stages
     that exist for it. */
  const IMAGE_STAGES = ['click'];

  /* ------------------------------------------------------------------
     RETENTION
     ------------------------------------------------------------------ */
  function n(v) { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; }
  function r1(v) { return Math.round(v * 10) / 10; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function ratio(a, b) { return b > 0 ? (a / b) * 100 : 0; }

  /**
   * The viewing curve for one ad.
   * @param ad  { impressions, v3, p25, p50, p75, p100, clicks, lengthSec, avgWatchSec, type }
   */
  function retention(ad) {
    const isVideo = (ad.type || '').toLowerCase() === 'video' || n(ad.v3) > 0;
    const len = n(ad.lengthSec);
    const points = [
      { at: 0,    label: '0s',   viewers: n(ad.impressions), what: 'saw it' },
      { at: 3,    label: '3s',   viewers: n(ad.v3),   what: 'stayed 3 seconds' },
      { at: 0.25, label: '25%',  viewers: n(ad.p25),  what: 'reached a quarter' },
      { at: 0.50, label: '50%',  viewers: n(ad.p50),  what: 'reached halfway' },
      { at: 0.75, label: '75%',  viewers: n(ad.p75),  what: 'reached three quarters' },
      { at: 1.00, label: '100%', viewers: n(ad.p100), what: 'watched it out' }
    ].map(p => ({
      ...p,
      /* With the video length known, the quartiles become real timestamps —
         "they leave at 7 seconds" is actionable in a way that "p25" is not. */
      seconds: p.at === 0 ? 0 : p.at === 3 ? 3 : (len > 0 ? r1(len * p.at) : null),
      pctOfImpressions: r1(ratio(p.viewers, n(ad.impressions)))
    }));

    return {
      isVideo,
      lengthSec: len || null,
      avgWatchSec: n(ad.avgWatchSec) || null,
      /* How much of the video the average viewer actually sees. Below about
         a third, the back half of the edit is being made for nobody. */
      avgWatchPct: len > 0 && n(ad.avgWatchSec) > 0 ? r1((n(ad.avgWatchSec) / len) * 100) : null,
      points: isVideo ? points : points.slice(0, 1)
    };
  }

  /* ------------------------------------------------------------------
     DIAGNOSIS
     ------------------------------------------------------------------ */
  function grade(value, s) {
    if (value >= s.good) return 'healthy';
    if (value >= s.poor) return 'warning';
    return 'alert';
  }

  /**
   * Every stage scored, worst first. The first `alert` is the thing to fix;
   * fixing a later stage while an earlier one leaks is wasted work, exactly
   * as with the purchase funnel.
   */
  function diagnose(ad) {
    const isVideo = (ad.type || '').toLowerCase() === 'video' || n(ad.v3) > 0;
    const vals = {
      impressions: n(ad.impressions), v3: n(ad.v3), p25: n(ad.p25),
      p50: n(ad.p50), p75: n(ad.p75), p100: n(ad.p100), clicks: n(ad.clicks)
    };

    const stages = STAGES
      .filter(s => isVideo || IMAGE_STAGES.includes(s.key))
      .map(s => {
        const den = vals[s.den], num = vals[s.num];
        const measurable = den > 0;
        const value = measurable ? r1(ratio(num, den)) : null;
        return {
          key: s.key, label: s.label, window: s.window,
          value, measurable,
          status: measurable ? grade(value, s) : 'untracked',
          target: s.good,
          lost: measurable ? Math.max(0, den - num) : null,
          fails: s.fails, fix: s.fix, template: s.template
        };
      });

    const ordered = STAGES.map(s => s.key);
    const broken = stages
      .filter(s => s.measurable && s.status !== 'healthy')
      .sort((a, b) => {
        const sev = { alert: 0, warning: 1 };
        return (sev[a.status] - sev[b.status]) || (ordered.indexOf(a.key) - ordered.indexOf(b.key));
      });

    /* The earliest alert is what to fix. If nothing is in alert, the earliest
       warning. If neither, the creative is not the problem. */
    const firstAlert = stages.find(s => s.measurable && s.status === 'alert');
    const firstWarning = stages.find(s => s.measurable && s.status === 'warning');
    const primary = firstAlert || firstWarning || null;

    return { stages, broken, primary, isVideo };
  }

  /* ------------------------------------------------------------------
     THE FIRST 3 SECONDS
     ------------------------------------------------------------------
     Meta cannot show the footage, but it does say how many people were still
     watching at second 3 and at the quarter mark. That is enough to say whether
     the opening stops the scroll, and — if it does — whether the line after it
     pays the opening off. The "what to change" list is the house rule set for
     openers (the same rules the editor briefs use), so the answer is something
     an editor can act on without a meeting.

     The thumbnail is Meta's preview frame for the ad. It is usually the
     opening, not always the exact first frame, so it is shown as a reminder of
     what is being judged, not as proof.
     ------------------------------------------------------------------ */
  const HOOK = { minImpressions: 1000, seconds: 3 };

  const HOOK_REPLACE = [
    'Cut a new 3-second opener and put it in front. Keep everything from second 3 onward exactly as it is — do not re-edit the body.',
    'Open on the moment, not the product: no logo, no product and no brand in the first 3 seconds. Show a situation the viewer already knows.',
    'No face close-up, no skin close-up and no red pain zones on a body. It is the commonest Meta reject for health products.',
    'Put the caption on frame 1 — many viewers watch muted. About six words, one key word in colour, centred in the lower third.',
    'Movement inside the first half second: a cut, a hand, a step. A still frame reads as a photo and gets scrolled past.',
    'Use the same caption style as the body so the join does not look like a different ad.'
  ];
  const HOOK_TWEAK = [
    'Change the opening frame only. The thumbnail is what viewers see first; make it the strongest image of the first 3 seconds.',
    'Caption on frame 1, six words or fewer, one key word in colour.',
    'Start the movement in the first half second.',
    'Upload the new opening as a second ad beside this one rather than replacing it, so the test is fair.'
  ];

  /**
   * @param ad  one ad row: { type, impressions, v3, p25, lengthSec, thumbnail }
   */
  function hookReport(ad) {
    const isVideo = (ad.type || '').toLowerCase() === 'video' || n(ad.v3) > 0;
    const thumbnail = /^https:\/\//i.test(ad.thumbnail || '') ? ad.thumbnail : '';
    if (!isVideo) {
      return { isVideo: false, verdict: 'image', thumbnail, hookRate: null,
        headline: 'Image ad — it has no first 3 seconds to analyse.', changes: [], keep: [] };
    }
    const imp = n(ad.impressions), v3 = n(ad.v3), p25 = n(ad.p25), len = n(ad.lengthSec);
    if (imp < HOOK.minImpressions) {
      return { isVideo: true, verdict: 'thin', thumbnail, hookRate: null, impressions: imp,
        headline: `Only ${Math.round(imp)} views so far — the opening needs ${HOOK.minImpressions} to be judged fairly.`,
        changes: [], keep: [] };
    }

    const hookS = STAGES[0], beatS = STAGES[1];
    const hookRate = r1(ratio(v3, imp));
    const status = grade(hookRate, hookS);
    const quarterAt = len > 0 ? r1(len * 0.25) : null;
    /* On a clip under 12 seconds the quarter mark falls inside the opening, so
       "3s → 25%" stops meaning anything. */
    const beatMeasurable = v3 > 0 && !(quarterAt !== null && quarterAt <= HOOK.seconds);
    const beatRate = beatMeasurable ? r1(ratio(p25, v3)) : null;
    const beatStatus = beatMeasurable ? grade(beatRate, beatS) : 'untracked';
    const scrolled = Math.max(0, Math.round(imp - v3));

    const changes = [], keep = [];
    let verdict, headline;
    if (status === 'alert') {
      verdict = 'replace';
      headline = `Hook rate ${hookRate}% — ${r1(100 - hookRate)}% scroll past before second 3 (target ${hookS.good}%+). Replace the first 3 seconds.`;
      changes.push(...HOOK_REPLACE);
    } else if (status === 'warning') {
      verdict = 'tweak';
      headline = `Hook rate ${hookRate}% — under the ${hookS.good}% target. Keep the idea, sharpen the opening frame.`;
      changes.push(...HOOK_TWEAK);
    } else {
      verdict = 'keep';
      headline = `Hook rate ${hookRate}% — it stops the scroll (target ${hookS.good}%+). Reuse this opening.`;
      keep.push('Copy this exact opening onto the new ads and change what comes after second 3: the body, the proof or the offer.');
      keep.push('Do not change the first frame or the caption.');
    }
    if (beatStatus === 'alert' || beatStatus === 'warning') {
      changes.push(`People stop, then ${r1(100 - beatRate)}% leave before the quarter mark${quarterAt !== null ? ` (${quarterAt}s)` : ''}. Say again by second 5 what the opening promised — cut whatever sits between them (logo sting, slow pan, a line of setup).`);
    }

    return { isVideo: true, verdict, thumbnail, hookRate, status, target: hookS.good, scrolled, impressions: imp,
      beatRate, beatStatus, quarterAt, headline, changes, keep };
  }

  /**
   * The campaign's openings side by side: the one to keep, the one to replace.
   * The one to replace is the broken opening with the most money behind it —
   * that is where a new first 3 seconds pays back soonest.
   */
  function hookDesk(scored) {
    const vids = (scored || []).filter(a => a.hook && a.hook.isVideo && a.hook.verdict !== 'thin');
    if (!vids.length) {
      const anyVideo = (scored || []).some(a => a.hook && a.hook.isVideo);
      return { measured: false, keep: null, replace: null, ranked: [], changes: [], planLines: [],
        note: anyVideo
          ? `The video ads here have fewer than ${HOOK.minImpressions} views each, so no opening can be judged yet.`
          : 'No video ads in this campaign, so there is no first 3 seconds to analyse.' };
    }
    const ranked = vids.slice().sort((a, b) => b.hook.hookRate - a.hook.hookRate);
    const pick = a => ({ id: a.id, name: a.name, code: a.code, spend: a.spend, thumbnail: a.hook.thumbnail,
      hookRate: a.hook.hookRate, scrolled: a.hook.scrolled, impressions: a.hook.impressions,
      verdict: a.hook.verdict, headline: a.hook.headline, changes: a.hook.changes, keep: a.hook.keep,
      beatRate: a.hook.beatRate, beatStatus: a.hook.beatStatus, quarterAt: a.hook.quarterAt, target: a.hook.target });
    const healthy = ranked.filter(a => a.hook.status === 'healthy');
    const keep = healthy.length ? pick(healthy[0]) : null;
    const broken = vids.filter(a => a.hook.verdict === 'replace' || a.hook.verdict === 'tweak')
      .sort((a, b) => b.spend - a.spend);
    const replace = broken.length ? pick(broken[0]) : null;
    /* A healthy opening with a leaking second beat still has one thing to fix. */
    const beatOnly = !replace
      ? vids.filter(a => a.hook.beatStatus === 'alert' || a.hook.beatStatus === 'warning').sort((a, b) => b.spend - a.spend)[0]
      : null;

    const planLines = [];
    if (keep) planLines.push(`Keep this opening: ${keep.name} — hook rate ${keep.hookRate}%.`);
    if (replace) planLines.push(`Replace this opening: ${replace.name} — hook rate ${replace.hookRate}% (${r1(100 - replace.hookRate)}% scroll past before second 3).`);
    if (!keep && !replace && beatOnly) planLines.push(`${beatOnly.name}: the opening works but viewers leave right after it.`);
    if (!keep && replace) planLines.push('No opening in this campaign is at target yet — all new ads need a new first 3 seconds.');

    return {
      measured: true, keep, replace,
      beatOnly: beatOnly ? pick(beatOnly) : null,
      ranked: ranked.map(pick),
      changes: replace ? replace.changes : (beatOnly ? beatOnly.hook.changes : []),
      planLines, note: ''
    };
  }

  /* ------------------------------------------------------------------
     AD VERDICTS
     ------------------------------------------------------------------
     An ad has had a fair test when it has spent enough to have produced a
     sale if it were going to. That threshold is the campaign's own cost per
     purchase, doubled — not a round number, because a €40 CPA product and a
     €15 CPA product deserve different patience.
     ------------------------------------------------------------------ */
  const SOP_MAX_ADS = 5;
  const SOP_MIN_ADS = 3;
  const FAIR_TEST_MULTIPLE = 2;

  /* ------------------------------------------------------------------
     THE STATISTICAL AD RULES
     ------------------------------------------------------------------
     "Pause the ad that spent a lot and made nothing" sounds obvious until you
     ask how much is a lot. The honest answer is a probability.

     An ad that is exactly break-even earns one sale for every `beCpa` euros it
     spends (beCpa = average order value ÷ break-even ROAS). So after spending
     S euros it should have made about λ = S ÷ beCpa sales. Sales are random,
     so even a break-even ad sometimes makes fewer. `poissonCdf(n, λ)` is the
     chance that a break-even ad makes n sales OR FEWER by bad luck alone.

       chance ≤ 10%  → the ad is almost certainly worse than break-even. Pause.
       chance ≤ 25%  → close to the line. Watch it, do not touch it yet.

     With no sales this lands at about 2.3 × beCpa — the "2–3× cost per
     purchase" rule media buyers use by feel, here with the maths showing.
     ------------------------------------------------------------------ */
  const AD_RULES = {
    minSpendMult: 2,      // never judge an ad before it has spent 2× break-even CPA
    pausePct: 0.10,       // a break-even ad would be this unlucky ≤ 10% of the time
    watchPct: 0.25,
    winnerPct: 0.10,      // chance a break-even ad would do this WELL by luck
    winnerMargin: 1.15,   // and it has to clear break-even by 15%
    minWinnerOrders: 2
  };

  function poissonCdf(k, lambda) {
    if (!(lambda > 0)) return 1;
    let term = Math.exp(-lambda), sum = term;
    for (let i = 1; i <= k; i++) { term *= lambda / i; sum += term; }
    return Math.min(1, sum);
  }
  const pctTxt = p => (p < 0.01 ? '<1%' : Math.round(p * 100) + '%');

  /** One ad, judged against its campaign's own break-even. */

  /* Shopify's own count for this ad, if it can be trusted: the ad name matched
     exactly one ad and the order history reaches back over the whole window. */
  function shopFacts(a) {
    const sh = a && a.shop;
    if (!sh || !sh.trusted || sh.state === 'ambiguous') return null;
    return { orders: n(sh.orders), revenue: n(sh.revenue) };
  }

  function shopVeto(a, lambda, metaPurch, ctx) {
    const f = shopFacts(a);
    if (!f || f.orders <= 0 || (metaPurch > 0 && f.orders <= metaPurch)) return null;
    const pShop = poissonCdf(f.orders, lambda);
    if (pShop <= AD_RULES.pausePct) return null;          // still conclusive on Shopify's count
    return {
      code: 'WATCH', urgency: null, shopCheck: true,
      why: `Meta credits this ad with ${metaPurch} order${metaPurch === 1 ? '' : 's'}, but the Shopify order book shows ${f.orders} (${money(f.revenue, ctx)}) carrying this ad's name. On that count a break-even ad would be this unlucky about ${pctTxt(pShop)} of the time — not proven bad. Check it before you pause it.`
    };
  }

  function judgeAd(a, ctx) {
    const spend = n(a.spend), purch = n(a.purchases), rev = n(a.revenue);
    const ber = n(ctx.ber), beCpa = n(ctx.beCpa);
    const roas = spend > 0 ? rev / spend : 0;
    const lambda = beCpa > 0 ? spend / beCpa : 0;
    const pBad = poissonCdf(purch, lambda);
    const pGood = purch > 0 ? 1 - poissonCdf(purch - 1, lambda) : 1;
    const lost = Math.max(0, spend - (ber > 0 ? rev / ber : rev));
    const base = { roas: r2(roas), lambda: r2(lambda), pBad: r2(pBad), lost: r2(lost), urgency: null };

    if (spend < AD_RULES.minSpendMult * beCpa) {
      return { ...base, code: 'TESTING',
        why: `${money(spend, ctx)} spent. A fair test needs ${money(AD_RULES.minSpendMult * beCpa, ctx)} (2× the ${money(beCpa, ctx)} one sale costs at break-even). Too early to judge — leave it alone.` };
    }
    if (pBad <= AD_RULES.pausePct) {
      /* Shopify can stop a wrong pause, never start one. Meta's per-ad sales
         are the weaker number on this account, so when the order book shows
         this ad's name selling, the test is run again on that count. */
      const veto = shopVeto(a, lambda, purch, ctx);
      if (veto) return { ...base, ...veto };
      return { ...base, code: 'PAUSE', urgency: 'now',
        why: purch === 0
          ? `${money(spend, ctx)} spent and no sale. An ad at break-even would have made about ${lambda.toFixed(1)} by now — there is only a ${pctTxt(pBad)} chance this is bad luck. Pause it.`
          : `${money(spend, ctx)} for ${purch} order${purch === 1 ? '' : 's'} (ROAS ${roas.toFixed(2)}, break-even ${ber.toFixed(2)}). A break-even ad would have made about ${lambda.toFixed(1)} orders — only a ${pctTxt(pBad)} chance this is bad luck. Pause it.` };
    }
    if (pBad <= AD_RULES.watchPct) {
      return { ...base, code: 'WATCH',
        why: `${money(spend, ctx)}, ${purch} order${purch === 1 ? '' : 's'}, ROAS ${roas.toFixed(2)}. Under where a break-even ad would be (about ${lambda.toFixed(1)} orders) and close to the pause line. Do not add budget to it; pause it if the next day is empty.` };
    }
    if (purch >= AD_RULES.minWinnerOrders && ber > 0 && roas >= ber * AD_RULES.winnerMargin && pGood <= AD_RULES.winnerPct) {
      return { ...base, code: 'SCALE_SOURCE',
        why: `ROAS ${roas.toFixed(2)} on ${purch} orders against break-even ${ber.toFixed(2)} — clearly better than luck. This is the ad to make more like.` };
    }
    if (ber > 0 && roas >= ber) {
      return { ...base, code: 'KEEP', why: `ROAS ${roas.toFixed(2)} against break-even ${ber.toFixed(2)}. Carrying its weight.` };
    }
    return { ...base, code: 'WATCH',
      why: `ROAS ${roas.toFixed(2)} is under break-even ${ber.toFixed(2)}, but on ${purch} order${purch === 1 ? '' : 's'} that is still within luck. Not proven either way.` };
  }

  function fairTestThreshold(ads, fallbackCpa) {
    const cpas = ads
      .filter(a => n(a.purchases) > 0 && n(a.spend) > 0)
      .map(a => n(a.spend) / n(a.purchases))
      .sort((x, y) => x - y);
    const median = cpas.length
      ? cpas[Math.floor(cpas.length / 2)]
      : n(fallbackCpa);
    return median > 0 ? r2(median * FAIR_TEST_MULTIPLE) : null;
  }

  /**
   * @param ads  per-ad rows for ONE campaign
   * @param ctx  { ber, currency, campaignCpa }
   */
  function adVerdicts(ads, ctx) {
    const list = (ads || []).filter(a => n(a.spend) > 0);
    const beCpa = n(ctx && ctx.beCpa);
    const statistical = beCpa > 0 && n(ctx && ctx.ber) > 0;
    const threshold = statistical ? r2(AD_RULES.minSpendMult * beCpa) : fairTestThreshold(list, ctx && ctx.campaignCpa);
    const ber = n(ctx && ctx.ber);

    const scored = list.map(a => {
      const spend = n(a.spend), purch = n(a.purchases), rev = n(a.revenue);
      const roas = spend > 0 ? rev / spend : 0;
      const d = diagnose(a);

      let code, why, extra = {};
      if (statistical) {
        const j = judgeAd(a, ctx);
        code = j.code; why = j.why;
        extra = { lambda: j.lambda, pBad: j.pBad, lost: j.lost, urgency: j.urgency, shopCheck: !!j.shopCheck };
      } else {
        const tested = threshold ? spend >= threshold : false;
        if (!tested) {
          code = 'TESTING';
          why = threshold
            ? `${money(spend, ctx)} of a ${money(threshold, ctx)} fair test. Too early to judge.`
            : `${money(spend, ctx)} spent. No converting ad in this campaign yet, so there is no threshold to judge against.`;
        } else if (purch === 0) {
          code = 'PAUSE';
          why = `${money(spend, ctx)} and no sale, past the ${money(threshold, ctx)} fair test. Conclusive.`;
        } else if (ber > 0 && roas < ber) {
          code = 'PAUSE';
          why = `ROAS ${roas.toFixed(2)} on ${purch} order${purch === 1 ? '' : 's'}, under break-even ${ber.toFixed(2)}. Losing money on every euro.`;
        } else if (ber > 0 && roas >= ber * 1.5) {
          code = 'SCALE_SOURCE';
          why = `ROAS ${roas.toFixed(2)} against break-even ${ber.toFixed(2)}. This is the ad to make more of.`;
        } else {
          code = 'KEEP';
          why = `ROAS ${roas.toFixed(2)} against break-even ${ber.toFixed(2)}. Carrying its weight.`;
        }
        const f = shopFacts(a);
        if (code === 'PAUSE' && f && f.orders > 0 && ber > 0 && spend > 0 && f.revenue / spend >= ber) {
          code = 'WATCH';
          why = `Meta shows ROAS ${roas.toFixed(2)}, but the Shopify order book credits this ad's name with ${f.orders} order${f.orders === 1 ? '' : 's'} (${money(f.revenue, ctx)}) — ROAS ${(f.revenue / spend).toFixed(2)}, above break-even ${ber.toFixed(2)}. Check it before you pause it.`;
          extra = { shopCheck: true };
        }
        extra = { ...extra, urgency: code === 'PAUSE' ? 'now' : null,
                  lost: r2(Math.max(0, spend - (ber > 0 ? rev / ber : rev))) };
      }

      return {
        id: a.id, name: a.name, type: a.type || 'Image',
        spend: r2(spend), purchases: purch, revenue: r2(rev), roas: r2(roas),
        tested: code !== 'TESTING', threshold, code, why,
        ageDays: a.ageDays === undefined ? null : a.ageDays,
        frequency: n(a.frequency) || null,
        shop: a.shop || null,
        hook: hookReport(a),
        thumbnail: /^https:\/\//i.test(a.thumbnail || '') ? a.thumbnail : '',
        shopRoas: (a.shop && a.shop.state !== 'ambiguous' && a.shop.orders != null && spend > 0) ? r2(n(a.shop.revenue) / spend) : null,
        diagnosis: d,
        ...extra,
        /* What this ad cost beyond break-even over the lookback. */
        weeklyCost: code === 'PAUSE' ? r2(extra.lost || 0) : 0
      };
    });

    /* Pause worst-first, but never below the SOP floor of 3 ads. A campaign
       with four ads and three losers needs new creative, not an empty
       campaign. The held ad is still flagged as bleeding so the money it is
       losing stays visible. */
    const pausable = scored.filter(s => s.code === 'PAUSE')
      .sort((a, b) => b.weeklyCost - a.weeklyCost || b.spend - a.spend);
    const survivors = scored.length - pausable.length;
    const allowed = Math.max(0, Math.min(pausable.length, scored.length - SOP_MIN_ADS));

    pausable.forEach((s, i) => {
      if (i >= allowed) {
        s.heldFromPause = true;
        s.code = 'KEEP_FOR_NOW';
        s.why = `${s.why} Held only because pausing it would drop the campaign under ${SOP_MIN_ADS} ads — upload its replacement today, then pause it.`;
      }
    });

    return {
      ads: scored,
      threshold,
      statistical,
      count: scored.length,
      overSop: Math.max(0, scored.length - SOP_MAX_ADS),
      toPause: scored.filter(s => s.code === 'PAUSE'),
      /* Every ad that is losing money past the evidence line, held or not. */
      bleeding: scored.filter(s => s.code === 'PAUSE' || s.heldFromPause),
      winners: scored.filter(s => s.code === 'SCALE_SOURCE'),
      survivors
    };
  }

  /* ------------------------------------------------------------------
     SPREAD THE WINNER — a second ad account, a different page
     ------------------------------------------------------------------
     Adding creatives widens a campaign. Spreading widens the business: the
     same winning ads in a second ad account behind a different page earn more
     reach and mean one ban cannot stop every sale. It is the other half of how
     the big competitors scale (see COMPETITOR_PLAYBOOK).

     It is only worth doing once the ad has proven itself, so it sits behind
     three gates. These gates are a house rule of thumb, not Meta's:
       1. profitable 3 days in a row   — the SOP's own trigger
       2. about €150 a day or more      — below that one account has room left
       3. a winning ad with orders      — there has to be something to copy
     ------------------------------------------------------------------ */
  const SPREAD = { minStreak: 3, minSpendPerDay: 150, minOrders: 2, maxWinners: 3 };

  const SPREAD_STEPS = [
    'Pick the second ad account: the one with the fewest active campaigns and no payment problem. Open its tab on this dashboard to check.',
    'Give it its own Facebook page with a different name and a real brand look — one page per ad account, as your anti-ban rule says. No doctor personas.',
    'Copy the winning ad(s) exactly: same video, same text, same headline. Do not change the winner\'s opening — the proof is that it already works.',
    'Rename each copy with a suffix such as " | B". The Shopify order book matches sales by ad name; two ads with the same name would count each other\'s orders.',
    'Build it like any test: one new campaign, 1 ad set, 3–5 ads, at least €100 a day, break-even ROAS in the campaign name. Judge it by the normal rules, starting with the day-1 11AM check.',
    'Leave the original campaign alone. The second account is extra reach and insurance, not a move.',
    'Give the new account its own pixel. The page will still fire both, so each account sees purchases from the other — judge the new campaign on the Shopify order book by ad name, not on Meta\'s count.'
  ];

  const SPREAD_DONTS = [
    'Do not spread a campaign that is not profitable yet. You would only copy a loss into a second account.',
    'Do not use a page or ad account that has ever been restricted.',
    'Do not launch the copy in the same ad account: it competes with the original for the same people.'
  ];

  /**
   * @param input { verdicts, campaign: {spendPerDay}, streak, ber, currency }
   * Returns null when the campaign has not earned the question yet.
   */
  function spreadPlan(input) {
    const { verdicts, campaign = {}, streak = 0, ber = 0, currency } = input || {};
    if (!(streak >= SPREAD.minStreak && ber > 0) || !verdicts) return null;
    const ctx = { currency };
    const perDay = n(campaign.spendPerDay);
    const winners = verdicts.ads
      .filter(a => (a.code === 'SCALE_SOURCE' || a.code === 'KEEP') && n(a.purchases) >= SPREAD.minOrders && a.roas >= ber)
      .sort((a, b) => b.roas - a.roas || b.spend - a.spend)
      .slice(0, SPREAD.maxWinners)
      .map(a => ({ id: a.id, name: a.name, roas: a.roas, purchases: a.purchases, spend: a.spend,
                   hookRate: a.hook && a.hook.isVideo ? a.hook.hookRate : null }));

    const gates = [
      { key: 'streak', ok: true, text: `Profitable ${streak} days in a row.` },
      { key: 'spend', ok: perDay >= SPREAD.minSpendPerDay,
        text: perDay >= SPREAD.minSpendPerDay
          ? `Spending about ${money(perDay, ctx).replace(/\.\d\d$/, '')} a day — enough that one account is filling up.`
          : `Spending about ${money(perDay, ctx).replace(/\.\d\d$/, '')} a day. Below ${money(SPREAD.minSpendPerDay, ctx).replace(/\.\d\d$/, '')} a day one account still has room, so a second one adds cost before it adds sales.` },
      { key: 'winner', ok: winners.length > 0,
        text: winners.length
          ? `${winners.length} ad${winners.length === 1 ? '' : 's'} clearly earning: ${winners.map(w => `${w.name} (ROAS ${w.roas.toFixed(2)}, ${w.purchases} orders)`).join('; ')}.`
          : `No single ad has ${SPREAD.minOrders}+ orders above break-even yet, so there is nothing proven to copy.` }
    ];
    const ready = gates.every(g => g.ok);
    const names = winners.map(w => w.name);

    return {
      ready, gates, winners,
      headline: ready
        ? 'Winner found — test it in a second ad account with a different page'
        : 'Not ready to spread yet',
      steps: ready ? SPREAD_STEPS.slice() : [],
      donts: SPREAD_DONTS.slice(),
      planLines: ready ? [`Winner ready for a second ad account behind a different page: ${names.join(', ')}.`] : []
    };
  }

  /* What the biggest competitor does to scale. A dated snapshot: facts read
     from Meta's public Ad Library, the account structure inferred from them. */
  const COMPETITOR_PLAYBOOK = {
    title: 'How a big competitor scales — and what to copy',
    source: 'Prodigy Berlin (snoring product), Meta Ad Library, read 17 Nov 2026. Their ad accounts are not public; that part is inferred.',
    facts: [
      'About 4,600 ads in 13 months; around 210 live now, spread over six Facebook pages. Two of them carry about 77% of the live ads.',
      'Every live ad uses the same story text and the same headline. Only the video changes — 158 videos in 79 different lengths.',
      'All six pages send traffic to one landing page, and that page loads three Meta pixels. That points to about three ad-account setups sharing one site.',
      'Meta closed most of their older pages. The same ads get relaunched on fresh pages, so part of their scale is rebuilding after bans.'
    ],
    copy: [
      'Keep the text and headline fixed and change only the opening video. This is what the first-3-seconds panel above is for.',
      'Run the same winners from more than one page and ad account, so one ban does not stop sales.',
      'Add new ads every week, before the old ones tire.',
      'Send every page to one landing page and read sales in one place.'
    ],
    skip: [
      'Fake doctor personas and medical claims. They are what gets their pages closed, and in DACH they are a legal risk.',
      'Several pixels on one page with no plan. It scrambles the numbers per campaign.',
      'Copying their volume. They launch about 12 new ads a day on a large budget; your pace is 1–3 a week per campaign.'
    ]
  };

  function money(v, ctx) {
    const sym ={ EUR: '€', USD: '$', GBP: '£' }[(ctx && ctx.currency) || 'EUR'] || '€';
    return sym + n(v).toFixed(2);
  }

  /* ------------------------------------------------------------------
     CREATIVE FRESHNESS — "do I add new ads now, or not yet?"
     ------------------------------------------------------------------
     Competitors launch new ads constantly because every ad wears out: the
     same people see it again and again, click less, and the auction charges
     more to reach them. The budget rules cannot see this, which is why
     scaling "works" for a week and then falls apart.

     This reads the warning signs, weighs each one, and answers in three
     words: now, soon, or not yet — with how many to make. Every sign is
     written in plain language so the reason is visible, not just the answer.

       count        fewer than 3 live ads is a campaign with no safety net
       dependence   one ad carrying nearly all the spend — when it tires, the
                    whole campaign falls with it
       frequency    the same people seeing the top ad again and again
       CTR drop     fewer people clicking than a few days ago
       CPM rise     the auction charging more to show it
       ROAS trend   the last three days against the week before
       curve        more budget no longer earning more (the sweet spot rule)
       age          the top ad has been running for weeks
       pipeline     nothing new has gone in for a long time

     And one reason to ADD that is not a problem: the SOP says to test new
     creatives while a campaign is profitable three days running — that is
     when a failed test costs nothing and a winner scales sideways.
     ------------------------------------------------------------------ */
  const FRESH = {
    minLive: SOP_MIN_ADS,
    dependenceShare: 0.70, dependenceHard: 0.85,
    frequencyWarn: 2.0, frequencyAlert: 2.5,
    ctrDropWarn: 12, ctrDropAlert: 20,       // % lower than the days before
    cpmRiseWarn: 15, cpmRiseAlert: 25,
    roasDropWarn: 20,
    ageWarnDays: 21, ageAlertDays: 35,
    pipelineDays: 10,
    minImpressions: 2500,                    // per comparison window
    needScoreSoon: 1, needScoreAdd: 3, needScoreUrgent: 5,
    /* Weekly rhythm: the bigger the daily budget, the faster the audience
       burns through creatives. Tiers are [min €/day, new ads per week]. */
    cadence: [[300, 3], [150, 2], [100, 1]]
  };

  /** How many new ads a week a campaign spending `spendPerDay` should be getting. */
  function cadenceTarget(spendPerDay) {
    const s = n(spendPerDay);
    for (const [min, per] of FRESH.cadence) if (s >= min) return per;
    return 0;
  }

  const DAY_MS = 86400000;
  const sum = (arr, f) => arr.reduce((t, x) => t + n(f(x)), 0);

  /* Compare the last 3 days with the 4 before them, weighted by impressions so
     a thin day does not swing it. Returns null when there is not enough to say. */
  function trendOf(daily) {
    const days = (daily || []).filter(d => n(d.impressions) > 0).slice(-7);
    if (days.length < 5) return null;
    const recent = days.slice(-3), prior = days.slice(0, days.length - 3);
    const ri = sum(recent, d => d.impressions), pi = sum(prior, d => d.impressions);
    if (ri < FRESH.minImpressions || pi < FRESH.minImpressions) return null;
    const rc = sum(recent, d => d.clicks) / ri, pc = sum(prior, d => d.clicks) / pi;
    const rm = sum(recent, d => d.spend) / ri * 1000, pm = sum(prior, d => d.spend) / pi * 1000;
    return {
      ctrDropPct: pc > 0 ? r1(((pc - rc) / pc) * 100) : 0,
      cpmRisePct: pm > 0 ? r1(((rm - pm) / pm) * 100) : 0,
      ctrNow: r2(rc * 100), ctrBefore: r2(pc * 100)
    };
  }

  function roasTrend(history) {
    const days = (history || []).filter(d => d && d.date !== 'today' && n(d.spend) > 0).slice(-7);
    if (days.length < 5) return null;
    const recent = days.slice(-3), prior = days.slice(0, days.length - 3);
    const rs = sum(recent, d => d.spend), ps = sum(prior, d => d.spend);
    if (!(rs > 0) || !(ps > 0)) return null;
    const rr = sum(recent, d => d.revenue) / rs, pr = sum(prior, d => d.revenue) / ps;
    return { now: r2(rr), before: r2(pr), dropPct: pr > 0 ? r1(((pr - rr) / pr) * 100) : 0 };
  }

  /**
   * @param input { ads: per-ad rows (7-day, with .daily/.frequency/.ageDays),
   *                verdicts, campaign: {history, learning, daysLive, spendPerDay},
   *                curve, streak, ber }
   */
  function freshness(input) {
    const { ads = [], verdicts, campaign = {}, curve = null, streak = 0, ber = 0 } = input;
    const live = (verdicts ? verdicts.ads : ads).filter(a => a.code !== 'PAUSE');
    /* Meta only reports ads that spent. An ad that is switched on but not
       delivering still counts toward the campaign's safety net, so when the
       true count of switched-on ads is known it wins over the spend rows. */
    const liveN = input.activeAds === undefined || input.activeAds === null
      ? live.length
      : Math.max(0, input.activeAds - (verdicts ? verdicts.toPause.length : 0));
    const totalSpend = sum(ads, a => a.spend);
    const top = ads.slice().sort((a, b) => n(b.spend) - n(a.spend))[0] || null;
    const topShare = top && totalSpend > 0 ? n(top.spend) / totalSpend : 0;
    const signals = [];
    const add = (key, weight, text) => signals.push({ key, weight, text });

    if (liveN < FRESH.minLive) {
      add('count', 3, liveN === 0
        ? 'No ad is running with spend. The campaign has nothing to show.'
        : `Only ${liveN} ad${liveN === 1 ? '' : 's'} live. The SOP wants 3–5 so one tired ad cannot sink the campaign.`);
    }
    if (liveN >= 2 && topShare >= FRESH.dependenceShare) {
      add('dependence', topShare >= FRESH.dependenceHard ? 2 : 1,
        `One ad takes ${Math.round(topShare * 100)}% of the spend (${top.name}). When it wears out, the whole campaign goes with it.`);
    }
    const freq = top ? n(top.frequency) : 0;
    if (freq >= FRESH.frequencyWarn) {
      add('frequency', freq >= FRESH.frequencyAlert ? 2 : 1,
        `The top ad has shown to the same people ${freq.toFixed(1)} times on average. Above ${FRESH.frequencyAlert} people start ignoring it.`);
    }
    const tr = top ? trendOf(top.daily) : null;
    if (tr && tr.ctrDropPct >= FRESH.ctrDropWarn) {
      add('ctr', tr.ctrDropPct >= FRESH.ctrDropAlert ? 2 : 1,
        `The top ad's click rate fell ${Math.round(tr.ctrDropPct)}% (${tr.ctrBefore}% → ${tr.ctrNow}%) over the last 3 days. Fewer people want to click it.`);
    }
    if (tr && tr.cpmRisePct >= FRESH.cpmRiseWarn) {
      add('cpm', tr.cpmRisePct >= FRESH.cpmRiseAlert ? 2 : 1,
        `Reaching people costs ${Math.round(tr.cpmRisePct)}% more than a few days ago. The auction is charging more to show the same ad.`);
    }
    const rt = roasTrend(campaign.history);
    if (rt && rt.dropPct >= FRESH.roasDropWarn) {
      add('roas', 1, `ROAS fell from ${rt.before} to ${rt.now} over the last 3 days.`);
    }
    if (curve && (curve.state === 'plateau' || curve.state === 'ceiling')) {
      add('curve', 3, curve.state === 'plateau'
        ? 'More budget has stopped earning more profit. New creatives are the only lever left.'
        : 'This campaign earned most at a lower budget. More budget on the same ads is already proven not to pay.');
    }
    if (top && top.ageDays !== null && top.ageDays !== undefined && top.ageDays >= FRESH.ageWarnDays) {
      add('age', top.ageDays >= FRESH.ageAlertDays ? 2 : 1,
        `The main ad has been running ${Math.round(top.ageDays)} days. Even winners wear out; the next one should be ready before this one fails.`);
    }
    const ages = ads.map(a => a.ageDays).filter(x => x !== null && x !== undefined);
    const newest = ages.length ? Math.min(...ages) : null;
    const newLast7 = ages.filter(x => x <= 7).length;
    if (newest !== null && newest >= FRESH.pipelineDays && n(campaign.spendPerDay) >= 100) {
      add('pipeline', 1, `Nothing new has gone into this campaign for ${Math.round(newest)} days.`);
    }

    /* Profitable three days running is the SOP's trigger for new creatives. It
       also ends the "too early to judge" exemption: a campaign that has already
       beaten break-even three days in a row has been judged. */
    const streakTrigger = streak >= 3 && ber > 0;
    const young = (campaign.learning || n(campaign.daysLive) < 3) && !streakTrigger;
    const target = cadenceTarget(campaign.spendPerDay);
    const cadence = { target, actual: newLast7, met: newLast7 >= target };
    if (!young && target > 0 && newLast7 < target) {
      add('cadence', 1,
        `Spending about €${Math.round(n(campaign.spendPerDay))} a day, this campaign should get ${target} new ad${target === 1 ? '' : 's'} a week. Only ${newLast7} went in during the last 7 days.`);
    }

    const score = sum(signals, s => s.weight);
    const opportunities = [];
    if (streak >= 3 && ber > 0) {
      opportunities.push(`Profitable ${streak} days in a row. Your SOP says this is the moment to test new creatives: a failed test costs nothing and a winner scales sideways.`);
    }

    let state, headline, addCount = 0;
    if (young) {
      state = 'learning';
      headline = 'Not yet — too early to judge';
      if (liveN < FRESH.minLive && liveN > 0) {
        headline = `Not yet — but only ${liveN} ad${liveN === 1 ? '' : 's'} live`;
      }
    } else if (score >= FRESH.needScoreUrgent || liveN === 0 || (liveN < FRESH.minLive && score >= FRESH.needScoreAdd)) {
      state = 'urgent';
      addCount = Math.min(4, Math.max(3, FRESH.minLive - liveN + 1));
      headline = `Add ${addCount} new creatives today`;
    } else if (score >= FRESH.needScoreAdd) {
      state = 'add'; addCount = 3;
      headline = streakTrigger
        ? `Profitable ${streak} days running — add 3 new creatives now`
        : 'Add 3 new creatives now';
    } else if (streakTrigger) {
      state = 'add';
      addCount = Math.max(2, target);
      headline = `Profitable ${streak} days running — add ${addCount} new creatives now`;
    } else if (score >= FRESH.needScoreSoon || opportunities.length) {
      state = 'soon'; addCount = 2;
      headline = 'Get 2 new creatives ready this week';
    } else {
      state = 'ok';
      headline = 'Not yet — the current ads are holding up';
    }

    return {
      state, headline, addCount, score, signals, opportunities,
      trigger: streakTrigger ? 'streak' : null, streak: streakTrigger ? streak : 0,
      liveAds: liveN, topAd: top ? top.name : null, topShare: r2(topShare),
      newestAdDays: newest === null ? null : Math.round(newest), newLast7, cadence,
      trend: tr, roasTrend: rt
    };
  }

  /* ------------------------------------------------------------------
     WHAT TO COMMISSION
     ------------------------------------------------------------------ */
  /**
   * Looks across a campaign's ads and works out what the creative team
   * should actually make — how many, in what format, fixing what.
   */
  function campaignNeeds(verdicts, ctx) {
    const live = verdicts.ads.filter(a => a.code !== 'PAUSE');
    const after = live.length;
    const shortfall = Math.max(0, SOP_MIN_ADS - after);
    const headroom = Math.max(0, SOP_MAX_ADS - after);

    /* Which stage fails most often across this campaign's ads, weighted by
       spend — one bad ad with €8 on it should not set the brief. */
    const tally = {};
    verdicts.ads.forEach(a => {
      const p = a.diagnosis.primary;
      if (!p) return;
      tally[p.key] = (tally[p.key] || 0) + a.spend;
    });
    const ranked = Object.entries(tally).sort((x, y) => y[1] - x[1]);
    const dominant = ranked.length ? STAGES.find(s => s.key === ranked[0][0]) : null;

    /* Format read: which type is actually earning here. */
    const byType = {};
    verdicts.ads.forEach(a => {
      const t = a.type || 'Image';
      const b = byType[t] = byType[t] || { spend: 0, revenue: 0, n: 0 };
      b.spend += a.spend; b.revenue += a.revenue; b.n += 1;
    });
    const formats = Object.entries(byType)
      .map(([type, b]) => ({ type, n: b.n, spend: r2(b.spend), roas: b.spend > 0 ? r2(b.revenue / b.spend) : 0 }))
      .sort((a, b) => b.roas - a.roas);

    const winner = verdicts.winners[0] || null;

    return {
      liveAfterPauses: after,
      shortfall,
      headroom,
      needed: shortfall > 0 ? shortfall : (verdicts.toPause.length ? Math.min(headroom, verdicts.toPause.length) : 0),
      dominant,
      dominantSpend: ranked.length ? r2(ranked[0][1]) : 0,
      formats,
      bestFormat: formats[0] || null,
      winner,
      urgent: shortfall > 0
    };
  }

  /* ------------------------------------------------------------------
     THE BRIEF
     ------------------------------------------------------------------
     Plain enough for an editor to act on without a meeting.
     ------------------------------------------------------------------ */
  function brief(campaignName, verdicts, needs, ctx, fresh, hooks, spread) {
    const lines = [];
    const cur = (ctx && ctx.currency) || 'EUR';

    if (!needs.needed && !verdicts.toPause.length && !verdicts.overSop) {
      return {
        headline: 'Nothing to commission',
        urgent: false,
        lines: [`${verdicts.count} ads live, all inside the SOP and none past a fair test without a sale. Leave the creative alone this week.`]
      };
    }

    /* The headline uses the product name because that is how the team talks
       about it; the body carries the full campaign string so it can be found
       in Ads Manager without guessing. */
    lines.push(`**Campaign:** ${(ctx && ctx.fullName) || campaignName}`);
    lines.push(`**Live ads:** ${verdicts.count}${verdicts.overSop ? ` — ${verdicts.overSop} over the 3–5 SOP` : ''}`);

    if (verdicts.toPause.length) {
      lines.push('');
      lines.push(`**Pause first (${verdicts.toPause.length}):**`);
      verdicts.toPause.forEach(a => {
        lines.push(`- ${a.name} — ${money(a.spend, ctx)}, ${a.purchases} order${a.purchases === 1 ? '' : 's'}${a.weeklyCost > 0 ? `, costing about ${money(a.weeklyCost, ctx)} a week` : ''}`);
      });
    }

    if (needs.needed > 0) {
      lines.push('');
      lines.push(`**Make ${needs.needed} new ${needs.needed === 1 ? 'ad' : 'ads'}.**`);
      const why = fresh ? fresh.signals.map(sg => sg.text).concat(fresh.opportunities || []) : [];
      if (why.length) {
        lines.push('Why now:');
        why.forEach(t => lines.push(`- ${t}`));
      }
      lines.push('Launch them as a new test campaign beside this one (horizontal scaling), so the ad that is working is not disturbed.');
      if (needs.bestFormat && needs.bestFormat.roas > 0) {
        lines.push(`Format: **${needs.bestFormat.type}** — it runs at ROAS ${needs.bestFormat.roas} here against ${needs.formats.slice(1).map(f => `${f.type} ${f.roas}`).join(', ') || 'nothing else tested'}.`);
      }
    }

    if (hooks && hooks.measured && (needs.needed > 0 || hooks.replace)) {
      lines.push('');
      lines.push('**The first 3 seconds — keep and change:**');
      if (hooks.keep) {
        lines.push(`Keep this opening: **${hooks.keep.name}** — hook rate ${hooks.keep.hookRate}% (target ${hooks.keep.target}%+). Put it on the new ads and change what comes after second 3.`);
      } else {
        lines.push('No opening here is at target yet, so every new ad needs a new first 3 seconds.');
      }
      if (hooks.replace) {
        lines.push(`Replace this opening: **${hooks.replace.name}** — hook rate ${hooks.replace.hookRate}%, ${r1(100 - hooks.replace.hookRate)}% scroll past before second 3, ${money(hooks.replace.spend, ctx)} spent on it.`);
        hooks.replace.changes.forEach(c => lines.push(`- ${c}`));
      } else if (hooks.beatOnly) {
        lines.push(`The opening of **${hooks.beatOnly.name}** works, but viewers leave right after it.`);
        hooks.beatOnly.changes.forEach(c => lines.push(`- ${c}`));
      }
    }

    if (spread && spread.ready) {
      lines.push('');
      lines.push(`**Spread the winner:** ${spread.winners.map(w => `**${w.name}** (ROAS ${w.roas.toFixed(2)}, ${w.purchases} orders)`).join(', ')} — test in a second ad account behind a different page.`);
      spread.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    }

    if (needs.dominant) {
      lines.push('');
      lines.push(`**What they must fix: ${needs.dominant.label.toUpperCase()} (${needs.dominant.window}).**`);
      lines.push(needs.dominant.fails);
      lines.push('');
      lines.push(`**Direction:** ${needs.dominant.fix}`);
      lines.push(`**Template:** ${needs.dominant.template}`);
      lines.push(`This is where ${money(needs.dominantSpend, ctx)} of this campaign's spend is being lost, so it is the only thing the new cut has to beat.`);
    }

    if (needs.winner) {
      lines.push('');
      lines.push(`**Use as the reference:** ${needs.winner.name} (ROAS ${needs.winner.roas}).`);
      const w = needs.winner.diagnosis;
      const strong = w.stages.filter(s => s.measurable && s.status === 'healthy').map(s => s.label);
      if (strong.length) lines.push(`It holds up on ${strong.join(', ').toLowerCase()} — keep whatever it does there and change the rest.`);
      if (w.isVideo && needs.winner.diagnosis.stages[0] && needs.winner.diagnosis.stages[0].value) {
        lines.push(`Its hook rate is ${needs.winner.diagnosis.stages[0].value}%. The new ads have to clear that to be worth running.`);
      }
    }

    return {
      headline: needs.urgent
        ? `Urgent — ${campaignName} drops to ${needs.liveAfterPauses} ads`
        : needs.needed
          ? `Commission ${needs.needed} for ${campaignName}`
          : `Prune ${campaignName}`,
      urgent: needs.urgent,
      lines
    };
  }

  /** Everything for one campaign in a single call. */

  /* ------------------------------------------------------------------
     DELIVERY CHECK — is Meta still spending the budget, and are clicks still
     turning into orders?

     Three readings, from data already on the page (the ads' daily rows and the
     campaign's daily orders). It never moves a budget and never pauses anything.
       squeezed       spend fell well under budget AND CPM rose: you are paying
                      more per view and still getting less
       underdelivery  spend fell well under budget, CPM did not rise
       page           spend is fine and CTR holds, but orders per 100 clicks fell
                      by half: the leak is after the click

     The numbers are a rule of thumb. Checked day by day on 6 real campaigns
     (5 to 14 days each, 17 Nov 2026): quiet on the three where the budget had
     been cut by hand, and it fired on the three that really dipped — one of
     them was paused the next day. They are not Meta's numbers, and Meta never
     says who won an auction.
     ------------------------------------------------------------------ */
  const SQUEEZE = {
    minDays: 5,          // days with spend before it says anything
    recentDays: 2,       // the days judged for delivery
    pageRecentDays: 3,   // the days judged for orders per click
    fillAlert: 0.70,     // spending under 70% of budget ...
    fullBefore: 0.85,    // ... after having spent at least 85% on some earlier day
    cpmRisePct: 20,      // CPM this much above its own earlier level = a price squeeze
    ctrKeep: 0.80,       // CTR still at least 80% of before = the ads themselves hold up
    rateDrop: 0.50,      // orders per 100 clicks at or under half of before
    minBaseOrders: 8,    // need this many orders before to compare against
    minRecentClicks: 150
  };

  /**
   * @param input { ads: rows with .daily [{date,spend,impressions,clicks}], history: [{date,spend,purchases}],
   *                budget (now), budgetChanges: [{date,time,oldBudget,newBudget}] from the account's change log (or null),
   *                learning, status, beCpa, currency, seasonNote }
   * @returns null (nothing to flag) or { primary, flags, headline, why[], todo[], numbers }
   */
  function squeezeCheck(input) {
    const inp = input || {};
    if (inp.status && !/^(ACTIVE|WITH_ISSUES)$/i.test(inp.status)) return null;
    if (inp.learning) return null;

    // Fold the ads' daily rows into one row per day for the campaign.
    const byDate = {};
    (inp.ads || []).forEach(a => (a.daily || []).forEach(d => {
      if (!d || !d.date) return;
      const o = byDate[d.date] || (byDate[d.date] = { date: d.date, spend: 0, impressions: 0, clicks: 0 });
      o.spend += n(d.spend); o.impressions += n(d.impressions); o.clicks += n(d.clicks);
    }));
    const orders = {};
    (inp.history || []).forEach(h => { if (h && h.date) orders[h.date] = n(h.purchases); });

    const days = Object.values(byDate).filter(d => d.spend > 0).sort((a, b) => a.date.localeCompare(b.date));
    if (days.length < SQUEEZE.minDays) return null;

    const money = (v) => (inp.currency === 'USD' ? '$' : inp.currency === 'GBP' ? '£' : '€') + Math.round(v);
    const pct = (v) => Math.round(v * 100);
    const flags = [];
    const numbers = {};

    /* ---- delivery: spend against the budget in force THAT day, and CPM ----
       A budget cut by hand makes spend fall without anything being wrong, so
       each day is measured against the budget that was live on it, and a day
       the budget changed on is left out. Without the change log the check is
       skipped rather than guessed. */
    const budget = n(inp.budget);
    const changes = Array.isArray(inp.budgetChanges) ? inp.budgetChanges : null;
    numbers.deliveryChecked = false;
    if (budget > 0 && changes) {
      const budgetOn = (date) => {
        const list = changes.slice().sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
        if (list.some(c => c.date === date)) return null;              // changed that day: mixed, leave it out
        const before = list.filter(c => c.date < date);
        if (before.length) return n(before[before.length - 1].newBudget);
        const after = list.find(c => c.date > date);
        return after ? n(after.oldBudget) : budget;
      };
      const clean = days.map(d => Object.assign({ budget: budgetOn(d.date) }, d)).filter(d => d.budget > 0);
      const recentAll = days.slice(-SQUEEZE.recentDays);
      const recent = clean.filter(d => recentAll.some(r => r.date === d.date));
      const base = clean.filter(d => !recentAll.some(r => r.date === d.date));
      if (recent.length === SQUEEZE.recentDays && base.length >= 3) {
        numbers.deliveryChecked = true;
        const fillOf = d => d.spend / d.budget;
        const fillRecent = recent.reduce((t, d) => t + fillOf(d), 0) / recent.length;
        const fillBase = base.reduce((t, d) => t + fillOf(d), 0) / base.length;
        const spentFullBefore = base.some(d => fillOf(d) >= SQUEEZE.fullBefore);
        numbers.fillRecent = r2(fillRecent); numbers.fillBase = r2(fillBase);
        if (spentFullBefore && fillRecent <= SQUEEZE.fillAlert) {
          const im = (arr) => arr.reduce((t, d) => t + d.impressions, 0);
          const sp = (arr) => arr.reduce((t, d) => t + d.spend, 0);
          const cpmRecent = im(recent) > 0 ? sp(recent) / im(recent) * 1000 : 0;
          const cpmBase = im(base) > 0 ? sp(base) / im(base) * 1000 : 0;
          const rise = cpmBase > 0 ? ((cpmRecent - cpmBase) / cpmBase) * 100 : 0;
          numbers.cpmRecent = r2(cpmRecent); numbers.cpmBase = r2(cpmBase); numbers.cpmRisePct = r1(rise);
          flags.push(rise >= SQUEEZE.cpmRisePct ? 'squeezed' : 'underdelivery');
        }
      }
    }

    /* ---- the page: orders per 100 clicks, with CTR holding ---- */
    const pr = days.slice(-SQUEEZE.pageRecentDays);
    const pb = days.slice(0, days.length - SQUEEZE.pageRecentDays);
    if (pb.length >= 3) {
      const clicks = arr => arr.reduce((t, d) => t + d.clicks, 0);
      const imps = arr => arr.reduce((t, d) => t + d.impressions, 0);
      const ords = arr => arr.reduce((t, d) => t + n(orders[d.date]), 0);
      const baseOrders = ords(pb), recentClicks = clicks(pr);
      if (baseOrders >= SQUEEZE.minBaseOrders && recentClicks >= SQUEEZE.minRecentClicks && clicks(pb) > 0) {
        const rateBase = baseOrders / clicks(pb) * 100;
        const rateRecent = ords(pr) / recentClicks * 100;
        const ctrBase = imps(pb) > 0 ? clicks(pb) / imps(pb) : 0;
        const ctrRecent = imps(pr) > 0 ? clicks(pr) / imps(pr) : 0;
        numbers.ordersPer100Base = r2(rateBase); numbers.ordersPer100Recent = r2(rateRecent);
        numbers.ctrBase = r2(ctrBase * 100); numbers.ctrRecent = r2(ctrRecent * 100);
        if (rateRecent <= rateBase * SQUEEZE.rateDrop && ctrRecent >= ctrBase * SQUEEZE.ctrKeep) flags.push('page');
      }
    }

    if (!flags.length) return null;
    const primary = flags.includes('squeezed') ? 'squeezed' : flags.includes('underdelivery') ? 'underdelivery' : 'page';
    const delivery = primary !== 'page';
    const both = delivery && flags.includes('page');

    let headline;
    if (primary === 'squeezed') {
      headline = `Delivery squeeze: spending ${pct(numbers.fillRecent)}% of budget while CPM is up ${Math.round(numbers.cpmRisePct)}%`;
    } else if (primary === 'underdelivery') {
      headline = `Under-delivering: only ${pct(numbers.fillRecent)}% of budget spent (it was spending ${pct(numbers.fillBase)}%)`;
    } else {
      headline = `Clicks stopped turning into orders: ${numbers.ordersPer100Base} → ${numbers.ordersPer100Recent} orders per 100 clicks`;
    }
    if (both) headline += ' — and orders per click fell too';

    const why = [];
    if (delivery) {
      why.push(`Spend over the last ${SQUEEZE.recentDays} days averaged ${pct(numbers.fillRecent)}% of the ${money(budget)} budget; earlier it was ${pct(numbers.fillBase)}%.`);
      why.push(primary === 'squeezed'
        ? `CPM went from ${money(numbers.cpmBase)} to ${money(numbers.cpmRecent)} (+${Math.round(numbers.cpmRisePct)}%): you are paying more per thousand views and still getting less.`
        : `CPM barely moved (${money(numbers.cpmBase)} → ${money(numbers.cpmRecent)}), so the price did not rise — Meta is simply finding fewer people it expects to buy.`);
    }
    if (flags.includes('page')) {
      why.push(`Orders per 100 clicks fell from ${numbers.ordersPer100Base} to ${numbers.ordersPer100Recent} while CTR held (${numbers.ctrBase}% → ${numbers.ctrRecent}%): people still click, fewer buy. The leak is after the click.`);
    }
    if (inp.seasonNote) why.push(inp.seasonNote);

    const todo = [];
    if (delivery) {
      todo.push('Do not raise the budget.');
      todo.push('Add a new first 3 seconds. Near-copies of other ads can compete with each other for delivery.');
      if (n(inp.beCpa) > 0) todo.push(`Consider a cost cap near your break-even cost per order (${money(inp.beCpa)}). Test it on one campaign: it can also cut spend.`);
      todo.push('Check in Events Manager that Purchase still fires.');
    }
    if (flags.includes('page')) {
      todo.push('Find what changed on the page or checkout in these days: price, shipping text, banner, speed, payment methods.');
      todo.push('Click through ad → page → checkout on your phone.');
      if (!delivery) todo.push('Leave the ads alone for now — CTR shows they are doing their job.');
    }
    return { primary, flags, headline, why, todo, numbers };
  }

  /**
   * Turn Meta's activity log (category BUDGET) into per-campaign budget changes
   * with dates in the ACCOUNT's clock, which is the clock the daily rows use.
   * Values in the log are minor units (cents). Ad-set budget changes are mapped
   * to their campaign. Anything it cannot read is skipped, never guessed.
   * @param rows [{event_type, object_id, event_time, extra_data}]
   * @param tz   IANA zone of the ad account
   * @param adsetToCampaign {adsetId: campaignId}
   * @returns {campaignId: [{date,time,oldBudget,newBudget}]}
   */
  function parseBudgetLog(rows, tz, adsetToCampaign) {
    const out = {};
    let fmt = null;
    try {
      fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    } catch (e) { return out; }
    (rows || []).forEach(r => {
      if (!r || !/^update_(campaign|ad_set)_budget$/.test(r.event_type || '')) return;
      const id = r.object_id;
      const cid = r.event_type === 'update_campaign_budget' ? id : (adsetToCampaign || {})[id];
      if (!cid) return;
      let ex = r.extra_data;
      if (typeof ex === 'string') { try { ex = JSON.parse(ex); } catch (e) { return; } }
      if (!ex || !ex.old_value || !ex.new_value) return;
      const oldV = n(ex.old_value.old_value), newV = n(ex.new_value.new_value);
      if (!(oldV > 0) || !(newV > 0)) return;
      const t = new Date(String(r.event_time || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
      if (isNaN(t.getTime())) return;
      const parts = {};
      fmt.formatToParts(t).forEach(p => { parts[p.type] = p.value; });
      (out[cid] = out[cid] || []).push({
        date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`,
        oldBudget: oldV / 100, newBudget: newV / 100
      });
    });
    Object.values(out).forEach(l => l.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)));
    return out;
  }

  function desk(campaignName, ads, ctx) {
    const verdicts = adVerdicts(ads, ctx);
    const needs = campaignNeeds(verdicts, ctx);
    const fresh = freshness({
      ads, verdicts, campaign: (ctx && ctx.campaign) || {},
      curve: ctx && ctx.curve, streak: (ctx && ctx.streak) || 0, ber: ctx && ctx.ber,
      activeAds: ctx && ctx.activeAds
    });
    /* The freshness read can ask for more ads than the pruning logic alone. */
    needs.needed = Math.max(needs.needed, fresh.addCount);
    if (fresh.state === 'urgent') needs.urgent = true;
    const hooks = hookDesk(verdicts.ads);
    const spread = spreadPlan({
      verdicts, campaign: (ctx && ctx.campaign) || {}, streak: (ctx && ctx.streak) || 0,
      ber: ctx && ctx.ber, currency: ctx && ctx.currency
    });
    const squeeze = squeezeCheck({
      ads, history: ((ctx && ctx.campaign) || {}).history, budget: ctx && ctx.budget,
      learning: ((ctx && ctx.campaign) || {}).learning, status: ctx && ctx.status,
      budgetChanges: ctx && ctx.budgetChanges, beCpa: ctx && ctx.beCpa,
      currency: ctx && ctx.currency, seasonNote: ctx && ctx.seasonNote
    });
    return { campaign: campaignName, verdicts, needs, fresh, hooks, spread, squeeze,
             brief: brief(campaignName, verdicts, needs, ctx, fresh, hooks, spread) };
  }

  return {
    STAGES, SOP_MAX_ADS, SOP_MIN_ADS, FAIR_TEST_MULTIPLE, AD_RULES, FRESH,
    HOOK, SPREAD, SQUEEZE, COMPETITOR_PLAYBOOK, spreadPlan, squeezeCheck, parseBudgetLog, retention, diagnose, hookReport, hookDesk, fairTestThreshold, poissonCdf, judgeAd, adVerdicts,
    freshness, cadenceTarget, trendOf, roasTrend, campaignNeeds, brief, desk
  };
});
