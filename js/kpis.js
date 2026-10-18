/*
 * kpis.js — every data-cleaning rule and KPI formula lives in this one module.
 *
 * Source of truth: README_data_dictionary.md ("KPI definitions").
 * Chart code never computes a business metric; it calls a function here.
 * All functions are pure: rows in, numbers out, so every figure traces
 * back to source rows.
 */
(function (root) {
  // ---------------------------------------------------------------------------
  // 1. Cleaning
  // ---------------------------------------------------------------------------

  // 0/1 flags: blank means 0 (README: "Flags (0/1)").
  const FLAG_COLS = [
    "salaried_day_flag", "worked_flag", "requested_flag", "filled_flag", "hospital_canceled_flag",
  ];

  // Numerics: blank means null (unknown / not applicable), never zero.
  const NUM_COLS = [
    "vet_program_days", "request_lead_time_days", "shift_hours", "vet_rating_of_hospital",
    "bill_rate", "premium_billed", "cancellation_fee", "revenue", "vet_salary_cost", "premium_pay",
    "extra_shift_pay", "benefits_cost", "total_direct_cost", "gross_margin",
    "budget_revenue", "budget_worked_days", "budget_gross_margin", "budget_utilization_pct",
    "budget_fill_rate_pct", "budget_active_vets", "budget_new_hospitals", "recruiting_cost",
  ];

  // Dates kept as ISO "YYYY-MM-DD" strings (sortable, timezone-safe); blank -> null.
  const DATE_COLS = [
    "record_date", "vet_hire_date", "vet_termination_date", "hospital_onboard_date", "screen_date",
    "interview_date", "offer_date", "agreement_date", "first_shift_date",
  ];

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

  function cleanRow(raw) {
    const r = {};
    for (const k in raw) {
      const key = k.trim();
      const v = raw[k] == null ? "" : String(raw[k]).trim();
      r[key] = v === "" ? null : v;
    }
    for (const c of FLAG_COLS) r[c] = r[c] == null ? 0 : Number(r[c]) === 1 ? 1 : 0;
    for (const c of NUM_COLS) {
      if (r[c] == null) continue;
      const n = Number(r[c]);
      r[c] = Number.isFinite(n) ? n : null;
    }
    for (const c of DATE_COLS) {
      if (r[c] == null) continue;
      r[c] = ISO_DATE.test(r[c]) ? r[c].slice(0, 10) : null;
    }
    if (r.record_type) r.record_type = r.record_type.toUpperCase();
    // Derived helpers (not KPIs): ISO week start (Monday), lead-time bucket for requested shifts.
    if (r.record_date) r.week_start = weekStart(r.record_date);
    r.lead_bucket = r.requested_flag === 1 ? leadBucket(r.request_lead_time_days) : null;
    return r;
  }

  function weekStart(iso) {
    const d = new Date(iso + "T00:00:00Z");
    const dow = (d.getUTCDay() + 6) % 7; // Mon=0
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  }

  /** Append any number of parsed files, de-duplicate on record_id (last file wins). */
  function combine(fileRowArrays) {
    const byId = new Map();
    let dupes = 0;
    for (const rows of fileRowArrays) {
      for (const raw of rows) {
        const r = cleanRow(raw);
        if (!r.record_id || !r.record_type) continue;
        if (byId.has(r.record_id)) dupes++;
        byId.set(r.record_id, r);
      }
    }
    return { rows: [...byId.values()], duplicatesRemoved: dupes };
  }

  // ---------------------------------------------------------------------------
  // 2. Small helpers
  // ---------------------------------------------------------------------------
  const ofType = (rows, t) => rows.filter((r) => r.record_type === t);
  const sum = (rows, col) => rows.reduce((a, r) => a + (r[col] || 0), 0);
  const count = (rows, pred) => rows.reduce((a, r) => a + (pred(r) ? 1 : 0), 0);
  const div = (n, d) => (d ? n / d : null);
  const median = (xs) => {
    const s = xs.filter((x) => x != null).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  function groupBy(rows, keyFn) {
    const m = new Map();
    for (const r of rows) {
      const k = typeof keyFn === "function" ? keyFn(r) : r[keyFn];
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  }

  // ---------------------------------------------------------------------------
  // 3. SCHEDULE KPIs (pass SCHEDULE rows, already filtered to the period/slice)
  // ---------------------------------------------------------------------------

  /** Revenue = sum(revenue) */
  const revenue = (s) => sum(s, "revenue");

  /** Gross margin $ = sum(gross_margin) */
  const grossMargin = (s) => sum(s, "gross_margin");

  /** Gross margin % = sum(gross_margin) / sum(revenue) */
  const grossMarginPct = (s) => div(sum(s, "gross_margin"), sum(s, "revenue"));

  /**
   * Utilization = count(worked_flag=1 AND salaried_day_flag=1)
   *             / (sum(salaried_day_flag) - count(shift_status='PTO'))
   */
  const utilization = (s) =>
    div(
      count(s, (r) => r.worked_flag === 1 && r.salaried_day_flag === 1),
      sum(s, "salaried_day_flag") - count(s, (r) => r.shift_status === "PTO")
    );

  /** Fill rate = sum(filled_flag) / (sum(requested_flag) - sum(hospital_canceled_flag)) */
  const fillRate = (s) =>
    div(sum(s, "filled_flag"), sum(s, "requested_flag") - sum(s, "hospital_canceled_flag"));

  /** Unfilled demand $ = sum(bill_rate + premium_billed) where shift_status='Unfilled Request' */
  const unfilledDemand = (s) =>
    s.filter((r) => r.shift_status === "Unfilled Request")
      .reduce((a, r) => a + (r.bill_rate || 0) + (r.premium_billed || 0), 0);

  /** Paid idle cost $ = sum(total_direct_cost) where shift_status='Unbooked (Paid Idle)' */
  const paidIdleCost = (s) =>
    sum(s.filter((r) => r.shift_status === "Unbooked (Paid Idle)"), "total_direct_cost");

  /**
   * Hospital cancellation rate = sum(hospital_canceled_flag)
   *   / count(rows where a vet was booked: Worked, Canceled by Hospital, Sick Callout)
   */
  const BOOKED = new Set(["Worked", "Canceled by Hospital", "Sick Callout"]);
  const cancellationRate = (s) =>
    div(sum(s, "hospital_canceled_flag"), count(s, (r) => BOOKED.has(r.shift_status)));

  /** Revenue per worked day = sum(revenue) / sum(worked_flag) */
  const revenuePerWorkedDay = (s) => div(sum(s, "revenue"), sum(s, "worked_flag"));

  /** Worked days = sum(worked_flag) (used for budget comparison) */
  const workedDays = (s) => sum(s, "worked_flag");

  /** Active vets = distinct vet_id with salaried_day_flag = 1 in the period */
  const activeVets = (s) => new Set(s.filter((r) => r.salaried_day_flag === 1).map((r) => r.vet_id)).size;

  /** Customer concentration = revenue by corporate_group / total revenue (sorted desc) */
  function concentration(s) {
    const total = revenue(s);
    return [...groupBy(s, "corporate_group")]
      .map(([group, rs]) => ({ group, revenue: revenue(rs), share: div(revenue(rs), total) }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  /** Median lead time (days) for a given shift_status (ER fill-difficulty storyline). */
  const medianLeadTime = (s, status) =>
    median(s.filter((r) => r.shift_status === status).map((r) => r.request_lead_time_days));

  /** Full KPI bundle for a slice of SCHEDULE rows. */
  function scheduleKpis(s) {
    return {
      revenue: revenue(s),
      grossMargin: grossMargin(s),
      grossMarginPct: grossMarginPct(s),
      utilization: utilization(s),
      fillRate: fillRate(s),
      unfilledDemand: unfilledDemand(s),
      paidIdleCost: paidIdleCost(s),
      cancellationRate: cancellationRate(s),
      revenuePerWorkedDay: revenuePerWorkedDay(s),
      workedDays: workedDays(s),
      activeVets: activeVets(s),
    };
  }

  // ---------------------------------------------------------------------------
  // 4. Budget variance: actual (SCHEDULE) vs BUDGET rows, by market and month
  // ---------------------------------------------------------------------------
  /**
   * For each BUDGET row (one market-month), compute the matching actuals from
   * SCHEDULE rows of that market and month. Variance = actual - budget;
   * variance % = (actual - budget) / |budget|. Rate KPIs are compared in points.
   */
  function budgetVariance(rows) {
    const sched = groupBy(ofType(rows, "SCHEDULE"), (r) => r.market + "|" + r.month);
    return ofType(rows, "BUDGET").map((b) => {
      const s = sched.get(b.market + "|" + b.month) || [];
      const a = scheduleKpis(s);
      const pct = (act, bud) => (bud ? (act - bud) / Math.abs(bud) : null);
      return {
        market: b.market, region: b.region, month: b.month,
        revenue: a.revenue, budgetRevenue: b.budget_revenue,
        revenueVar: a.revenue - b.budget_revenue, revenueVarPct: pct(a.revenue, b.budget_revenue),
        grossMargin: a.grossMargin, budgetGrossMargin: b.budget_gross_margin,
        grossMarginVar: a.grossMargin - b.budget_gross_margin,
        workedDays: a.workedDays, budgetWorkedDays: b.budget_worked_days,
        utilization: a.utilization, budgetUtilization: b.budget_utilization_pct,
        fillRate: a.fillRate, budgetFillRate: b.budget_fill_rate_pct,
        activeVets: a.activeVets, budgetActiveVets: b.budget_active_vets,
        budgetNewHospitals: b.budget_new_hospitals,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // 5. Vet recruiting funnel (VET_PIPELINE rows)
  // ---------------------------------------------------------------------------
  /**
   * Stage reached is derived from the milestone dates / statuses on each candidate,
   * so a candidate rejected after interview still counts as having been screened.
   *   Applied   = every candidate row
   *   Screened  = screen_date present
   *   Interview = interview_date present
   *   Offer     = offer_date present
   *   Accepted  = offer_status starts with "Accepted" (incl. future starts)
   *   Hired     = pipeline_stage = "Hired" (already started)
   * Offer acceptance rate = accepted / (accepted + declined)  (pending excluded)
   * Cost per hire = sum(recruiting_cost) / hires   (hires = accepted offers; see HIRE_DEF)
   */
  const HIRE_DEF = "accepted"; // "accepted" (incl. future starts) or "started"
  function vetFunnel(p) {
    const accepted = count(p, (r) => (r.offer_status || "").startsWith("Accepted"));
    const declined = count(p, (r) => r.offer_status === "Declined");
    const started = count(p, (r) => r.pipeline_stage === "Hired");
    const hires = HIRE_DEF === "started" ? started : accepted;
    const cost = sum(p, "recruiting_cost");
    return {
      stages: [
        { stage: "Applied", count: p.length },
        { stage: "Phone Screen", count: count(p, (r) => r.screen_date) },
        { stage: "Clinical Interview", count: count(p, (r) => r.interview_date) },
        { stage: "Offer Extended", count: count(p, (r) => r.offer_date) },
        { stage: "Offer Accepted", count: accepted },
        { stage: "Started", count: started },
      ],
      offerAcceptanceRate: div(accepted, accepted + declined),
      hires, recruitingCost: cost, costPerHire: div(cost, hires),
    };
  }

  // ---------------------------------------------------------------------------
  // 6. Hospital sales funnel (HOSPITAL_PIPELINE rows)
  // ---------------------------------------------------------------------------
  /**
   * Stage order: New Lead -> Contacted -> Meeting Held -> Agreement Signed -> Active - First Shift.
   * "Closed - Lost" leads are counted as lost (no stage history in the data).
   * Win rate = won / (won + lost), won = Agreement Signed or Active - First Shift.
   * New hospitals live by month = count by month of first_shift_date.
   */
  const SALES_STAGES = ["New Lead", "Contacted", "Meeting Held", "Agreement Signed", "Active - First Shift"];
  function salesFunnel(p) {
    const won = count(p, (r) => r.lead_stage === "Agreement Signed" || r.lead_stage === "Active - First Shift");
    const lost = count(p, (r) => r.lead_stage === "Closed - Lost");
    const liveByMonth = {};
    for (const r of p) if (r.first_shift_date) {
      const m = r.first_shift_date.slice(0, 7);
      liveByMonth[m] = (liveByMonth[m] || 0) + 1;
    }
    return {
      stages: SALES_STAGES.map((st) => ({ stage: st, count: count(p, (r) => r.lead_stage === st) })),
      open: count(p, (r) => ["New Lead", "Contacted", "Meeting Held"].includes(r.lead_stage)),
      won, lost, winRate: div(won, won + lost), liveByMonth,
    };
  }

  /** Sales-rep leaderboard: one salesFunnel per lead_owner. */
  function repLeaderboard(p) {
    return [...groupBy(p, "lead_owner")].map(([rep, rs]) => {
      const f = salesFunnel(rs);
      return { rep, leads: rs.length, open: f.open, won: f.won, lost: f.lost, winRate: f.winRate,
               live: rs.filter((r) => r.first_shift_date).length };
    }).sort((a, b) => b.won - a.won || (b.winRate || 0) - (a.winRate || 0));
  }

  /** Recruiting by candidate source: applicants, offer acceptance, hires, cost per hire. */
  function funnelBySource(p) {
    return [...groupBy(p, "candidate_source")].map(([source, rs]) => {
      const f = vetFunnel(rs);
      return { source, applicants: rs.length, offerAcceptanceRate: f.offerAcceptanceRate,
               hires: f.hires, recruitingCost: f.recruitingCost, costPerHire: f.costPerHire };
    }).sort((a, b) => b.hires - a.hires);
  }

  // ---------------------------------------------------------------------------
  // 7. Supply vs demand and lead-time views (SCHEDULE rows)
  // ---------------------------------------------------------------------------
  /** Available vet days = sum(salaried_day_flag) - count(PTO)  (the utilization denominator) */
  const availableVetDays = (s) => sum(s, "salaried_day_flag") - count(s, (r) => r.shift_status === "PTO");
  /** Net hospital requests = sum(requested_flag) - sum(hospital_canceled_flag)  (the fill-rate denominator) */
  const netRequests = (s) => sum(s, "requested_flag") - sum(s, "hospital_canceled_flag");

  /** Lead-time buckets on request_lead_time_days, for requested shifts. */
  const LEAD_BUCKETS = [
    { label: "0–2 days", max: 2 }, { label: "3–7 days", max: 7 }, { label: "8–14 days", max: 14 },
    { label: "15–30 days", max: 30 }, { label: "31–60 days", max: 60 }, { label: "61+ days", max: Infinity },
  ];
  const leadBucket = (d) => (d == null ? null : LEAD_BUCKETS.find((b) => d <= b.max).label);
  function byLeadTime(s) {
    const req = s.filter((r) => r.requested_flag === 1);
    const g = groupBy(req, (r) => leadBucket(r.request_lead_time_days));
    return LEAD_BUCKETS.map((b) => {
      const rs = g.get(b.label) || [];
      return { bucket: b.label, requests: rs.length, unfilledDemand: unfilledDemand(rs), fillRate: fillRate(rs) };
    });
  }

  // ---------------------------------------------------------------------------
  // 8. Generic breakdown (powers bar charts and the drill-down panel)
  // ---------------------------------------------------------------------------
  /** Group SCHEDULE rows by any column (or key function) and compute the KPI bundle per group. */
  function breakdown(s, dim) {
    return [...groupBy(s, dim)]
      .filter(([k]) => k != null)
      .map(([key, rs]) => Object.assign({ key, rows: rs.length }, scheduleKpis(rs),
        { availableVetDays: availableVetDays(rs), netRequests: netRequests(rs),
          avgVetRating: div(sum(rs, "vet_rating_of_hospital"), count(rs, (r) => r.vet_rating_of_hospital != null)) }));
  }

  // ---------------------------------------------------------------------------
  // 9. Time periods: Day / Week (Mon start) / Month / Quarter
  // ---------------------------------------------------------------------------
  const toDate = (iso) => new Date(iso + "T00:00:00Z");
  const toIso = (d) => d.toISOString().slice(0, 10);
  const addDays = (iso, n) => { const d = toDate(iso); d.setUTCDate(d.getUTCDate() + n); return toIso(d); };
  const daysInclusive = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000) + 1;
  /** Business days (Mon-Fri) in [a, b]. Weekends carry ~2.5% of revenue, so budgets and run rates use these. */
  function businessDays(a, b) {
    let n = 0;
    for (let d = toDate(a); d <= toDate(b); d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  }
  const minIso = (a, b) => (a < b ? a : b);
  const maxIso = (a, b) => (a > b ? a : b);

  /** Bucket key for a date at a grain: day "2026-09-30", week "2026-09-28" (Monday), month "2026-09", quarter "2026-Q3". */
  function bucketKey(iso, grain) {
    if (grain === "day") return iso;
    if (grain === "week") return weekStart(iso);
    if (grain === "month") return iso.slice(0, 7);
    return iso.slice(0, 4) + "-Q" + (Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1);
  }

  /** Calendar [start, end] of a bucket. */
  function bucketRange(key, grain) {
    if (grain === "day") return [key, key];
    if (grain === "week") return [key, addDays(key, 6)];
    if (grain === "month") {
      const d = toDate(key + "-01"); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0);
      return [key + "-01", toIso(d)];
    }
    const y = key.slice(0, 4), q = Number(key.slice(6));
    const start = `${y}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`;
    return [start, bucketRange(`${y}-${String(q * 3).padStart(2, "0")}`, "month")[1]];
  }

  /** All buckets at a grain spanning the SCHEDULE date range, ascending. */
  function listBuckets(dataMin, dataMax, grain) {
    const out = [];
    let k = bucketKey(dataMin, grain);
    while (bucketRange(k, grain)[0] <= dataMax) {
      out.push(k);
      k = bucketKey(addDays(bucketRange(k, grain)[1], 1), grain);
    }
    return out;
  }

  /** A bucket's range clipped to the dates the data actually covers (handles partial periods). */
  const effectiveRange = (key, grain, dataMin, dataMax) => {
    const [s, e] = bucketRange(key, grain);
    return [maxIso(s, dataMin), minIso(e, dataMax)];
  };
  const isPartial = (key, grain, dataMin, dataMax) => {
    const [s, e] = bucketRange(key, grain);
    return s < dataMin || e > dataMax;
  };
  const inRange = (rows, from, to) => rows.filter((r) => r.record_date >= from && r.record_date <= to);
  /** SCHEDULE date span (pipeline rows carry older application dates, so they are excluded). */
  function scheduleSpan(rows) {
    let lo = "9999", hi = "";
    for (const r of rows) if (r.record_type === "SCHEDULE" && r.record_date) {
      if (r.record_date < lo) lo = r.record_date;
      if (r.record_date > hi) hi = r.record_date;
    }
    return hi ? [lo, hi] : [null, null];
  }

  // ---------------------------------------------------------------------------
  // 10. Budget for any date range (pro-rated by business day, Mon-Fri)
  // ---------------------------------------------------------------------------
  /**
   * BUDGET rows are one market-month. A budget month "covers" its calendar days up to the last
   * SCHEDULE date in the data (so the Oct 1-16 budget covers Oct 1-16, matching the README).
   * For a range [from, to], each budget row contributes (overlap business days / covered business days) of its
   * additive figures (revenue, gross margin, worked days, new hospitals).
   * Rates (utilization, fill rate) = budget rate weighted by pro-rated budget worked days.
   * Active vets = headcount, not additive: sum across markets for the LATEST budget month in range.
   * Returns null when no budget overlaps the range.
   */
  function budgetForRange(budgetRows, from, to, dataMax) {
    let n = 0, revenue = 0, gm = 0, wd = 0, newH = 0, uW = 0, fW = 0, wW = 0;
    const vetsByMonth = {};
    for (const b of budgetRows) {
      const [ms, meCal] = bucketRange(b.month, "month");
      const me = minIso(meCal, dataMax);
      if (me < ms) continue;
      const lo = maxIso(from, ms), hi = minIso(to, me);
      if (hi < lo) continue;
      const cov = businessDays(ms, me);
      const f = cov ? businessDays(lo, hi) / cov : 0;
      n++;
      revenue += (b.budget_revenue || 0) * f;
      gm += (b.budget_gross_margin || 0) * f;
      const w = (b.budget_worked_days || 0) * f;
      wd += w;
      newH += (b.budget_new_hospitals || 0) * f;
      if (b.budget_utilization_pct != null) { uW += b.budget_utilization_pct * w; wW += w; }
      if (b.budget_fill_rate_pct != null) fW += b.budget_fill_rate_pct * w;
      vetsByMonth[b.month] = (vetsByMonth[b.month] || 0) + (b.budget_active_vets || 0);
    }
    if (!n) return null;
    const lastMonth = Object.keys(vetsByMonth).sort().pop();
    return {
      revenue, grossMargin: gm, grossMarginPct: div(gm, revenue), workedDays: wd, newHospitals: newH,
      utilization: div(uW, wW), fillRate: div(fW, wW), activeVets: vetsByMonth[lastMonth],
    };
  }

  /** Actual vs pro-rated budget by market for a date range. */
  function budgetVsActualByMarket(sched, budgetRows, from, to, dataMax) {
    const s = groupBy(inRange(sched, from, to), "market");
    const b = groupBy(budgetRows, "market");
    const markets = new Set([...s.keys(), ...b.keys()]);
    return [...markets].map((m) => {
      const a = scheduleKpis(s.get(m) || []);
      const bud = budgetForRange(b.get(m) || [], from, to, dataMax);
      return { market: m, actual: a, budget: bud,
               revenueVar: bud ? a.revenue - bud.revenue : null,
               revenueVarPct: bud && bud.revenue ? (a.revenue - bud.revenue) / Math.abs(bud.revenue) : null };
    }).sort((x, y) => (x.revenueVarPct ?? 0) - (y.revenueVarPct ?? 0));
  }

  // ---------------------------------------------------------------------------
  // 11. Data metadata
  // ---------------------------------------------------------------------------
  /** "Updated" date = latest record_date in the data. */
  const latestDate = (rows) => rows.reduce((m, r) => (r.record_date && r.record_date > m ? r.record_date : m), "");

  const api = {
    cleanRow, combine, weekStart, ofType, groupBy, median, div, sum, count,
    revenue, grossMargin, grossMarginPct, utilization, fillRate, unfilledDemand, paidIdleCost,
    cancellationRate, revenuePerWorkedDay, workedDays, activeVets, concentration, medianLeadTime,
    scheduleKpis, budgetVariance, vetFunnel, salesFunnel, repLeaderboard, funnelBySource,
    availableVetDays, netRequests, byLeadTime, LEAD_BUCKETS, breakdown,
    bucketKey, bucketRange, listBuckets, effectiveRange, isPartial, inRange, scheduleSpan,
    daysInclusive, businessDays, addDays, budgetForRange, budgetVsActualByMarket, latestDate, HIRE_DEF,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KPI = api;
})(typeof window !== "undefined" ? window : globalThis);
