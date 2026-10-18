/*
 * insights.js — the auto-generated "What changed" call-outs.
 * Uses only functions from kpis.js (no new formulas here); this file decides
 * which movements are worth a sentence. Thresholds are listed up top so they're auditable.
 */
(function (root) {
  const K = root.KPI;

  const T = {
    budgetMissPct: -0.05,     // market revenue at least 5% under budget
    utilMovePts: 0.03,        // market utilization move of 3+ pts vs prior period
    minAvailDays: 20,         // ignore tiny markets/periods for utilization moves
    cancelSpikeMultiple: 2,   // group cancel rate >= 2x overall ...
    cancelSpikeFloor: 0.10,   // ... and >= 10%
    minBooked: 15,            // min booked shifts to judge a group's cancel rate
    concentrationWarn: 0.25,  // a corporate group above 25% of revenue
    concentrationMovePts: 0.03,
    fillGapPts: 0.10,         // shift type 10+ pts below overall fill rate
    minRequests: 20,
  };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
  const B = (s) => "<b>" + esc(s) + "</b>";
  const pct = (v, d = 1) => (v == null ? "—" : (v < 0 ? "−" : "") + Math.abs(v * 100).toFixed(d) + "%");
  const pts = (v) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(1) + " pts";
  const money = (v) => {
    const a = Math.abs(v), s = v < 0 ? "−$" : "$";
    return a >= 1e6 ? s + (a / 1e6).toFixed(2) + "M" : a >= 1e3 ? s + Math.round(a / 1e3) + "K" : s + Math.round(a);
  };

  /**
   * ctx: { sched (dimension-filtered SCHEDULE rows, all dates), budgetRows, cur:[from,to], prior:[from,to]|null,
   *        dataMax, budgetAvailable, periodLabel }
   * returns [{ severity: "bad"|"warn"|"good", title, text, weight }]
   */
  function generate(ctx) {
    const out = [];
    const cur = K.inRange(ctx.sched, ctx.cur[0], ctx.cur[1]);
    const prior = ctx.prior ? K.inRange(ctx.sched, ctx.prior[0], ctx.prior[1]) : [];
    if (!cur.length) return out;

    // 1. Budget: markets furthest below revenue plan
    if (ctx.budgetAvailable) {
      const bva = K.budgetVsActualByMarket(ctx.sched, ctx.budgetRows, ctx.cur[0], ctx.cur[1], ctx.dataMax)
        .filter((m) => m.revenueVarPct != null);
      const misses = bva.filter((m) => m.revenueVarPct <= T.budgetMissPct).slice(0, 2);
      if (misses.length) {
        out.push({
          severity: "bad", weight: Math.abs(misses[0].revenueVarPct) * 20, title: "Below revenue budget",
          text: misses.map((m) => `${B(m.market)} ${pct(m.revenueVarPct)} (${money(m.revenueVar)})`).join(", ") +
            " vs. plan for the period.",
        });
      }
      const best = bva[bva.length - 1];
      if (best && best.revenueVarPct >= 0.03) {
        out.push({ severity: "good", weight: best.revenueVarPct * 5, title: "Ahead of budget",
          text: `${B(best.market)} is ${pct(best.revenueVarPct)} over revenue plan (${money(best.revenueVar)}).` });
      }
    }

    // 2. Utilization movers by market vs prior period (skipped when a group / shift-type filter hides idle days)
    if (prior.length && ctx.capacityOk !== false) {
      const now = new Map(K.breakdown(cur, "market").map((m) => [m.key, m]));
      const was = new Map(K.breakdown(prior, "market").map((m) => [m.key, m]));
      const moves = [...now.values()]
        .filter((m) => was.has(m.key) && m.availableVetDays >= T.minAvailDays && m.utilization != null && was.get(m.key).utilization != null)
        .map((m) => ({ m, d: m.utilization - was.get(m.key).utilization }))
        .sort((a, b) => a.d - b.d);
      const drop = moves[0], rise = moves[moves.length - 1];
      if (drop && drop.d <= -T.utilMovePts) {
        out.push({ severity: "bad", weight: Math.abs(drop.d) * 12, title: "Utilization drop",
          text: `${B(drop.m.key)} utilization fell ${pts(drop.d)} to ${pct(drop.m.utilization)}; ` +
            `paid idle cost ${money(drop.m.paidIdleCost)} and gross margin ${pct(drop.m.grossMarginPct)}.` });
      }
      if (rise && rise !== drop && rise.d >= T.utilMovePts) {
        out.push({ severity: "good", weight: rise.d * 8, title: "Utilization recovery",
          text: `${B(rise.m.key)} utilization rose ${pts(rise.d)} to ${pct(rise.m.utilization)}.` });
      }
    }

    // 3. Cancellation spikes by corporate group (or normalization of a prior spike)
    const overallCancel = K.cancellationRate(cur);
    const booked = (rs) => rs.filter((r) => ["Worked", "Canceled by Hospital", "Sick Callout"].includes(r.shift_status)).length;
    const isSpike = (rate, n, base) => n >= T.minBooked && rate != null &&
      rate >= Math.max(T.cancelSpikeFloor, T.cancelSpikeMultiple * (base || 0));
    const curGroups = K.groupBy(cur, "corporate_group"), priorGroups = K.groupBy(prior, "corporate_group");
    const priorCancel = K.cancellationRate(prior);
    let spikeFound = false;
    for (const [g, rs] of curGroups) {
      const rate = K.cancellationRate(rs);
      if (isSpike(rate, booked(rs), overallCancel)) {
        spikeFound = true;
        out.push({ severity: "bad", weight: rate * 10, title: "Cancellation spike",
          text: `${B(g)} canceled ${pct(rate)} of booked shifts (company ${pct(overallCancel)}).` });
      }
    }
    if (!spikeFound) {
      for (const [g, rs] of priorGroups) {
        const was = K.cancellationRate(rs);
        if (isSpike(was, booked(rs), priorCancel) && curGroups.has(g)) {
          out.push({ severity: "good", weight: 3, title: "Cancellations normalized",
            text: `${B(g)} cancellations back to ${pct(K.cancellationRate(curGroups.get(g)))} (was ${pct(was)}).` });
        }
      }
    }

    // 4. Customer concentration
    const allGroups = K.concentration(cur);
    const conc = allGroups.filter((c) => c.group !== "Independent");
    if (conc.length && allGroups.length > 1) { // meaningless when the page is filtered to one group
      const top = conc[0];
      const prevTop = prior.length ? K.concentration(prior).find((c) => c.group === top.group) : null;
      const move = prevTop ? top.share - prevTop.share : 0;
      if (top.share >= T.concentrationWarn || move >= T.concentrationMovePts) {
        out.push({ severity: "warn", weight: top.share * 6 + move * 30, title: "Customer concentration",
          text: `${B(top.group)} is ${pct(top.share)} of revenue` +
            (prevTop ? ` (${pts(move)} vs. prior period)` : "") + "." });
      }
    }

    // 5. Hardest-to-fill shift type
    const overallFill = K.fillRate(cur);
    const st = K.breakdown(cur, "shift_type").filter((s) => s.netRequests >= T.minRequests && s.fillRate != null)
      .sort((a, b) => a.fillRate - b.fillRate);
    if (st.length && overallFill != null && st[0].fillRate <= overallFill - T.fillGapPts) {
      const worst = st[0];
      const unf = cur.filter((r) => r.shift_type === worst.key);
      const med = K.medianLeadTime(unf, "Unfilled Request");
      out.push({ severity: "warn", weight: (overallFill - worst.fillRate) * 8, title: "Hard-to-fill shifts",
        text: `${B(worst.key)} fill rate ${pct(worst.fillRate)} vs. ${pct(overallFill)} overall; ` +
          `${money(worst.unfilledDemand)} unfilled` + (med != null ? `, median ${med} days' notice on misses.` : ".") });
    }

    // Keep a balanced set of at most 5: the strongest of each severity first, then the runners-up.
    const by = (sev) => out.filter((o) => o.severity === sev).sort((a, b) => b.weight - a.weight);
    const [bad, warn, good] = [by("bad"), by("warn"), by("good")];
    const picked = [bad[0], good[0], warn[0], bad[1], good[1], warn[1], bad[2]].filter(Boolean).slice(0, 5);
    const rank = { bad: 0, warn: 1, good: 2 };
    return picked.sort((a, b) => rank[a.severity] - rank[b.severity] || b.weight - a.weight);
  }

  root.INSIGHTS = { generate, THRESHOLDS: T };
})(window);
