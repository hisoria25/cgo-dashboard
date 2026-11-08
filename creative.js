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
    const threshold = fairTestThreshold(list, ctx && ctx.campaignCpa);
    const ber = n(ctx && ctx.ber);

    const scored = list.map(a => {
      const spend = n(a.spend), purch = n(a.purchases), rev = n(a.revenue);
      const roas = spend > 0 ? rev / spend : 0;
      const tested = threshold ? spend >= threshold : false;
      const d = diagnose(a);

      let code, why;
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

      return {
        id: a.id, name: a.name, type: a.type || 'Image',
        spend: r2(spend), purchases: purch, revenue: r2(rev), roas: r2(roas),
        tested, threshold, code, why,
        diagnosis: d,
        /* Weekly bleed, for ranking what to kill first. */
        weeklyCost: code === 'PAUSE' && ber > 0
          ? r2(((spend / Math.max(1, n(a.days) || 7)) * 7) * (1 - roas / ber))
          : 0
      };
    });

    /* Pause worst-first, but never below the SOP floor of 3 ads. A campaign
       with four ads and three losers needs new creative, not an empty
       campaign. */
    const pausable = scored.filter(s => s.code === 'PAUSE')
      .sort((a, b) => b.weeklyCost - a.weeklyCost || b.spend - a.spend);
    const survivors = scored.length - pausable.length;
    const allowed = Math.max(0, Math.min(pausable.length, scored.length - SOP_MIN_ADS));

    pausable.forEach((s, i) => {
      if (i >= allowed) {
        s.code = 'KEEP_FOR_NOW';
        s.why = `${s.why} Held only because pausing it would drop the campaign under ${SOP_MIN_ADS} ads — replace it rather than just switching it off.`;
      }
    });

    return {
      ads: scored,
      threshold,
      count: scored.length,
      overSop: Math.max(0, scored.length - SOP_MAX_ADS),
      toPause: scored.filter(s => s.code === 'PAUSE'),
      winners: scored.filter(s => s.code === 'SCALE_SOURCE'),
      survivors
    };
  }

  function money(v, ctx) {
    const sym = { EUR: '€', USD: '$', GBP: '£' }[(ctx && ctx.currency) || 'EUR'] || '€';
    return sym + n(v).toFixed(2);
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
  function brief(campaignName, verdicts, needs, ctx) {
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
      if (needs.bestFormat && needs.bestFormat.roas > 0) {
        lines.push(`Format: **${needs.bestFormat.type}** — it runs at ROAS ${needs.bestFormat.roas} here against ${needs.formats.slice(1).map(f => `${f.type} ${f.roas}`).join(', ') || 'nothing else tested'}.`);
      }
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
  function desk(campaignName, ads, ctx) {
    const verdicts = adVerdicts(ads, ctx);
    const needs = campaignNeeds(verdicts, ctx);
    return { campaign: campaignName, verdicts, needs, brief: brief(campaignName, verdicts, needs, ctx) };
  }

  return {
    STAGES, SOP_MAX_ADS, SOP_MIN_ADS, FAIR_TEST_MULTIPLE,
    retention, diagnose, fairTestThreshold, adVerdicts, campaignNeeds, brief, desk
  };
});
