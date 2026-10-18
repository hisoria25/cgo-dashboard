/* The dashboard's test suite — every rule that has ever been got wrong once.
 *
 * Run it with:  node tests/all.test.js
 *
 * Each suite below is the file it came from, wrapped in its own scope so the
 * suites cannot collide. A suite that fails does not stop the others: the run
 * reports every failure at once, because fixing one rule often breaks another.
 */

const __results = [];
const __report = (name, pass, fail) => __results.push({ name, pass, fail });
const __bail = (name) => __results.push({ name, pass: 0, fail: 1, bailed: true });

/* ===== lookback ======================================================== */
(() => {
/* Tests for the three EcomLiberty-SOP changes:
   1. a single bad day can no longer cut the budget  (HOLD)
   2. descales are decided by the 3-day pooled window
   3. a descale cannot starve the ad sets under it     (budget floor)        */
const VE = require('../rules.js');
let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.log(`  FAIL ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
}

/* A campaign whose name carries BER 1.50 (grossMargin 66.7%) and margin 67. */
const NAME = 'TestProduct | 1.50 | 67';
// Midnight read: the window that scales, descales and kills.
// BER and gross margin arrive on the context, the way app.js supplies them
// after parsing the campaign name. BER 1.50 ⇒ gross margin 66.7%.
const CTX = { window: 'midnight', currency: 'EUR', learning: false, ber: 1.5 };

const d = (spend, revenue) => ({ date: '2026-10-01', spend, revenue, roas: revenue / spend });

function camp(extra) {
  return Object.assign({
    id: 'x', name: NAME, status: 'ACTIVE', budget: 100, daysLive: 10,
    spend: 100, revenue: 120, purchases: 4, frequency: 1.3,
    ctr: 1.2, cpm: 12, clicks: 200, lpv: 180, atc: 20, ic: 10,
    descaleCount: 0, adsetCount: 1, history: []
  }, extra);
}

/* ---------- 1. trailingRoas does the arithmetic the right way ---------- */
check('pools the money instead of averaging the ratios',
  Math.round(VE.trailingRoas([d(10, 40), d(300, 300)], 3).roas * 100) / 100, 1.1);
/* 340 / 310 = 1.10. Averaging the two days' ROAS would have said 2.50 — the
   €10 day shouting as loudly as the €300 one. */
check('an average of ratios would have said 2.50 — it does not',
  VE.trailingRoas([d(10, 40), d(300, 300)], 3).roas > 2.4, false);
check('skips days the campaign was switched off', VE.trailingRoas([d(100, 300), { spend: 0, revenue: 0 }], 3).days, 1);
check('no history at all ⇒ no window', VE.trailingRoas([], 3), null);
check('reads only the last N closed days', VE.trailingRoas([d(100, 1000), d(100, 150), d(100, 150), d(100, 150)], 3).days, 3);

/* ---------- 2. THE REGRESSION: one bad day must not cut the budget ----- */
/* Yesterday ROAS 0.90 (under BER 1.50) but the two days before it were 2.4.
   Pooled: (90+240+240)/(100+100+100) = 1.90 — still above break-even.      */
const badDayGoodWeek = camp({
  spend: 100, revenue: 90,
  history: [d(100, 240), d(100, 240), d(100, 90)]
});
const v1 = VE.verdict(badDayGoodWeek, CTX);
check('a single unprofitable day is now a HOLD, not a −40% cut', v1.code, 'HOLD');
check('and the budget it prints is the budget he already has', v1.budgetTo, 100);
check('and it says out loud what the window was', /1\.90/.test(v1.reasons.join(' ')), true);

/* ---------- 3. a sustained slide still gets cut ------------------------ */
const realSlide = camp({
  spend: 100, revenue: 90,
  history: [d(100, 95), d(100, 100), d(100, 90)]
});
const v2 = VE.verdict(realSlide, CTX);
check('three bad days in a row still descales', v2.code, 'DESCALE');
check('cut 40% off €100', v2.budgetTo, 60);
check('and the reason cites the window, not the day', /3 closed days/.test(v2.reasons.join(' ')), true);

/* ---------- 4. the budget floor ---------------------------------------- */
/* €180/day across 4 live ad sets. A straight −40% lands on €108; the floor
   for 4 ad sets is 4 × €25 = €100, so €108 clears it — cut allowed, but the
   consolidate-first warning must fire because the campaign is loaded.      */
const loaded = camp({
  budget: 180, spend: 180, revenue: 160, adsetCount: 4,
  history: [d(180, 170), d(180, 175), d(180, 160)]
});
const v3 = VE.verdict(loaded, CTX);
check('loaded campaign still descales', v3.code, 'DESCALE');
check('−40% of €180 = €108, above the €100 floor', v3.budgetTo, 108);
check('but it warns to trim ad sets before cutting',
  /consolidate the weakest ad set FIRST/.test(v3.notes.join(' ')), true);

/* Same shape, 6 ad sets ⇒ floor €150. −40% would land on €108, below it. */
const tooDeep = camp({
  budget: 180, spend: 180, revenue: 160, adsetCount: 6,
  history: [d(180, 170), d(180, 175), d(180, 160)]
});
const v4 = VE.verdict(tooDeep, CTX);
check('the cut is held at the floor, not driven through it', v4.budgetTo, 150);
check('and it says why, and what to do instead', /cut ad sets, not the budget/.test(v4.notes.join(' ')), true);

/* One ad set, small budget: no floor talk, no consolidation warning. */
const small = camp({
  budget: 60, spend: 60, revenue: 50, adsetCount: 1,
  history: [d(60, 55), d(60, 52), d(60, 50)]
});
const v5 = VE.verdict(small, CTX);
check('a small single-ad-set campaign takes the full cut', v5.budgetTo, 36);
check('and gets no floor noise', /floor/.test(v5.notes.join(' ')), false);

/* ---------- 5. nothing above the descale path moved ------------------- */
const winner = camp({ spend: 100, revenue: 300, history: [d(100, 300), d(100, 290)] });
check('a profitable campaign still scales', VE.verdict(winner, CTX).code, 'SCALE');
const day1Loser = camp({ daysLive: 1, spend: 45, revenue: 20, history: [] });
check('a day-1 loser is still killed outright', VE.verdict(day1Loser, CTX).code, 'KILL');
const twiceDescaled = camp({
  spend: 100, revenue: 80, descaleCount: 2,
  history: [d(100, 70), d(100, 75), d(100, 80)]
});
check('two descales and still losing is still a kill', VE.verdict(twiceDescaled, CTX).code, 'KILL');

/* ---------- 6. thin history: the day stands alone -------------------- */
const brandNew = camp({ daysLive: 2, spend: 100, revenue: 80, history: [d(100, 80)] });
const v6 = VE.verdict(brandNew, CTX);
check('with only one closed day there is no window to appeal to', v6.code, 'DESCALE');
check('and it admits that', /Not enough closed history/.test(v6.reasons.join(' ')), true);

/* ---------- 7. the mirror: good day, bad week ------------------------- */
/* Yesterday 1.67 against BER 1.54 — profitable. But the two days before it
   were disasters, so the pooled window is 0.61. The budget must NOT be cut
   off a profitable day, but he has to be told. This is Lavouria, 5 Oct.   */
const goodDayBadWeek = camp({
  budget: 62, spend: 62, revenue: 62 * 1.67, adsetCount: 1,
  history: [d(62, 62 * 0.08), d(62, 62 * 0.08), d(62, 62 * 1.67)]
});
const v7 = VE.verdict(goodDayBadWeek, Object.assign({}, CTX, { ber: 1.54 }));
check('a profitable day is never cut on the strength of the window', v7.budgetTo, 62);
check('but the bad week is said out loud', /the day is green but the week is not/.test(v7.notes.join(' ')), true);
check('and it names the relaunch risk rather than implying recovery',
  /relaunch candidate, not a scale/.test(v7.notes.join(' ')), true);

/* A profitable day on a profitable week gets no such warning. */
const allGood = camp({ spend: 100, revenue: 300, history: [d(100, 280), d(100, 290), d(100, 300)] });
check('no false alarm when the week agrees with the day',
  /the week is not/.test(VE.verdict(allGood, CTX).notes.join(' ')), false);


  __report('lookback', pass, fail);
})();

/* ===== benchwindow ===================================================== */
(() => {
/* The benchmarks panel must read a FIXED window of closed days, never the
   partial day. This encodes the bug that shipped: on a half-finished day the
   same campaign reads as overpaying when it actually has room.             */
const VE = require('../rules.js');
let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`  FAIL ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
}
const day = (spend, revenue, purchases) => ({ spend, revenue, purchases });

/* AtemFrei, real shape. BER 1.58 ⇒ gross margin 63.3%.
   Seven closed days: €41.48 basket, €20.68 paid per order — healthy.
   The partial day so far: all the spend, only some of the orders.          */
const GM = 1 / 1.58;
const closed = Array.from({ length: 7 }, () => day(207, 415, 10));  // €41.50 basket, €20.70 CPA
const partial = day(150, 120, 3);                                   // midday: €50 CPA

const sevenClosed = VE.trailingRoas(closed, 7);
check('the window reads seven closed days', sevenClosed.days, 7);
check('and carries the orders through', sevenClosed.purchases, 70);

const healthy = VE.cpaPicture(sevenClosed, GM);
check('break-even CPA comes out of the window', healthy.maxCPA, 26.27);
check('real CPA over the window', healthy.cpa, 20.7);
check('so it reports room, not a loss', healthy.headroomPct > 0, true);

/* THE REGRESSION, as it actually shipped. The panel followed the date bar,
   and the date bar was on "today" — so it judged the partial day ALONE. */
const todayOnly = VE.cpaPicture(partial, GM);
check('the partial day on its own reads as a loss', todayOnly.cpa > todayOnly.maxCPA, true);
check('a steep one: €50 paid against a €25 line', [todayOnly.cpa, todayOnly.maxCPA], [50, 25.32]);
check('while the closed-day window called the same campaign healthy',
  healthy.cpa < healthy.maxCPA, true);

/* And the subtler half: a partial day mixed INTO the window does not flip the
   verdict, it just drags it. That is why the window excludes it rather than
   trusting it to average out. */
const withPartial = VE.cpaPicture(VE.trailingRoas(closed.concat([partial]), 7), GM);
check('a partial day inside the window drags the CPA up', withPartial.cpa > healthy.cpa, true);
check('but not far enough to flip it — which is what made this easy to miss',
  withPartial.cpa < withPartial.maxCPA, true);

/* A campaign with no orders in the window yields nothing to draw. */
const noSales = VE.trailingRoas([day(100, 0, 0), day(100, 0, 0)], 7);
check('spend without orders gives no basket size', noSales.purchases, 0);
check('and cpaPicture has no line to draw', VE.cpaPicture(noSales, GM).maxCPA, null);

/* Fewer than seven days of history still works — it reports what it had. */
const short = VE.trailingRoas(closed.slice(0, 3), 7);
check('a short history reports its real length', short.days, 3);


  __report('benchwindow', pass, fail);
})();

