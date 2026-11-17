/* ============================================================================
 *  CGO calendar — the dates that move ad costs, demand and delivery promises.
 *
 *  Pure functions, no DOM. Every date is COMPUTED by rule for whatever year is
 *  asked for (Easter, Black Friday, Advent ...), never typed in by hand, so the
 *  list stays right next year too. Each event says how sure it is:
 *     fixed    — same calendar date every year (14 Feb, 6 Dec ...)
 *     computed — a rule gives the exact date (Easter, 2nd Sunday of May ...)
 *     typical  — a usual pattern with no exact date (CPM build-up, January dip)
 *  Market: Germany / Austria / Switzerland (the DACH shops).
 * ========================================================================== */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------ date maths -- */
  // Everything is a UTC midnight Date so a laptop in Cairo and a server in
  // Berlin always agree on what day it is.
  const mk = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
  const iso = (dt) => dt.toISOString().slice(0, 10);
  const add = (dt, n) => new Date(dt.getTime() + n * 86400000);
  const parse = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return mk(y, m, d); };
  const diffDays = (a, b) => Math.round((parse(a) - parse(b)) / 86400000);   // a − b in whole days

  /** nth weekday of a month. wd: 0 = Sunday … 6 = Saturday. n = 1…5. */
  function nthWeekday(y, m, wd, n) {
    const first = mk(y, m, 1);
    const shift = (wd - first.getUTCDay() + 7) % 7;
    return add(first, shift + (n - 1) * 7);
  }

  /** Easter Sunday — the Gregorian "anonymous" algorithm. */
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return mk(y, month, day);
  }

  /** US Thanksgiving (4th Thursday of November) — the anchor for Black Friday. */
  const thanksgiving = (y) => nthWeekday(y, 11, 4, 4);
  const blackFriday = (y) => add(thanksgiving(y), 1);

  /** 4th Advent = the Sunday on or before 24 December; the others are 7 days apart. */
  function fourthAdvent(y) {
    const xmas = mk(y, 12, 24);
    return add(xmas, -xmas.getUTCDay());
  }
  const firstAdvent = (y) => add(fourthAdvent(y), -21);

  /* --------------------------------------------------- shipping promise -- */
  /** Your parcels leave 1–2 days after the order and take up to ~15 days. */
  const SHIPPING_DEFAULT = { handling: 2, transitWorst: 15, buffer: 3 };

  /** Last day an order can be placed and still be promised for `eventISO`. */
  function promiseBy(eventISO, ship) {
    const s = Object.assign({}, SHIPPING_DEFAULT, ship || {});
    const days = (+s.handling || 0) + (+s.transitWorst || 0) + (+s.buffer || 0);
    return { date: iso(add(parse(eventISO), -days)), days };
  }

  /* --------------------------------------------------------- task lists -- */
  /*  offset = days from the event's start (negative = before). from: 'end' counts
   *  from the last day instead. area drives the colour of the little tag.     */
  const T = (id, offset, title, detail, area, from) => ({ id, offset, title, detail, area, from: from || 'start' });

  const TASKS = {
    sale: [
      T('offer',   -14, 'Decide the offer — real discount, real end date',
        'Write down the exact price, the discount and when it ends. In Germany a crossed-out price must be the lowest price of the last 30 days and a countdown must be real. Not legal advice — check with your lawyer.', 'legal'),
      T('hooks',   -12, 'Brief 3 new hooks (first 3 seconds)',
        'Same story, new opening. A different first 3 seconds also stops Meta treating your ads as copies of a competitor’s.', 'creative'),
      T('upload',  -10, 'Upload the seasonal ads in a NEW campaign',
        'Do not edit running ads — editing resets learning. Ad approval is often slower in busy weeks, so submit early.', 'ads'),
      T('copy',     -7, 'Check video text and ad copy',
        'Only claim what is true: the real discount, the real deadline. No health promises. Headline carries the offer, the story stays the same.', 'creative'),
      T('bar',      -5, 'Funnel bar live, with the real end date',
        'Banner on the page and checkout. Test the whole path on your phone: ad → page → checkout → thank-you.', 'funnel'),
      T('ship',     -3, 'Check delivery promises on page and in ads',
        'Say "5–12 Werktage", never a date you cannot keep. Late parcels cost refunds under your own chart.', 'shipping'),
      T('budget',   -1, 'Budget plan for the first day',
        'CPM is higher for everyone — judge by orders and ROAS against break-even, not by CPM. Keep the day-1 rule: €40 spent and no order → pause.', 'budget'),
      T('check',     0, 'First check at 11:00', 'Spend vs budget, orders so far, any ad rejected?', 'ads'),
      T('remove',    1, 'Take the bar and seasonal text down',
        'Remove the funnel bar, switch off seasonal-only ads, write down what won.', 'funnel', 'end'),
      T('review',    2, 'Review: which ad, which hook, what CPM did you pay?',
        'Put the winner into your normal campaigns. CPM usually falls back after the peak.', 'ads', 'end')
    ],
    gift: [
      T('promise', -28, 'Set your "order by" date for delivery',
        'Work it out from the shipping settings on this page. After that date stop promising delivery for the occasion.', 'shipping'),
      T('hooks',   -21, 'Brief gift-angle creatives',
        'Same product, a gift story in the first 3 seconds. Keep the claims you already use.', 'creative'),
      T('upload',  -14, 'Upload gift ads in a NEW campaign', 'Do not edit running ads.', 'ads'),
      T('bar',      -7, 'Funnel bar with the order-by date',
        'Show the real last-order date. Remove the bar the day after.', 'funnel'),
      T('stop',      0, 'Last day to promise delivery', 'From the order-by date onward, take down every "arrives in time" claim.', 'shipping', 'promise'),
      T('remove',    1, 'Take the gift text and bar down', 'Back to normal copy.', 'funnel', 'end')
    ],
    holiday: [
      T('support',  -3, 'Plan support cover',
        'Your reply rule is within 24 h (max 48 h). Check someone answers on the holiday.', 'support'),
      T('budget',   -1, 'Check weekend-style budgets',
        'Long weekends can behave like a Sunday: do not change budgets on one day’s numbers.', 'budget')
    ],
    season: [
      T('start',     0, 'Check CPM against your normal',
        'Open Campaigns and compare today’s CPM with your last 14 days. If it is up and orders are steady, do nothing.', 'ads'),
      T('creative',  7, 'Make sure fresh ads are ready',
        'Costs rise before the big dates. Have 2–3 new first-3-seconds ready.', 'creative')
    ],
    dip: [
      T('test',      0, 'Cheap-CPM window: start your next test',
        'After big peaks CPM often falls. A good time to test new hooks at the normal €100 budget.', 'ads')
    ],
    occasion: [
      T('copy',     -5, 'Optional: add the occasion to one ad',
        'Only if it fits the product. Skip it if it feels forced.', 'creative')
    ],
    custom: []
  };

  /* ------------------------------------------------------------- events -- */
  /*  rule(y) → start Date; end(y) → end Date (optional).                      */
  const E = (id, name, de, kind, rule, o) => Object.assign({ id, name, de, kind, rule }, o || {});

  const EVENTS = [
    E('newyear', 'New Year’s Day', 'Neujahr', 'holiday', y => mk(y, 1, 1), { conf: 'fixed', tasks: 'holiday' }),
    E('epiphany', 'Epiphany', 'Heilige Drei Könige', 'holiday', y => mk(y, 1, 6), { conf: 'fixed', tasks: 'holiday', note: 'Public holiday in Austria, Baden-Württemberg and Bavaria.' }),
    E('resolutions', 'New-Year resolutions month', 'Gute Vorsätze', 'season', y => mk(y, 1, 1), {
      end: y => mk(y, 1, 31), conf: 'typical', cpm: 'dip', tasks: 'dip',
      note: 'People search for health, fitness and self-care in January, and ad costs are usually lower than in December.' }),
    E('afterxmas', 'After-Christmas dip', 'Nach Weihnachten', 'season', y => mk(y, 12, 26), {
      end: y => mk(y + 1, 1, 10), conf: 'typical', cpm: 'dip', tasks: 'dip',
      note: 'CPM usually falls once Christmas is over. Typical pattern, not a promise — check your own numbers.' }),
    E('valentine', 'Valentine’s Day', 'Valentinstag', 'gift', y => mk(y, 2, 14), { conf: 'fixed', cpm: 'up', lead: 7, tasks: 'gift',
      note: 'A gift date. Costs rise a little for beauty and gift products in the week before.' }),
    E('womensday', 'International Women’s Day', 'Weltfrauentag', 'occasion', y => mk(y, 3, 8), { conf: 'fixed', tasks: 'occasion' }),
    E('worldhealth', 'World Health Day', 'Weltgesundheitstag', 'occasion', y => mk(y, 4, 7), { conf: 'fixed', tasks: 'occasion', note: 'A health awareness day. Use it only if it fits the product.' }),
    E('goodfriday', 'Good Friday', 'Karfreitag', 'holiday', y => add(easter(y), -2), { conf: 'computed', tasks: 'holiday', note: 'Public holiday in DE, AT and most of CH — a long weekend.' }),
    E('easter', 'Easter Sunday', 'Ostersonntag', 'holiday', y => easter(y), { conf: 'computed', tasks: 'holiday' }),
    E('eastermon', 'Easter Monday', 'Ostermontag', 'holiday', y => add(easter(y), 1), { conf: 'computed', tasks: 'holiday' }),
    E('labour', 'Labour Day', 'Tag der Arbeit', 'holiday', y => mk(y, 5, 1), { conf: 'fixed', tasks: 'holiday', note: 'Public holiday in DE and AT, in parts of CH.' }),
    E('mothers', 'Mother’s Day', 'Muttertag', 'gift', y => nthWeekday(y, 5, 0, 2), { conf: 'computed', cpm: 'up', lead: 7, tasks: 'gift',
      note: '2nd Sunday of May. A strong gift date for beauty and wellness products.' }),
    E('ascension', 'Ascension Day / Father’s Day', 'Christi Himmelfahrt / Vatertag', 'holiday', y => add(easter(y), 39), { conf: 'computed', tasks: 'holiday', note: 'Thursday, 39 days after Easter. Many people take a bridge day.' }),
    E('corpus', 'Corpus Christi', 'Fronleichnam', 'holiday', y => add(easter(y), 60), { conf: 'computed', tasks: 'holiday', note: 'Thursday, 60 days after Easter. Public holiday in parts of Germany, in Austria and in some Swiss cantons.' }),
    E('pentecost', 'Whit Sunday', 'Pfingstsonntag', 'holiday', y => add(easter(y), 49), { conf: 'computed', tasks: 'holiday' }),
    E('whitmon', 'Whit Monday', 'Pfingstmontag', 'holiday', y => add(easter(y), 50), { conf: 'computed', tasks: 'holiday' }),
    E('summer', 'Summer: the cheaper, quieter months', 'Sommer', 'season', y => mk(y, 6, 1), {
      end: y => mk(y, 8, 31), conf: 'typical', cpm: 'dip', tasks: 'dip',
      note: 'Many people are on holiday and the third quarter is usually the cheapest time for ads. A good window for tests. Typical pattern — check your own numbers.' }),
    E('swissday', 'Swiss National Day', 'Bundesfeier', 'holiday', y => mk(y, 8, 1), { conf: 'fixed', tasks: 'holiday', note: 'National day in Switzerland.' }),
    E('assumption', 'Assumption Day', 'Mariä Himmelfahrt', 'holiday', y => mk(y, 8, 15), { conf: 'fixed', tasks: 'holiday', note: 'Public holiday in Austria and in parts of Germany and Switzerland.' }),
    E('autumn', 'Autumn restart: back to routines', 'Herbststart', 'season', y => mk(y, 9, 1), {
      end: y => mk(y, 9, 30), conf: 'typical', tasks: 'season',
      note: 'People return to work and routines, and ad costs begin to climb toward the holidays. Typical pattern — check your own numbers.' }),
    E('unity', 'Day of German Unity', 'Tag der Deutschen Einheit', 'holiday', y => mk(y, 10, 3), { conf: 'fixed', tasks: 'holiday', note: 'Public holiday in Germany.' }),
    E('austriaday', 'Austrian National Day', 'Nationalfeiertag', 'holiday', y => mk(y, 10, 26), { conf: 'fixed', tasks: 'holiday', note: 'Public holiday in Austria.' }),
    E('allsaints', 'All Saints’ Day', 'Allerheiligen', 'holiday', y => mk(y, 11, 1), { conf: 'fixed', tasks: 'holiday', note: 'Public holiday in Austria and in parts of Germany and Switzerland.' }),
    E('q4build', 'Q4 build-up: ad costs start to climb', 'Q4-Anstieg', 'season', y => mk(y, 10, 15), {
      end: y => add(blackFriday(y), -5), conf: 'typical', cpm: 'up', tasks: 'season',
      note: 'Advertisers add budget for the holidays, so CPM often drifts up from mid-October. A typical pattern — compare with your own 14 days.' }),
    E('singles', 'Singles’ Day', 'Singles’ Day', 'occasion', y => mk(y, 11, 11), { conf: 'fixed', cpm: 'up', lead: 3, tasks: 'occasion', note: 'Online shoppers start looking for deals.' }),
    E('blackweek', 'Black Week (to Cyber Monday)', 'Black Week', 'sale', y => add(blackFriday(y), -4), {
      end: y => add(blackFriday(y), 3), conf: 'computed', cpm: 'high', tasks: 'sale',
      note: 'This calendar counts the Monday before Black Friday through Cyber Monday. Big retailers often start earlier, so costs can rise sooner. The most expensive days of the year for ads — CPM is higher for everyone.' }),
    E('blackfriday', 'Black Friday', 'Black Friday', 'sale', y => blackFriday(y), { conf: 'computed', cpm: 'high', tasks: null,
      note: 'The day after US Thanksgiving (4th Thursday of November).' }),
    E('cybermonday', 'Cyber Monday', 'Cyber Monday', 'sale', y => add(blackFriday(y), 3), { conf: 'computed', cpm: 'high', tasks: null }),
    E('advent1', '1st Advent — Christmas season starts', '1. Advent', 'season', y => firstAdvent(y), {
      end: y => mk(y, 12, 20), conf: 'computed', cpm: 'high', tasks: 'season',
      note: 'Christmas shopping runs now. CPM usually stays high until about 20 December.' }),
    E('immaculate', 'Immaculate Conception', 'Mariä Empfängnis', 'holiday', y => mk(y, 12, 8), { conf: 'fixed', tasks: 'holiday', note: 'Public holiday in Austria.' }),
    E('nikolaus', 'St. Nicholas Day', 'Nikolaustag', 'gift', y => mk(y, 12, 6), { conf: 'fixed', cpm: 'up', lead: 5, tasks: 'gift' }),
    E('christmas', 'Christmas Eve', 'Heiligabend', 'gift', y => mk(y, 12, 24), { conf: 'fixed', cpm: 'high', tasks: 'gift',
      note: 'The big gift date. Your parcels need up to about 3 weeks — see the order-by date.' }),
    E('xmas1', 'Christmas Day', '1. Weihnachtstag', 'holiday', y => mk(y, 12, 25), { conf: 'fixed', tasks: 'holiday' }),
    E('xmas2', 'St. Stephen’s Day', '2. Weihnachtstag', 'holiday', y => mk(y, 12, 26), { conf: 'fixed', tasks: 'holiday' }),
    E('nye', 'New Year’s Eve', 'Silvester', 'holiday', y => mk(y, 12, 31), { conf: 'fixed', tasks: 'holiday' })
  ];

  const KIND_LABEL = { sale: 'Sale', gift: 'Gift date', holiday: 'Holiday', season: 'Season', occasion: 'Occasion', custom: 'My date' };
  const CPM_LABEL = {
    high: 'CPM usually high', up: 'CPM may rise', dip: 'CPM often lower'
  };

  /* ------------------------------------------------------------- build -- */
  function eventForYear(def, y) {
    const start = def.rule(y);
    const end = def.end ? def.end(y) : start;
    return { def, start, end };
  }

  /** Resolve the due date of one task. */
  function dueDate(task, ev, ship) {
    if (task.from === 'promise') {
      const p = promiseBy(iso(ev.start), ship).date;
      return p;
    }
    const anchor = task.from === 'end' ? ev.end : ev.start;
    return iso(add(anchor, task.offset));
  }

  /**
   * All events from `fromISO` for `months` months, in date order, with tasks.
   * opts: { ship, custom: [{id,name,date,end,kind,note}], includePast, done: {key:true} }
   */
  function build(fromISO, months, opts) {
    const o = opts || {};
    const from = parse(fromISO);
    const until = add(mk(from.getUTCFullYear(), from.getUTCMonth() + 1 + (months || 12), from.getUTCDate()), 0);
    const out = [];
    const startYear = from.getUTCFullYear() - 1, endYear = until.getUTCFullYear() + 1;

    for (let y = startYear; y <= endYear; y++) {
      EVENTS.forEach(def => {
        const e = eventForYear(def, y);
        // keep the event if any part of it overlaps the window
        if (e.end < from && !o.includePast) return;
        if (e.start > until) return;
        out.push(shape(def, e, y, o));
      });
    }
    (o.custom || []).forEach(c => {
      const start = parse(c.date), end = c.end ? parse(c.end) : start;
      if (end < from && !o.includePast) return;
      if (start > until) return;
      const def = { id: c.id, name: c.name, de: '', kind: 'custom', conf: 'fixed', note: c.note || '', tasks: 'custom', custom: true, as: c.kind || 'sale', cpm: c.cpm || null };
      out.push(shape(def, { def, start, end }, start.getUTCFullYear(), o));
    });
    out.sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
    return out;
  }

  function shape(def, e, y, o) {
    const start = iso(e.start), end = iso(e.end);
    const templ = def.custom ? (TASKS[def.as] || TASKS.sale) : (def.tasks ? TASKS[def.tasks] : []);
    const ev = { id: def.id, key: `${y}:${def.id}`, year: y, name: def.name, de: def.de, kind: def.custom ? (def.as || 'custom') : def.kind,
      isCustom: !!def.custom, start, end, days: diffDays(end, start) + 1, conf: def.conf, cpm: def.cpm || null, note: def.note || '',
      cpmFrom: iso(add(e.start, -(def.lead || 0))) };
    if (ev.kind === 'gift') ev.promiseBy = promiseBy(start, o.ship);
    ev.tasks = (templ || []).map(t => {
      const due = dueDate(t, { start: e.start, end: e.end }, o.ship);
      const key = `${ev.key}:${t.id}`;
      return { key, id: t.id, title: t.title, detail: t.detail, area: t.area, due, done: !!(o.done && o.done[key]) };
    }).sort((a, b) => a.due.localeCompare(b.due));
    return ev;
  }

  /* ------------------------------------------------------------ queries -- */
  /** Days from today to the event start (negative once started). */
  const daysUntil = (ev, todayISO) => diffDays(ev.start, todayISO);
  /** true while today sits inside the event window. */
  const isActive = (ev, todayISO) => ev.start <= todayISO && todayISO <= ev.end;

  /** Tasks that matter now: overdue, due today or due within `ahead` days. Skips ticked ones and events already over. */
  function dueTasks(events, todayISO, ahead) {
    const a = ahead == null ? 7 : ahead, out = [];
    events.forEach(ev => {
      if (ev.end < todayISO) return;                       // the event is over — its tasks no longer matter
      ev.tasks.forEach(t => {
        if (t.done) return;
        const d = diffDays(t.due, todayISO);
        if (d <= a) out.push({ event: ev, task: t, days: d, overdue: d < 0 });
      });
    });
    out.sort((x, y) => x.days - y.days);
    return out;
  }

  /** The next event worth a countdown: an active one first, else the nearest with real tasks or a CPM note. */
  function nextBig(events, todayISO) {
    const worth = events.filter(e => e.end >= todayISO && (e.kind === 'sale' || e.kind === 'gift' || e.cpm === 'high'));
    const active = worth.find(e => isActive(e, todayISO));
    return active || worth.find(e => e.start >= todayISO) || null;
  }

  /** Events that raise or lower CPM right now (a gift date counts from a few days before it). */
  const activeCpm = (events, todayISO) => events.filter(e => e.cpm && e.cpmFrom <= todayISO && todayISO <= e.end);

  /* ------------------------------------------------- starter texts ------ */
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dateDE = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;
  const dateEN = (d) => `${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]}`;
  const STARTER_NOTE = 'Starting points, not final copy. Put in your real offer, keep every date true, and have a German speaker read the German once before it goes live.';

  /**
   * German + English starting texts for a sale or gift date: funnel bar, first
   * 3 seconds of the video, ad headline, ad primary text. Only true things go
   * in: the real end date (sale) or the real order-by date (gift). No health
   * claims. `discount` is what the owner typed ("20%"); empty gives a visible
   * placeholder so nothing goes live by accident.
   */
  function starters(ev, opts) {
    if (!ev || (ev.kind !== 'sale' && ev.kind !== 'gift')) return [];
    const disc = ((opts && opts.discount) || '').trim() || '[X%]';
    const name = String(ev.name || '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
    const de = String(ev.de || '').trim() || name;
    if (ev.kind === 'sale') {
      const eD = dateDE(ev.end), eE = dateEN(ev.end);
      return [
        { id: 'bar', label: 'Funnel bar', where: 'Page and checkout banner',
          de: `${de}: ${disc} Rabatt – nur bis ${eD}`, en: `${name}: ${disc} off – only until ${eE}` },
        { id: 'video', label: 'Video text', where: 'First 3 seconds',
          de: `Nur bis ${eD}: ${disc} Rabatt`, en: `Only until ${eE}: ${disc} off` },
        { id: 'headline', label: 'Ad headline', where: 'Meta headline',
          de: `${disc} Rabatt bis ${eD}`, en: `${disc} off until ${eE}` },
        { id: 'primary', label: 'Ad primary text', where: 'Meta primary text',
          de: `${ev.isCustom ? 'Unsere Aktion' : 'Die ' + de.replace(/\s+/g, '-') + '-Aktion'} endet am ${eD} – sichere dir jetzt den reduzierten Preis.`,
          en: `${ev.isCustom ? 'Our offer' : 'The ' + name + ' offer'} ends on ${eE} – get the reduced price now.` }
      ];
    }
    if (!ev.promiseBy) return [];
    const bD = dateDE(ev.promiseBy.date), bE = dateEN(ev.promiseBy.date);
    return [
      { id: 'bar', label: 'Funnel bar', where: 'Page and checkout banner',
        de: `${de}: Bestellung bis ${bD} – dein Geschenk kommt rechtzeitig an`, en: `${name}: order by ${bE} – your gift arrives in time` },
      { id: 'video', label: 'Video text', where: 'First 3 seconds',
        de: `Als Geschenk: bestelle bis ${bD}`, en: `As a gift: order by ${bE}` },
      { id: 'headline', label: 'Ad headline', where: 'Meta headline',
        de: `Geschenkidee – bestelle bis ${bD}`, en: `Gift idea – order by ${bE}` },
      { id: 'primary', label: 'Ad primary text', where: 'Meta primary text',
        de: `Du suchst ein Geschenk für ${de}? Bestelle bis ${bD}, damit es rechtzeitig ankommt.`,
        en: `Looking for a gift for ${name}? Order by ${bE} so it arrives in time.` }
    ];
  }

  const api = {
    easter, thanksgiving, blackFriday, firstAdvent, fourthAdvent, nthWeekday,
    promiseBy, SHIPPING_DEFAULT, starters, STARTER_NOTE, dateDE, dateEN, build, daysUntil, isActive, dueTasks, nextBig, activeCpm,
    EVENTS, TASKS, KIND_LABEL, CPM_LABEL, iso, parse, add, diffDays, mk
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CgoCalendar = api;
})(typeof window !== 'undefined' ? window : globalThis);