/* ===== noisewindow ===================================================== */
(() => {
/* Two guards on the descale window, both written from the week of 11 Oct 2026
   when a €3,000 budget went in by mistake and the engine answered by marking
   four profitable campaigns for a 40% cut.

   1. one runaway day cannot outvote the rest of the window
   2. a window sitting on the break-even line is not grounds for a 40% cut  */
const VE = require('../rules.js');
let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`  FAIL ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
}
const d = (s, r) => ({ spend: s, revenue: s * r, purchases: Math.max(1, Math.round(s * r / 35)) });
const ctx = ber => ({ window: 'midnight', currency: 'EUR', ber });
const camp = (ber, days, budget) => ({
  id: 'x', name: `P | ${ber} | 50`, status: 'ACTIVE', budget, daysLive: 30,
  spend: days[days.length - 1][0], revenue: days[days.length - 1][0] * days[days.length - 1][1],
  purchases: 10, frequency: 1.8, ctr: 3.5, cpm: 28, clicks: 300, lpv: 260, atc: 30, ic: 18,
  adsetCount: 1, descaleCount: 0, history: days.map(([s, r]) => d(s, r))
});

/* ---------- 1. THE RUNAWAY DAY ---------------------------------------- */
/* AtemFrei's real week: €2,558 on Sunday against €433 and €386. */
const w = VE.trailingRoas([d(2558, 1.05), d(433, 1.75), d(386, 1.09)], 3);
check('the runaway day is turned down', w.cappedDays, 1);
check('pooled with no cap it reads 1.14', +w.rawRoas.toFixed(2), 1.14);
check('capped it reads 1.24 — the quiet days get their say', +w.roas.toFixed(2), 1.24);
check('the raw spend is kept so a card can show both', Math.round(w.rawSpend), 3377);

/* A day merely BUSY, not runaway, is left alone. */
check('a 1.5x day is not an outlier and is not capped',
  VE.trailingRoas([d(200, 1.4), d(134, 2.0), d(111, 0.7)], 3).cappedDays, 0);

/* The cap uses the MEDIAN, so an outlier cannot raise its own ceiling. */
check('when two days are big, the big ones are the norm',
  VE.trailingRoas([d(3000, 1.0), d(3000, 1.0), d(100, 3.0)], 3).cappedDays, 0);

/* ---------- 2. THE DEAD ZONE ------------------------------------------ */
/* Celsior: window 1.54 against break-even 1.55. Six tenths of one percent. */
const onTheLine = VE.verdict(camp(1.55, [[200,1.45],[163,1.76],[158,1.42]], 200), ctx(1.55));
check('a campaign on the break-even line is held, not cut', onTheLine.code, 'HOLD');
check('its budget is untouched', onTheLine.budgetTo, 200);
check('and it says how short it actually was', /short by 0\.8%/.test(onTheLine.reasons.join(' ')), true);

check('5.9% under break-even is still a hold',
  VE.verdict(camp(1.36, [[146,1.06],[134,2.03],[111,0.67]], 155), ctx(1.36)).code, 'HOLD');

const realLoser = VE.verdict(camp(1.58, [[2558,1.05],[433,1.75],[386,1.09]], 400), ctx(1.58));
check('21% under break-even still descales', realLoser.code, 'DESCALE');
check('to 60% of the budget', realLoser.budgetTo, 240);

check('a campaign at half break-even is cut, not held',
  VE.verdict(camp(1.52, [[100,0.7],[100,0.6],[100,0.66]], 100), ctx(1.52)).code, 'DESCALE');

/* ---------- 3. nothing above the descale path moved ------------------- */
check('a profitable campaign still scales',
  VE.verdict(camp(1.67, [[484,1.54],[279,2.43],[248,2.55]], 250), ctx(1.67)).code, 'SCALE');


  __report('noisewindow', pass, fail);
})();

/* ===== creativeslide =================================================== */
(() => {
/* The sustained-CTR-slide route to "worn", written from 17 Oct 2026 when the
   engine called every campaign fresh while four of them had lost a third of
   their click-through over two clean weeks.

   Frequency was the only gate. On a rising budget Meta keeps finding NEW
   people, so frequency sits near 1.1 while the creative burns out across the
   market — DermaGleit was at frequency 1.03 with CTR down 34%.          */
const VE = require('../rules.js');
let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`  FAIL ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
}
/* Build a history from real daily CTR/CPM series. */
const hist = (ctrs, cpms, freq) => ctrs.map((ctr, i) => ({
  date: '2026-10-' + String(i + 1).padStart(2, '0'),
  spend: 200, revenue: 300, purchases: 8,
  ctr, cpm: cpms[i], frequency: freq
}));
const health = (ctrs, cpms, freq) =>
  VE.creativeHealth({ history: hist(ctrs, cpms, freq), frequency: freq, ctr: ctrs[ctrs.length-1], cpm: cpms[cpms.length-1], adStats: [] });

/* ---------- AtemFrei: the case that was invisible --------------------- */
const atem = health(
  [4.10,3.70,3.98,3.70,3.23,3.32,3.14,2.93,2.87,3.25,2.96,2.80,2.71,2.61],
  [21.2,20.0,21.2,24.0,24.5,22.6,22.0,22.1,25.7,28.5,29.9,27.7,30.3,28.9],
  1.58);
check('a sustained CTR slide is now worn, at frequency 1.58', atem.state, 'worn');
check('and the card says the market is tiring, not the same people',
  /market is tiring/.test(atem.detail), true);
check('the slide is reported with the share of days below baseline',
  /slide, with 100% of recent days below/.test(atem.signals.join(' ')), true);

/* ---------- LidLux: healthy, must stay fresh -------------------------- */
const lidlux = health(
  [3.97,4.07,4.15,3.88,3.84,3.66,3.97,3.90,3.87,3.77,4.21,3.77,3.41,3.80],
  [26.0,30.5,26.9,32.1,34.3,33.5,29.9,29.9,30.5,28.8,32.2,35.0,35.8,34.3],
  1.21);
check('a flat CTR line stays fresh', lidlux.state, 'fresh');

/* ---------- Serana: CTR RISING, must stay fresh ---------------------- */
const serana = health(
  [5.37,6.11,8.57,6.48,4.82,3.79,7.72,4.55,8.08,7.96,6.44,6.56],
  [66.9,56.9,50.6,46.3,39.9,46.2,57.6,50.8,66.1,58.9,52.7,71.4],
  1.12);
check('a rising CTR is never worn, however noisy', serana.state, 'fresh');

/* ---------- THE OLD REGRESSION: one scaled day must stay silent ------- */
const steady = Array(13).fill(4.0).concat([2.9]);
const flatCpm = Array(14).fill(25);
check('one odd day at the end does not convict', health(steady, flatCpm, 1.36).state, 'fresh');

/* ---------- a spike that recovered is not a slide -------------------- */
/* Drops hard mid-window then comes back: the share test rejects it. */
const recovered = [4.0,4.0,4.1,3.9,2.5,2.4,2.6,2.5,4.0,4.1,3.9,4.0,4.1,4.0];
check('a dip that recovered is not a sustained slide', health(recovered, flatCpm, 1.3).state, 'fresh');

/* ---------- too short a run cannot claim a trend --------------------- */
const short = [4.0,3.8,3.2,2.9,2.6,2.4,2.2];
check('seven days is not enough for the slide test',
  ['fresh','new'].includes(health(short, Array(7).fill(25), 1.2).state), true);

/* ---------- frequency still convicts on its own ---------------------- */
check('frequency past the fatigue line is still worn by itself',
  health(Array(14).fill(4.0), flatCpm, 2.7).state, 'worn');


  __report('creativeslide', pass, fail);
})();

/* ===== sundaypullback ================================================== */
(() => {
/* The Sunday pull-back must undo a surf, not punish a Sunday.

   On 18 Oct it told Velmira (€300, ROAS 1.70) and LidLux (€140, ROAS 1.44)
   to give up 40% of their budget. Neither had been touched all weekend. The
   rule fired on "profitable AND it is Sunday", which is not the same thing
   as "this was scaled up".                                              */
const VE = require('../rules.js');
let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`  FAIL ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
}
const d = (s, r) => ({ spend: s, revenue: s * r, purchases: Math.max(1, Math.round(s*r/35)) });
/* A real Sunday-midnight context. */
const SUN = ber => ({ window: 'midnight', currency: 'EUR', ber, isSunday: true, isSaturday: false });
const camp = (ber, days, budget) => ({
  id: 'x', name: `P | ${ber} | 50`, status: 'ACTIVE', budget, daysLive: 30,
  spend: days[days.length-1][0], revenue: days[days.length-1][0]*days[days.length-1][1],
  purchases: 12, frequency: 1.4, ctr: 3.5, cpm: 28, clicks: 300, lpv: 260, atc: 30, ic: 18,
  adsetCount: 1, descaleCount: 0, surfedRecently: false,
  history: days.map(([s,r]) => d(s,r))
});

/* ---------- Velmira: steady spend all week, profitable, NOT surfed ---- */
const flat = [[290,1.8],[300,1.9],[295,1.7],[305,1.8],[280,1.9],[300,1.7],[276,1.70]];
const velmira = VE.verdict(camp(1.67, flat, 300), SUN(1.67));
check('a profitable campaign that was never surfed is not pulled back',
  velmira.code === 'DESCALE' && /Sunday pull-back/.test(velmira.headline), false);
check('and its budget is not cut to 60%', velmira.budgetTo === 180, false);
check('the card explains why the Sunday rule did not apply',
  /nothing to pull back/.test(velmira.notes.join(' ')), true);

/* ---------- a campaign that WAS surfed still gets pulled back --------- */
const surfed = [[100,1.9],[105,1.8],[98,1.9],[102,1.8],[100,1.9],[500,1.9],[520,1.90]];
const after = VE.verdict(camp(1.40, surfed, 520), SUN(1.40));
check('a real weekend scale-up is still pulled back', after.code, 'DESCALE');
check('and the headline names it', /Sunday pull-back/.test(after.headline), true);

/* ---------- the action log alone is enough --------------------------- */
const logged = Object.assign(camp(1.40, flat, 300), { surfedRecently: true });
check('a logged surf is pulled back even without a spend jump',
  /Sunday pull-back/.test(VE.verdict(logged, SUN(1.40)).headline), true);

/* ---------- the spend test itself ------------------------------------ */
check('5x spend over the weekend reads as a scale-up',
  VE.weekendScaleUp(surfed.map(([s,r]) => d(s,r))), true);
check('steady spend does not', VE.weekendScaleUp(flat.map(([s,r]) => d(s,r))), false);
check('a merely busy weekend (1.3x) does not',
  VE.weekendScaleUp([[100,1.8],[100,1.8],[100,1.8],[100,1.8],[100,1.8],[130,1.8],[130,1.8]].map(([s,r]) => d(s,r))), false);
check('too little history cannot claim a scale-up',
  VE.weekendScaleUp([d(100,1.8), d(500,1.8)]), false);


  __report('sundaypullback', pass, fail);
})();

/* ===== accounttabs ===================================================== */
(() => {
/* Account tab bar — the registry, the active account, and the one thing that
   must never happen: a page that silently reads a different account than the
   tab you have selected.

   app.js is browser code, so the functions under test are lifted out of it by
   source extraction rather than require(). If a function is renamed or moved,
   this test fails loudly instead of passing against a stale copy. */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

/* ---------------------------------------------------------------- harness */
let store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};

const NEEDED = [
  'const LS = {',
  'const esc =',
  'const DEFAULT_ACCOUNTS',
  'const normAcc',
  'const shortLabel',
  'function accountRegistry',
  'function activeAccount',
  'function accountIds'
];
for (const marker of NEEDED) {
  if (!SRC.includes(marker)) {
    console.error(`FAIL: app.js no longer contains "${marker}" — this test is out of date with the code.`);
  __report('accounttabs', pass, fail);
  }
}

function slice(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker);
  const b = SRC.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error('could not slice ' + startMarker);
  return SRC.slice(a, b);
}

const code = [
  slice('const LS = {', 'const CURRENCY_SYMBOLS'),
  slice('const DEFAULT_ACCOUNTS', 'function renderAccountTabs')
].join('\n');

const ctx = new Function('localStorage', 'State', code + `
  return { accountRegistry, activeAccount, accountIds, setActiveAccount, normAcc, shortLabel, DEFAULT_ACCOUNTS };
`);

/* setActiveAccount touches the DOM and the network through renderAccountTabs,
   renderTokenStatus and loadData. Those are not what is under test, so they
   are stubbed; what matters is that the stored active account changes. */
const State = { range: 'something-stale' };
const api = ctx(localStorage, State);
global.renderAccountTabs = () => {};
global.renderTokenStatus = () => {};
global.loadData = () => {};
global.loadEconomics = () => {};

/* ------------------------------------------------------------------ runner */
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`FAIL: ${name}${detail ? '\n      ' + detail : ''}`);
}
const reset = () => { store = {}; };

/* ------------------------------------------------------------------- tests */

// 1. A clean install gets the three known accounts, in order.
reset();
let reg = api.accountRegistry();
ok('clean install seeds three accounts', reg.length === 3, `got ${reg.length}`);
ok('Chic-Shop is first', reg[0].label === 'Chic-Shop', reg[0].label);
ok('Main 1 and Main 2 follow',
  reg[1].label === 'Main 1' && reg[2].label === 'Main 2',
  reg.map(r => r.label).join(', '));

// 2. The account someone was already reading survives the upgrade. This is the
//    one that matters: an existing user must not silently switch accounts.
reset();
store.meta_account_ids = '9999888877776666';
reg = api.accountRegistry();
ok('an already-connected account is kept',
  reg.some(a => a.id === 'act_9999888877776666'));
ok('and it becomes the active one, not a default',
  api.activeAccount().id === 'act_9999888877776666',
  api.activeAccount().id);

// 3. An account already in the defaults is not duplicated.
reset();
store.meta_account_ids = 'act_1679754109728357';     // Main 1, with prefix
reg = api.accountRegistry();
ok('a known account is not duplicated', reg.length === 3, `got ${reg.length}`);
reset();
store.meta_account_ids = '1679754109728357';          // Main 1, no prefix
ok('nor when the prefix is missing', api.accountRegistry().length === 3);

// 4. accountIds() returns exactly one account — never a merged list.
reset();
ok('accountIds returns one id', api.accountIds().length === 1);
ok('and it is the active one', api.accountIds()[0] === api.activeAccount().id);
reset();
store.meta_account_ids = 'act_111, act_222 act_333';
ok('several stored ids still read one at a time',
  api.accountIds().length === 1, JSON.stringify(api.accountIds()));

// 5. Switching sticks, and survives a reload.
reset();
api.accountRegistry();
api.setActiveAccount('act_1563288332017037');
ok('switching changes the active account',
  api.activeAccount().label === 'Main 2', api.activeAccount().label);
ok('and accountIds follows it',
  api.accountIds()[0] === 'act_1563288332017037');
ok('a custom date range is dropped on switch', State.range === null, String(State.range));

// 6. A stored account that no longer exists must not blank the page.
reset();
api.accountRegistry();
store.cgo_active_account = 'act_deleted_long_ago';
ok('an unknown active account falls back to the first tab',
  api.activeAccount().label === 'Chic-Shop', api.activeAccount().label);

// 7. Corrupt storage must not throw.
reset();
store.cgo_accounts = '{not json at all';
let threw = false;
try { reg = api.accountRegistry(); } catch (e) { threw = true; }
ok('corrupt registry does not throw', !threw);
ok('corrupt registry rebuilds the defaults', !threw && reg.length === 3);
reset();
store.cgo_accounts = '[]';
ok('an empty registry rebuilds too', api.accountRegistry().length === 3);

// 8. Labels are always present, even for an account nobody named.
ok('an unnamed account still gets a readable label',
  api.shortLabel('act_1234567890123456') === 'Account 3456',
  api.shortLabel('act_1234567890123456'));
reset();
store.cgo_accounts = JSON.stringify([{ id: 'act_5555666677778888' }]);
ok('a registry entry with no label is filled in',
  api.accountRegistry()[0].label === 'Account 8888',
  api.accountRegistry()[0].label);

// 9. Ids are normalised on the way out, whatever was stored.
reset();
store.cgo_accounts = JSON.stringify([{ id: '4444333322221111', label: 'Bare' }]);
ok('a stored id without the act_ prefix is normalised',
  api.accountRegistry()[0].id === 'act_4444333322221111',
  api.accountRegistry()[0].id);

/* ------------------------------------------------------------------ result */

  __report('accounttabs', pass, fail);
})();

/* ===== accountscope ==================================================== */
(() => {
/* Per-account state — margins, break-even overrides and the action log must
   belong to ONE account.

   The failure this guards against is not a crash. It is a Main 1 campaign
   judged against Chic-Shop's margins: a verdict that is wrong and looks
   entirely reasonable. The upgrade path matters just as much — an existing
   user must open the dashboard and find their own numbers exactly where they
   left them. */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

let store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};

const NEEDED = ['const ACCOUNT_SCOPED', 'function acctKey', 'function migrateAccountState',
                'const acctJson', 'const acctSet'];
for (const m of NEEDED) {
  if (!SRC.includes(m)) {
    console.error(`FAIL: app.js no longer contains "${m}" — this test is out of date with the code.`);
  __report('accountscope', pass, fail);
  }
}

function slice(a, b) {
  const i = SRC.indexOf(a), j = SRC.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('could not slice ' + a);
  return SRC.slice(i, j);
}

const code = [
  slice('const LS = {', 'const CURRENCY_SYMBOLS'),
  slice('const DEFAULT_ACCOUNTS', 'function renderAccountTabs')
].join('\n');

const api = new Function('localStorage', code + `
  return { accountRegistry, activeAccount, acctKey, migrateAccountState,
           acctJson, acctSet, ACCOUNT_SCOPED };
`)(localStorage);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fail++; console.error(`FAIL: ${name}${detail ? '\n      ' + detail : ''}`);
};
const reset = () => { store = {}; };

const CHIC = 'act_2995536273958154';
const MAIN1 = 'act_1679754109728357';
const MAIN2 = 'act_1563288332017037';

/* 1. Keys are namespaced by account, so two accounts cannot collide. */
reset();
ok('keys carry the account id', api.acctKey('cgo_econ', MAIN1) === `cgo_econ::${MAIN1}`,
  api.acctKey('cgo_econ', MAIN1));
ok('two accounts get different keys',
  api.acctKey('cgo_econ', MAIN1) !== api.acctKey('cgo_econ', MAIN2));
ok('no id falls back to the active account',
  api.acctKey('cgo_econ') === `cgo_econ::${api.activeAccount().id}`);

/* 2. THE UPGRADE. Someone with margins and a BER override saved today must
      find them on their own tab tomorrow. */
reset();
store.meta_account_ids = CHIC;
store.cgo_econ = JSON.stringify({ price: 34.9, cogs: 8, shipping: 2, feePct: 3, refundRate: 5 });
store.cgo_ber_overrides = JSON.stringify({ 'c1': 1.72 });
store.cgo_action_log = JSON.stringify({ 'c1': ['scaled'] });
api.migrateAccountState();

ok('economics survive the upgrade',
  JSON.parse(store[`cgo_econ::${CHIC}`]).price === 34.9, store[`cgo_econ::${CHIC}`]);
ok('BER overrides survive the upgrade',
  JSON.parse(store[`cgo_ber_overrides::${CHIC}`]).c1 === 1.72);
ok('the action log survives the upgrade',
  !!store[`cgo_action_log::${CHIC}`]);
ok('the original global value is left alone, not moved',
  store.cgo_econ !== undefined);

/* 3. The migrated data lands on the account that owned it — and nowhere else. */
ok('a different account does not inherit those margins',
  store[`cgo_econ::${MAIN1}`] === undefined);
ok('nor those overrides', store[`cgo_ber_overrides::${MAIN1}`] === undefined);

/* 4. Migration runs once. A later edit must not be stamped back over. */
store[`cgo_econ::${CHIC}`] = JSON.stringify({ price: 99 });
api.migrateAccountState();
ok('re-running migration does not overwrite newer edits',
  JSON.parse(store[`cgo_econ::${CHIC}`]).price === 99,
  store[`cgo_econ::${CHIC}`]);

/* 5. Reads and writes follow whichever tab is active. */
reset();
api.accountRegistry();
store.cgo_active_account = CHIC;
api.acctSet('cgo_econ', JSON.stringify({ price: 29.95 }));
store.cgo_active_account = MAIN1;
api.acctSet('cgo_econ', JSON.stringify({ price: 14.5 }));

store.cgo_active_account = CHIC;
ok('Chic-Shop reads its own price',
  api.acctJson('cgo_econ', {}).price === 29.95, String(api.acctJson('cgo_econ', {}).price));
store.cgo_active_account = MAIN1;
ok('Main 1 reads its own price',
  api.acctJson('cgo_econ', {}).price === 14.5, String(api.acctJson('cgo_econ', {}).price));

/* 6. An account never configured falls back to the supplied default rather
      than to another account's numbers. */
store.cgo_active_account = MAIN2;
ok('an unconfigured account uses the default, not a neighbour\'s',
  api.acctJson('cgo_econ', { price: 29.95 }).price === 29.95,
  String(api.acctJson('cgo_econ', { price: 29.95 }).price));

/* 7. A BER override set on one account must not reach another. This is the
      one that would quietly produce a wrong verdict. */
reset();
api.accountRegistry();
store.cgo_active_account = CHIC;
api.acctSet('cgo_ber_overrides', JSON.stringify({ 'shared-id': 1.55 }));
store.cgo_active_account = MAIN1;
ok('a BER override does not leak to another account',
  api.acctJson('cgo_ber_overrides', {})['shared-id'] === undefined,
  String(api.acctJson('cgo_ber_overrides', {})['shared-id']));

/* 8. Same for the applied-action log — a scale logged in one account must not
      make another account look like it was already acted on. */
store.cgo_active_account = CHIC;
api.acctSet('cgo_action_log', JSON.stringify({ 'c9': 'descaled 18 Oct' }));
store.cgo_active_account = MAIN2;
ok('the action log does not leak either',
  api.acctJson('cgo_action_log', {})['c9'] === undefined);

/* 9. Every key the app scopes is actually covered by the migration. */
reset();
store.meta_account_ids = CHIC;
api.ACCOUNT_SCOPED.forEach(k => { store[k] = '{"seeded":true}'; });
api.migrateAccountState();
api.ACCOUNT_SCOPED.forEach(k =>
  ok(`${k} is migrated`, store[`${k}::${CHIC}`] === '{"seeded":true}'));

/* 10. Nothing to migrate must not throw or leave junk behind. */
reset();
let threw = false;
try { api.migrateAccountState(); } catch (e) { threw = true; }
ok('a clean install migrates without throwing', !threw);
ok('and writes no empty scoped keys',
  !Object.keys(store).some(k => k.includes('::') && !store[k]),
  JSON.stringify(store));


  __report('accountscope', pass, fail);
})();

/* ----------------------------------------------------------------- summary */
let tp = 0, tf = 0;
for (const r of __results) {
  tp += r.pass; tf += r.fail;
  const state = r.bailed ? 'OUT OF DATE WITH THE CODE' : (r.fail ? `${r.fail} FAILED` : 'ok');
  console.log(`  ${r.name.padEnd(16)} ${String(r.pass).padStart(3)} passed   ${state}`);
}
console.log(`\n${tp} passed, ${tf} failed across ${__results.length} suites`);
process.exit(tf ? 1 : 0);
