/*
 * app.js — data loading, page state, filters, charts and the drill-down drawer.
 * No business formulas live here: every figure comes from KPI.* in kpis.js,
 * and every label comes from IV_LABELS in labels.js.
 */
(function () {
  "use strict";
  const K = window.KPI, L = window.IV_LABELS, INS = window.INSIGHTS;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  const F = {
    money(v) {
      if (v == null || !isFinite(v)) return "—";
      const a = Math.abs(v), s = v < 0 ? "−$" : "$";
      if (a >= 1e6) return s + (a / 1e6).toFixed(2) + "M";
      if (a >= 1e5) return s + Math.round(a / 1e3) + "K";
      if (a >= 1e3) return s + (a / 1e3).toFixed(1) + "K";
      return s + Math.round(a).toLocaleString();
    },
    pct: (v, d = 1) => (v == null || !isFinite(v) ? "—" : (v * 100).toFixed(d) + "%"),
    num: (v, d = 0) => (v == null || !isFinite(v) ? "—" : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })),
    signedPct: (v) => (v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(1) + "%"),
    pts: (v) => (v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(1) + " pts"),
    signedNum: (v) => (v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "−") + Math.abs(Math.round(v)).toLocaleString()),
  };

  /** Metric registry: label, formatter, kind (how deltas are computed), and whether higher is better. */
  const METRICS = {
    revenue: { label: "Revenue", fmt: F.money, kind: "money", good: 1 },
    grossMargin: { label: "Gross Margin $", fmt: F.money, kind: "money", good: 1 },
    grossMarginPct: { label: "Gross Margin %", fmt: F.pct, kind: "rate", good: 1 },
    utilization: { label: "Utilization", fmt: F.pct, kind: "rate", good: 1 },
    fillRate: { label: "Fill Rate", fmt: F.pct, kind: "rate", good: 1 },
    unfilledDemand: { label: "Unfilled Demand $", fmt: F.money, kind: "money", good: -1 },
    paidIdleCost: { label: "Paid Idle Cost", fmt: F.money, kind: "money", good: -1 },
    cancellationRate: { label: "Cancellation Rate", fmt: F.pct, kind: "rate", good: -1 },
    revenuePerWorkedDay: { label: "Revenue / Worked Day", fmt: (v) => (v == null || !isFinite(v) ? "—" : "$" + Math.round(v).toLocaleString()), kind: "ratio", good: 1 },
    workedDays: { label: "Worked Days", fmt: F.num, kind: "money", good: 1 },
    activeVets: { label: "Active Vets", fmt: F.num, kind: "headcount", good: 1 },
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const FILTER_DIMS = ["market", "region", "corporate_group", "shift_type"];
  const BUDGET_DIMS = ["market", "region"]; // budget + pipelines exist at market level only
  const GRAIN_N = { day: 31, week: 16, month: 12, quarter: 8 };
  const state = {
    manifestSources: [], droppedSources: [], rows: [], dupes: 0,
    grain: ["day", "week", "month", "quarter"].includes(store.get("iv-grain")) ? store.get("iv-grain") : "month",
    period: null, followLatest: true,
    filters: Object.fromEntries(FILTER_DIMS.map((d) => [d, new Set()])),
    heatMetric: "utilization", hospSort: { key: "revenue", dir: -1 }, hospTop: 10,
    collapsed: store.get("iv-collapsed") || {}, ctx: null,
  };
  const data = { buckets: [] };
  const charts = {};

  // ---------------------------------------------------------------------------
  // Dates & labels
  // ---------------------------------------------------------------------------
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const D = (iso) => new Date(iso + "T00:00:00Z");
  const shortDate = (iso) => { const d = D(iso); return MON[d.getUTCMonth()] + " " + d.getUTCDate(); };
  const longDate = (iso) => { const d = D(iso); return `${DOW_LONG[d.getUTCDay()]}, ${MONTH_LONG[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
  function bucketLabel(key, grain, long) {
    if (grain === "day") { const d = D(key); return long ? `${DOW[d.getUTCDay()]}, ${shortDate(key)}, ${d.getUTCFullYear()}` : shortDate(key); }
    if (grain === "week") return long ? `Week of ${shortDate(key)}, ${key.slice(0, 4)}` : "Wk " + shortDate(key);
    if (grain === "month") { const m = Number(key.slice(5, 7)) - 1; return long ? `${MON[m]} ${key.slice(0, 4)}` : `${MON[m]} '${key.slice(2, 4)}`; }
    return `${key.slice(5)} ${key.slice(0, 4)}`;
  }
  const isPartial = (key, grain) => K.isPartial(key, grain, data.min, data.max);
  const rangeText = (r) => (r[0] === r[1] ? shortDate(r[0]) : `${shortDate(r[0])} – ${shortDate(r[1])}`);

  /** Dimensions available for filtering and drilling. */
  const DIMS = {
    market: { label: L.label("market"), get: (r) => r.market },
    region: { label: L.label("region"), get: (r) => r.region },
    hospital_id: { label: L.label("hospital_name"), get: (r) => r.hospital_id, name: (k) => (data.hosp.get(k) || {}).name || k },
    corporate_group: { label: L.label("corporate_group"), get: (r) => r.corporate_group },
    hospital_type: { label: L.label("hospital_type"), get: (r) => r.hospital_type },
    vet_id: { label: L.label("vet_name"), get: (r) => r.vet_id, name: (k) => data.vetName.get(k) || k },
    shift_type: { label: L.label("shift_type"), get: (r) => r.shift_type },
    placement_type: { label: L.label("placement_type"), get: (r) => r.placement_type },
    shift_status: { label: L.label("shift_status"), get: (r) => r.shift_status, name: (k) => L.valueLabel("shift_status", k) },
    day_of_week: { label: L.label("day_of_week"), get: (r) => r.day_of_week },
    lead_bucket: { label: L.label("lead_bucket"), get: (r) => r.lead_bucket },
    vet_program_days: { label: L.label("vet_program_days"), get: (r) => r.vet_program_days },
    __day: { label: "Day", get: (r) => r.record_date, name: (k) => bucketLabel(k, "day", true) },
    __week: { label: "Week", get: (r) => K.bucketKey(r.record_date, "week"), name: (k) => bucketLabel(k, "week", true) },
    __month: { label: "Month", get: (r) => r.month, name: (k) => bucketLabel(k, "month", true) },
  };
  const dimName = (dim, key) => (DIMS[dim] && DIMS[dim].name ? DIMS[dim].name(key) : key);

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------
  const parseCsv = (text) => Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() }).data;

  async function fetchManifest() {
    const bust = "t=" + Date.now(); // bypass any CDN / browser cache so a fresh push shows up
    const res = await fetch("data/manifest.json?" + bust, { cache: "no-store" });
    if (!res.ok) throw new Error("data/manifest.json returned HTTP " + res.status);
    const files = (await res.json()).files || [];
    return Promise.all(files.map(async (f) => {
      const r = await fetch("data/" + encodeURI(f) + "?" + bust, { cache: "no-store" });
      if (!r.ok) throw new Error(f + " returned HTTP " + r.status);
      return { name: f, origin: "manifest", rows: parseCsv(await r.text()) };
    }));
  }

  function rebuild() {
    const { rows, duplicatesRemoved } = K.combine([...state.manifestSources, ...state.droppedSources].map((s) => s.rows));
    state.rows = rows; state.dupes = duplicatesRemoved;
    data.sched = K.ofType(rows, "SCHEDULE");
    data.budget = K.ofType(rows, "BUDGET");
    data.vetP = K.ofType(rows, "VET_PIPELINE");
    data.hospP = K.ofType(rows, "HOSPITAL_PIPELINE");
    [data.min, data.max] = K.scheduleSpan(rows);
    data.latest = K.latestDate(rows);
    data.hosp = new Map(); data.vetName = new Map();
    for (const r of data.sched) {
      if (r.hospital_id && !data.hosp.has(r.hospital_id)) data.hosp.set(r.hospital_id, { name: r.hospital_name, market: r.market, group: r.corporate_group });
      if (r.vet_id && !data.vetName.has(r.vet_id)) data.vetName.set(r.vet_id, r.vet_name);
    }
    data.options = {};
    for (const d of FILTER_DIMS) data.options[d] = [...new Set(data.sched.map((r) => r[d]).filter(Boolean))].sort();
    setBuckets();
    buildMultiSelects();
  }

  function setBuckets(anchorDate) {
    data.buckets = data.min ? K.listBuckets(data.min, data.max, state.grain) : [];
    const last = data.buckets[data.buckets.length - 1];
    if (state.followLatest) state.period = last;
    else if (anchorDate) state.period = K.bucketKey(anchorDate, state.grain);
    if (!data.buckets.includes(state.period)) { state.period = last; state.followLatest = true; }
  }

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------
  function passes(r, except, dims = FILTER_DIMS) {
    for (const d of dims) {
      if (d === except) continue;
      const s = state.filters[d];
      if (s.size && !s.has(r[d])) return false;
    }
    return true;
  }
  const schedFiltered = (except) => data.sched.filter((r) => passes(r, except));
  const budgetFiltered = (except) => data.budget.filter((r) => passes(r, except, BUDGET_DIMS));
  const pipeFiltered = (rows) => rows.filter((r) => passes(r, null, BUDGET_DIMS));
  const budgetOk = () => !state.filters.corporate_group.size && !state.filters.shift_type.size;
  // Utilization, paid idle cost and vet supply need every salaried day, but idle and PTO rows carry no
  // hospital, corporate group or shift type. So those metrics are hidden when a slice is hospital-side.
  const capacityOk = () => !state.filters.corporate_group.size && !state.filters.shift_type.size;
  const HOSPITAL_SIDE = new Set(["hospital_id", "corporate_group", "hospital_type", "shift_type", "placement_type", "lead_bucket", "shift_status"]);
  const CAPACITY_METRICS = new Set(["utilization", "paidIdleCost"]);
  const NA_NOTE = "n/a: idle vet days aren't tied to a hospital, group or shift type";

  function makeCtx() {
    const b = data.buckets, i = b.indexOf(state.period);
    const range = K.effectiveRange(state.period, state.grain, data.min, data.max);
    const priorKey = i > 0 ? b[i - 1] : null;
    const priorRange = priorKey ? K.effectiveRange(priorKey, state.grain, data.min, data.max) : null;
    const all = schedFiltered();
    const trendKeys = b.slice(Math.max(0, i - GRAIN_N[state.grain] + 1), i + 1);
    const ctx = {
      i, range, priorKey, priorRange, all, trendKeys,
      cur: K.inRange(all, range[0], range[1]),
      prior: priorRange ? K.inRange(all, priorRange[0], priorRange[1]) : [],
      budgetRows: budgetFiltered(), budgetOk: budgetOk(),
      days: K.businessDays(range[0], range[1]),
      priorDays: priorRange ? K.businessDays(priorRange[0], priorRange[1]) : null,
      label: bucketLabel(state.period, state.grain, true),
      priorLabel: priorKey ? bucketLabel(priorKey, state.grain, true) : null,
      _except: {},
    };
    ctx.curExcept = (dim) => ctx._except[dim] || (ctx._except[dim] = K.inRange(schedFiltered(dim), range[0], range[1]));
    // KPI bundle per trend bucket (shared by sparklines and the trend chart)
    ctx.trend = trendKeys.map((k) => {
      const r = K.effectiveRange(k, state.grain, data.min, data.max);
      return { key: k, range: r, days: K.businessDays(r[0], r[1]), partial: isPartial(k, state.grain), k: K.scheduleKpis(K.inRange(all, r[0], r[1])) };
    });
    return ctx;
  }

  // ---------------------------------------------------------------------------
  // Theme-aware chart helpers
  // ---------------------------------------------------------------------------
  function C() {
    const s = getComputedStyle(document.documentElement), g = (n) => s.getPropertyValue(n).trim();
    const c = { primary: g("--primary"), ink: g("--ink"), accent: g("--accent"), secondary: g("--secondary"), alert: g("--alert"),
      muted: g("--muted"), line: g("--line"), card: g("--card"), soft: g("--soft"), good: g("--good"), bad: g("--bad"), tint: g("--tint") };
    c.dark = document.documentElement.getAttribute("data-theme") === "dark";
    c.palette = [c.primary, c.secondary, c.accent, c.alert, c.dark ? "#B9C9CC" : "#7D9399", c.dark ? "#C6E39E" : "#B4D88A", "#3D8FA0", "#E2B46A"];
    return c;
  }
  function chart(id) {
    const el = document.getElementById(id);
    if (!charts[id] || charts[id].getDom() !== el) charts[id] = echarts.init(el);
    return charts[id];
  }
  function base(c) {
    return {
      textStyle: { fontFamily: "Nunito Sans, system-ui, sans-serif", color: c.ink },
      animationDuration: 350,
      tooltip: { confine: true, backgroundColor: c.card, borderColor: c.line, textStyle: { color: c.ink, fontSize: 12 },
        extraCssText: "box-shadow:0 6px 18px rgba(0,0,0,.14);border-radius:8px;" },
      grid: { left: 8, right: 18, top: 30, bottom: 8, containLabel: true },
    };
  }
  const axisCommon = (c) => ({
    axisLine: { lineStyle: { color: c.line } }, axisTick: { show: false },
    axisLabel: { color: c.muted, fontSize: 11 }, splitLine: { lineStyle: { color: c.line, type: "dashed" } },
  });
  const legend = (c, extra) => Object.assign({ top: 0, left: 0, itemWidth: 12, itemHeight: 8, textStyle: { color: c.muted, fontSize: 11 } }, extra || {});
  const fade = (on, anySel) => (anySel && !on ? 0.3 : 1);
  function emptyChart(id, msg) {
    const c = C();
    chart(id).setOption({ graphic: { type: "text", left: "center", top: "middle", style: { text: msg, fill: c.muted, font: "13px Nunito Sans", width: 260, overflow: "break", align: "center" } } }, true);
  }

  // ---------------------------------------------------------------------------
  // Click = filter, double-click / double-tap = drill
  // ---------------------------------------------------------------------------
  let lastTap = { k: null, t: 0 };
  function tap(dim, key, opts = {}) {
    if (key == null) return;
    const k = dim + "|" + key, now = Date.now();
    const isDouble = lastTap.k === k && now - lastTap.t < 450;
    lastTap = isDouble ? { k: null, t: 0 } : { k, t: now };
    if (isDouble) {
      if (opts.filterable) toggleFilter(dim, key, true); // undo the first tap's filter
      openDrill(opts.crumbs || [{ dim, key }], opts.drill || {});
      if (opts.filterable) renderAll();
    } else if (opts.onSingle) opts.onSingle();
    else if (opts.filterable) toggleFilter(dim, key);
  }
  function toggleFilter(dim, key, silent) {
    const s = state.filters[dim];
    s.has(key) ? s.delete(key) : s.add(key);
    if (!silent) renderAll();
  }

  // ---------------------------------------------------------------------------
  // Render: header, controls, chips
  // ---------------------------------------------------------------------------
  function renderHeader() {
    $("#updated").textContent = data.latest ? longDate(data.latest) : "—";
    const n = state.manifestSources.length + state.droppedSources.length;
    $("#loadedSummary").textContent = `${F.num(state.rows.length)} rows from ${n} file${n === 1 ? "" : "s"}`;
  }

  function renderPeriodSelect() {
    const sel = $("#selPeriod");
    sel.innerHTML = [...data.buckets].reverse().map((k) => {
      const part = isPartial(k, state.grain);
      const r = K.effectiveRange(k, state.grain, data.min, data.max);
      const extra = part && state.grain !== "day" ? ` (thru ${shortDate(r[1])})` : "";
      return `<option value="${k}">${esc(bucketLabel(k, state.grain, true) + extra)}</option>`;
    }).join("");
    sel.value = state.period;
    $("#selGrain").value = state.grain;
  }

  function buildMultiSelects() {
    for (const host of $$(".ms")) {
      const dim = host.dataset.dim;
      const wasOpen = host.querySelector("details")?.open;
      host.innerHTML = `<details${wasOpen ? " open" : ""}><summary></summary><div class="ms-menu">
        <div class="ms-actions"><button type="button" data-act="all">Show all</button><span class="hint">${esc(DIMS[dim].label)}</span></div>
        ${data.options[dim].map((v) => `<label><input type="checkbox" value="${esc(v)}"> ${esc(v)}</label>`).join("")}
      </div></details>`;
      host.querySelector('[data-act="all"]').addEventListener("click", () => { state.filters[dim].clear(); renderAll(); });
      host.querySelectorAll("input").forEach((cb) => cb.addEventListener("change", () => {
        cb.checked ? state.filters[dim].add(cb.value) : state.filters[dim].delete(cb.value);
        renderAll();
      }));
    }
  }
  function syncMultiSelects() {
    for (const host of $$(".ms")) {
      const dim = host.dataset.dim, s = state.filters[dim];
      host.querySelector("summary").textContent = !s.size ? "All" : s.size === 1 ? [...s][0] : `${s.size} selected`;
      host.querySelectorAll("input").forEach((cb) => { cb.checked = s.has(cb.value); });
    }
  }

  function renderChips() {
    const chips = [];
    for (const d of FILTER_DIMS) for (const v of state.filters[d]) {
      chips.push(`<span class="chip">${esc(DIMS[d].label)}: ${esc(v)}<button data-d="${d}" data-v="${esc(v)}" aria-label="Remove filter">×</button></span>`);
    }
    $("#chips").innerHTML = chips.join("");
    $$("#chips button").forEach((b) => b.addEventListener("click", () => toggleFilter(b.dataset.d, b.dataset.v)));
    $("#btnClear").style.display = chips.length ? "" : "none";
  }

  // ---------------------------------------------------------------------------
  // KPI cards
  // ---------------------------------------------------------------------------
  const CARDS = [
    { id: "revenue", budget: "revenue", solid: true, sub: () => "Billed to hospitals",
      tip: "Sum of Revenue on schedule rows. Vs. budget uses the monthly plan pro-rated by business day (Mon–Fri); vs. prior period compares the per-business-day run rate so partial periods are fair." },
    { id: "grossMarginPct", budget: "grossMarginPct", sub: (k) => F.money(k.grossMargin) + " gross margin",
      tip: "Sum of Gross Margin ÷ Sum of Revenue. Gross margin = revenue − total direct cost (salary, premiums, extra-shift pay, benefits)." },
    { id: "utilization", budget: "utilization", sub: (k) => F.num(k.workedDays) + " worked days",
      tip: "Worked salaried days ÷ (salaried days − PTO days). Vets are paid whether or not a shift is booked, so this drives margin." },
    { id: "fillRate", budget: "fillRate", sub: (k, ctx) => F.num(K.netRequests(ctx.cur)) + " net requests",
      tip: "Filled shifts ÷ (hospital requests − hospital cancellations): the share of hospital demand we covered." },
    { id: "activeVets", budget: "activeVets", sub: (k) => (capacityOk() ? F.money(k.paidIdleCost) + " paid idle cost" : "vets who worked these shifts"),
      tip: "Distinct vets with at least one salaried day in the period." },
    { id: "unfilledDemand", solid: true, alertable: true, sub: (k, ctx) => F.num(ctx.cur.filter((r) => r.shift_status === "Unfilled Request").length) + " unfilled requests · revenue left on the table",
      tip: "Sum of (Bill Rate + Premium Billed) on Unfilled requests. Turns orange when the per-day run rate is up vs. the prior period." },
  ];

  function buildCards() {
    $("#kpiGrid").innerHTML = CARDS.map((cd) => `
      <div class="card kpi${cd.solid ? " solid" : ""}" data-metric="${cd.id}" title="Double-click to drill in">
        <div class="card-head"><h3>${esc(METRICS[cd.id].label)}</h3>
          <button class="drill-btn" aria-label="Drill into ${esc(METRICS[cd.id].label)}" title="Drill in">⤢</button>
          <span class="help" tabindex="0" data-tip="${esc(cd.tip)}">?</span></div>
        <div class="kpi-value">—</div><div class="kpi-sub"></div>
        <div class="deltas"></div>
        <div class="spark" id="spark-${cd.id}"></div>
      </div>`).join("");
    for (const el of $$(".kpi")) {
      const metric = el.dataset.metric;
      const go = () => openDrill([], { metric, by: "market" });
      el.querySelector(".drill-btn").addEventListener("click", (e) => { e.stopPropagation(); go(); });
      el.addEventListener("click", (e) => { if (!e.target.closest(".help,.drill-btn")) tap("__card", metric, { onSingle: () => {}, crumbs: [], drill: { metric, by: "market" } }); });
    }
  }

  /** Delta between two values of a metric. Money compares per-day run rate when day counts are given. */
  function compare(metric, a, b, aDays, bDays) {
    const m = METRICS[metric];
    if (a == null || b == null) return null;
    if (m.kind === "rate") return { v: a - b, text: F.pts(a - b) };
    if (m.kind === "headcount") return { v: a - b, text: F.signedNum(a - b) };
    let x = a, y = b;
    if (m.kind === "money" && aDays !== undefined) { if (!aDays || !bDays) return null; x = a / aDays; y = b / bDays; }
    if (!y) return null;
    const d = (x - y) / Math.abs(y);
    return { v: d, text: F.signedPct(d) };
  }
  function deltaHtml(metric, cmp, label) {
    if (!cmp) return `<div class="delta"><b class="neutral">—</b><span class="lbl">${esc(label)}</span></div>`;
    const good = METRICS[metric].good;
    const cls = Math.abs(cmp.v) < 1e-9 ? "neutral" : cmp.v * good > 0 ? "up-good" : "down-bad";
    const arrow = Math.abs(cmp.v) < 1e-9 ? "" : cmp.v > 0 ? "▲ " : "▼ ";
    return `<div class="delta"><b class="${cls}">${arrow}${cmp.text}</b><span class="lbl">${esc(label)}</span></div>`;
  }

  function renderCards(ctx) {
    const c = C();
    const kc = K.scheduleKpis(ctx.cur), kp = ctx.prior.length ? K.scheduleKpis(ctx.prior) : null;
    const bud = ctx.budgetOk ? K.budgetForRange(ctx.budgetRows, ctx.range[0], ctx.range[1], data.max) : null;
    const priorLbl = ctx.priorKey ? `vs. ${bucketLabel(ctx.priorKey, state.grain, false)}` : "no prior period";
    for (const cd of CARDS) {
      const el = $(`.kpi[data-metric="${cd.id}"]`), m = METRICS[cd.id];
      if (CAPACITY_METRICS.has(cd.id) && !capacityOk()) {
        el.querySelector(".kpi-value").textContent = "—";
        el.querySelector(".kpi-sub").textContent = "Clear Corporate Group / Shift Type to see it";
        el.querySelector(".deltas").innerHTML = `<div class="delta"><b class="neutral">n/a</b><span class="lbl">idle vet days aren't tied to a group or shift type</span></div>`;
        chart("spark-" + cd.id).clear();
        continue;
      }
      el.querySelector(".kpi-value").textContent = m.fmt(kc[cd.id]);
      el.querySelector(".kpi-sub").textContent = cd.sub(kc, ctx);
      const vsPrior = kp ? compare(cd.id, kc[cd.id], kp[cd.id], ctx.days, ctx.priorDays) : null;
      let html = "";
      if (cd.budget) {
        html += bud ? deltaHtml(cd.id, compare(cd.id, kc[cd.id], bud[cd.budget]), "vs. budget " + m.fmt(bud[cd.budget]))
          : `<div class="delta"><b class="neutral">—</b><span class="lbl">${ctx.budgetOk ? "no budget for period" : "budget is by market only"}</span></div>`;
      }
      html += deltaHtml(cd.id, vsPrior, priorLbl + (kp && m.kind === "money" ? " (per business day)" : ""));
      el.querySelector(".deltas").innerHTML = html;
      if (cd.alertable) el.classList.toggle("alert", !!(vsPrior && vsPrior.v > 0));

      // Sparkline: per-day run rate for money metrics, level for rates/headcount
      const vals = ctx.trend.map((t) => {
        const v = t.k[cd.id];
        return v == null ? null : m.kind === "money" ? (t.days ? v / t.days : null) : v;
      });
      const col = cd.solid ? "rgba(255,255,255,.95)" : c.secondary;
      chart("spark-" + cd.id).setOption({
        animation: false, grid: { left: 0, right: 2, top: 4, bottom: 2 },
        tooltip: Object.assign(base(c).tooltip, { trigger: "axis", formatter: (p) =>
          `${esc(bucketLabel(ctx.trend[p[0].dataIndex].key, state.grain, true))}<br><b>${m.fmt(p[0].value)}</b>${m.kind === "money" ? " / business day" : ""}` }),
        xAxis: { type: "category", show: false, data: ctx.trend.map((t) => t.key), boundaryGap: false },
        yAxis: { type: "value", show: false, scale: true },
        series: [{ type: "line", data: vals, smooth: 0.3, symbol: "circle", symbolSize: (v, p) => (p.dataIndex === vals.length - 1 ? 6 : 0),
          lineStyle: { width: 2, color: col }, itemStyle: { color: col },
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: cd.solid ? "rgba(255,255,255,.35)" : c.secondary + "55" }, { offset: 1, color: "rgba(255,255,255,0)" }]) } }],
      }, true);
    }
    const part = isPartial(state.period, state.grain);
    $("#subOverview").textContent = `${ctx.label} (${rangeText(ctx.range)}${part ? ", partial" : ""})` +
      (ctx.priorLabel ? ` vs. ${ctx.priorLabel}` : "") + " · budget pro-rated by business day";
  }

  function renderInsights(ctx) {
    const list = INS.generate({ sched: ctx.all, budgetRows: ctx.budgetRows, cur: ctx.range, prior: ctx.priorRange, dataMax: data.max, budgetAvailable: ctx.budgetOk, capacityOk: capacityOk() });
    $("#insights").innerHTML = list.length
      ? list.map((i) => `<li class="${i.severity}"><span class="it">${esc(i.title)}</span>${i.text}</li>`).join("")
      : `<li class="empty">No notable changes for this selection.</li>`;
  }

  // ---------------------------------------------------------------------------
  // Revenue trend + mix
  // ---------------------------------------------------------------------------
  function renderTrend(ctx) {
    const c = C();
    const budget = ctx.budgetOk ? ctx.trend.map((t) => (K.budgetForRange(ctx.budgetRows, t.range[0], t.range[1], data.max) || {}).revenue ?? null) : [];
    const ch = chart("chTrend");
    ch.setOption(Object.assign(base(c), {
      legend: legend(c, { data: ["Revenue", "Budget", "Gross margin %"] }),
      tooltip: Object.assign(base(c).tooltip, { trigger: "axis", formatter: (p) => {
        const t = ctx.trend[p[0].dataIndex];
        return `<b>${esc(bucketLabel(t.key, state.grain, true))}</b>${t.partial ? " (partial: " + rangeText(t.range) + ")" : ""}<br>` +
          p.map((s) => `${s.marker}${esc(s.seriesName)}: <b>${s.seriesName === "Gross margin %" ? F.pct(s.value) : F.money(s.value)}</b>`).join("<br>");
      } }),
      xAxis: Object.assign(axisCommon(c), { type: "category", data: ctx.trend.map((t) => bucketLabel(t.key, state.grain) + (t.partial ? "*" : "")) }),
      yAxis: [Object.assign(axisCommon(c), { type: "value", axisLabel: { color: c.muted, fontSize: 11, formatter: (v) => F.money(v) } }),
        Object.assign(axisCommon(c), { type: "value", splitLine: { show: false }, axisLabel: { color: c.muted, fontSize: 11, formatter: (v) => F.pct(v, 0) } })],
      series: [
        { name: "Revenue", type: "bar", barMaxWidth: 44, itemStyle: { color: c.secondary }, data: ctx.trend.map((t, i) => ({ value: t.k.revenue,
            itemStyle: { color: i === ctx.trend.length - 1 ? c.primary : c.secondary, opacity: t.partial ? 0.65 : 1, borderRadius: [4, 4, 0, 0] } })) },
        { name: "Budget", type: "line", data: budget, symbol: "none", lineStyle: { type: "dashed", width: 2, color: c.alert }, itemStyle: { color: c.alert } },
        { name: "Gross margin %", type: "line", yAxisIndex: 1, data: ctx.trend.map((t) => t.k.grossMarginPct), smooth: 0.3, symbolSize: 6,
          lineStyle: { width: 2.5, color: c.accent }, itemStyle: { color: c.accent } },
      ],
    }), true);
    ch.off("click");
    ch.on("click", (p) => {
      const key = ctx.trend[p.dataIndex] && ctx.trend[p.dataIndex].key;
      tap("__period", key, { onSingle: () => setPeriod(key), crumbs: [] });
    });
  }

  function renderDonut(ctx) {
    const c = C(), sel = state.filters.corporate_group;
    const conc = K.concentration(ctx.curExcept("corporate_group"));
    const total = conc.reduce((a, x) => a + x.revenue, 0);
    const ch = chart("chDonut");
    if (!conc.length) return emptyChart("chDonut", "No revenue in this selection.");
    ch.setOption(Object.assign(base(c), {
      tooltip: Object.assign(base(c).tooltip, { trigger: "item", formatter: (p) => `<b>${esc(p.name)}</b><br>${F.money(p.value)} · ${F.pct(p.value / total)} of revenue` }),
      legend: legend(c, { type: "plain", top: "auto", bottom: 0, left: "center", width: "96%", itemGap: 8 }),
      color: c.palette,
      graphic: [{ type: "text", left: "center", top: "35%", style: { text: F.money(total), fill: c.ink, font: "800 20px Nunito Sans", textAlign: "center" } },
        { type: "text", left: "center", top: "46%", style: { text: "revenue", fill: c.muted, font: "12px Nunito Sans", textAlign: "center" } }],
      series: [{ type: "pie", radius: ["48%", "68%"], center: ["50%", "42%"], avoidLabelOverlap: true,
        itemStyle: { borderColor: c.card, borderWidth: 2 },
        label: { color: c.ink, formatter: (p) => F.pct(p.value / total, 0), fontWeight: 700, fontSize: 11 },
        labelLine: { length: 6, length2: 6 },
        data: conc.map((x) => ({ name: x.group, value: x.revenue, itemStyle: { opacity: fade(sel.has(x.group), sel.size) } })) }],
    }), true);
    ch.off("click");
    ch.on("click", (p) => tap("corporate_group", p.name, { filterable: true }));
  }

  // ---------------------------------------------------------------------------
  // Markets
  // ---------------------------------------------------------------------------
  function hbar(id, cats, series, c, opts = {}) {
    const ch = chart(id);
    ch.setOption(Object.assign(base(c), {
      legend: series.length > 1 ? legend(c) : undefined,
      grid: { left: 8, right: 46, top: series.length > 1 ? 26 : 6, bottom: 4, containLabel: true },
      tooltip: Object.assign(base(c).tooltip, { trigger: "axis", axisPointer: { type: "shadow" }, formatter: opts.tooltip }),
      xAxis: Object.assign(axisCommon(c), { type: "value", min: opts.min, max: opts.max, axisLabel: { color: c.muted, fontSize: 10, formatter: opts.axisFmt } }),
      yAxis: Object.assign(axisCommon(c), { type: "category", data: cats, axisLabel: { color: c.ink, fontSize: 11.5, fontWeight: 600 } }),
      series,
    }), true);
    ch.off("click");
    if (opts.onClick) ch.on("click", opts.onClick);
    return ch;
  }

  function renderMarkets(ctx) {
    const c = C(), sel = state.filters.market;
    const bd = K.breakdown(ctx.curExcept("market"), "market");
    if (!bd.length) { ["chMarketUF", "chIdle", "chSupply"].forEach((id) => emptyChart(id, "No data in this selection.")); return; }
    const click = (p) => tap("market", p.name, { filterable: true });
    const item = (v, color, key) => ({ value: v, itemStyle: { color, opacity: fade(sel.has(key), sel.size), borderRadius: [0, 3, 3, 0] } });

    const capOk = capacityOk();
    const capMsg = "Vet idle days aren't tied to a corporate group or shift type. Clear those filters to see this.";
    const uf = [...bd].sort((a, b) => capOk ? (a.utilization ?? 0) - (b.utilization ?? 0) : (a.fillRate ?? 0) - (b.fillRate ?? 0));
    hbar("chMarketUF", uf.map((m) => m.key), [
      ...(capOk ? [{ name: "Utilization", type: "bar", barGap: "10%", barMaxWidth: 12, itemStyle: { color: c.primary }, data: uf.map((m) => item(m.utilization, c.primary, m.key)),
        label: { show: true, position: "right", formatter: (p) => F.pct(p.value, 0), color: c.muted, fontSize: 10 } }] : []),
      { name: "Fill rate", type: "bar", barMaxWidth: 12, itemStyle: { color: c.secondary }, data: uf.map((m) => item(m.fillRate, c.secondary, m.key)),
        label: { show: true, position: "right", formatter: (p) => F.pct(p.value, 0), color: c.muted, fontSize: 10 } },
    ], c, { max: 1, axisFmt: (v) => F.pct(v, 0), onClick: click,
      tooltip: (p) => `<b>${esc(p[0].name)}</b><br>` + p.map((s) => `${s.marker}${s.seriesName}: <b>${F.pct(s.value)}</b>`).join("<br>") });

    if (!capOk) { emptyChart("chIdle", capMsg); emptyChart("chSupply", capMsg); return; }
    const idle = [...bd].sort((a, b) => a.paidIdleCost - b.paidIdleCost);
    hbar("chIdle", idle.map((m) => m.key), [
      { name: "Paid idle cost", type: "bar", barMaxWidth: 18, data: idle.map((m) => item(m.paidIdleCost, c.alert, m.key)),
        label: { show: true, position: "right", formatter: (p) => F.money(p.value), color: c.muted, fontSize: 10 } },
    ], c, { axisFmt: F.money, onClick: click,
      tooltip: (p) => { const m = idle[p[0].dataIndex]; return `<b>${esc(m.key)}</b><br>Paid idle cost: <b>${F.money(m.paidIdleCost)}</b><br>Utilization: ${F.pct(m.utilization)}<br>Gross margin: ${F.pct(m.grossMarginPct)}`; } });

    const sd = [...bd].sort((a, b) => (a.netRequests / (a.availableVetDays || 1)) - (b.netRequests / (b.availableVetDays || 1)));
    hbar("chSupply", sd.map((m) => m.key), [
      { name: "Available vet days", type: "bar", barGap: "10%", barMaxWidth: 12, itemStyle: { color: c.primary }, data: sd.map((m) => item(m.availableVetDays, c.primary, m.key)) },
      { name: "Net hospital requests", type: "bar", barMaxWidth: 12, itemStyle: { color: c.accent }, data: sd.map((m) => item(m.netRequests, c.accent, m.key)),
        label: { show: true, position: "right", fontSize: 10, color: c.muted, formatter: (p) => { const m = sd[p.dataIndex]; return F.num((m.netRequests / (m.availableVetDays || 1)) * 100) + "%"; } } },
    ], c, { axisFmt: (v) => F.num(v), onClick: click,
      tooltip: (p) => { const m = sd[p[0].dataIndex]; return `<b>${esc(m.key)}</b><br>Available vet days: <b>${F.num(m.availableVetDays)}</b><br>Net hospital requests: <b>${F.num(m.netRequests)}</b><br>Demand ÷ supply: <b>${F.pct(m.netRequests / (m.availableVetDays || 1), 0)}</b><br>Fill rate: ${F.pct(m.fillRate)}`; } });
  }

  // ---------------------------------------------------------------------------
  // Budget vs actual
  // ---------------------------------------------------------------------------
  function renderBudget(ctx) {
    const c = C(), sel = state.filters.market;
    if (!ctx.budgetOk) {
      emptyChart("chBudget", "Budget is set by market. Clear the Corporate Group and Shift Type filters to compare.");
      $("#tblBudget").innerHTML = `<p class="hint">Budget is set by market and month. Clear the Corporate Group and Shift Type filters to compare actuals with budget.</p>`;
      return;
    }
    const bva = K.budgetVsActualByMarket(schedFiltered("market"), budgetFiltered("market"), ctx.range[0], ctx.range[1], data.max).filter((m) => m.budget);
    if (!bva.length) { emptyChart("chBudget", "No budget for this period."); $("#tblBudget").innerHTML = ""; return; }
    const rows = [...bva].reverse(); // worst at the top
    hbar("chBudget", rows.map((m) => m.market), [{
      name: "Revenue vs. budget", type: "bar", barMaxWidth: 18,
      data: rows.map((m) => ({ value: m.revenueVarPct, label: { position: m.revenueVarPct >= 0 ? "right" : "left" }, itemStyle: { color: m.revenueVarPct >= 0 ? c.good : c.bad, opacity: fade(sel.has(m.market), sel.size), borderRadius: m.revenueVarPct >= 0 ? [0, 3, 3, 0] : [3, 0, 0, 3] } })),
      label: { show: true, formatter: (p) => F.signedPct(p.value), color: c.muted, fontSize: 10 },
    }], c, { axisFmt: (v) => F.pct(v, 0), onClick: (p) => tap("market", p.name, { filterable: true }),
      min: Math.min(-0.05, ...bva.map((m) => m.revenueVarPct)) * 1.7, max: Math.max(0.05, ...bva.map((m) => m.revenueVarPct)) * 1.6,
      tooltip: (p) => { const m = rows[p[0].dataIndex]; return `<b>${esc(m.market)}</b><br>Actual: <b>${F.money(m.actual.revenue)}</b><br>Budget: ${F.money(m.budget.revenue)}<br>Variance: <b>${F.money(m.revenueVar)} (${F.signedPct(m.revenueVarPct)})</b>`; } });

    // MBR table
    const varCell = (v, isPts, thresh) => {
      if (v == null || !isFinite(v)) return `<td class="muted">—</td>`;
      const cls = Math.abs(v) < thresh ? "" : v > 0 ? "pos" : "neg";
      return `<td class="${cls}">${isPts ? F.pts(v) : F.signedPct(v)}</td>`;
    };
    const vp = (a, b) => (b ? (a - b) / Math.abs(b) : null);
    const line = (name, a, b, extraCls) => `<tr class="${extraCls || ""}" data-market="${esc(name)}">
      <td class="l">${esc(name)}</td>
      <td>${F.money(a.revenue)}</td><td class="muted">${F.money(b.revenue)}</td>${varCell(vp(a.revenue, b.revenue), false, 0.01)}
      <td>${F.money(a.grossMargin)}</td><td class="muted">${F.money(b.grossMargin)}</td>${varCell(vp(a.grossMargin, b.grossMargin), false, 0.01)}
      <td>${F.num(a.workedDays)}</td><td class="muted">${F.num(b.workedDays)}</td>
      <td>${F.pct(a.utilization)}</td><td class="muted">${F.pct(b.utilization)}</td>${varCell(a.utilization - b.utilization, true, 0.005)}
      <td>${F.pct(a.fillRate)}</td><td class="muted">${F.pct(b.fillRate)}</td>${varCell(a.fillRate - b.fillRate, true, 0.005)}
      <td>${F.num(a.activeVets)}</td><td class="muted">${F.num(b.activeVets)}</td></tr>`;
    const sorted = [...bva].sort((a, b) => b.actual.revenue - a.actual.revenue);
    const totA = K.scheduleKpis(K.inRange(schedFiltered("market"), ctx.range[0], ctx.range[1]).filter((r) => sorted.some((m) => m.market === r.market)));
    const totB = K.budgetForRange(budgetFiltered("market"), ctx.range[0], ctx.range[1], data.max);
    $("#tblBudget").innerHTML = `<table class="t"><thead>
      <tr><th></th><th class="grp" colspan="3">Revenue</th><th class="grp" colspan="3">Gross margin $</th><th class="grp" colspan="2">Worked days</th><th class="grp" colspan="3">Utilization</th><th class="grp" colspan="3">Fill rate</th><th class="grp" colspan="2">Active vets</th></tr>
      <tr><th class="l">Market</th><th>Actual</th><th>Budget</th><th>Var</th><th>Actual</th><th>Budget</th><th>Var</th><th>Actual</th><th>Budget</th><th>Actual</th><th>Budget</th><th>Δ</th><th>Actual</th><th>Budget</th><th>Δ</th><th>Actual</th><th>Budget</th></tr></thead><tbody>
      ${sorted.map((m) => line(m.market, m.actual, m.budget, "clickable" + (sel.has(m.market) ? " sel" : ""))).join("")}
      ${totB ? line("Total", totA, totB, "total") : ""}</tbody></table>`;
    $$("#tblBudget tr.clickable").forEach((tr) => tr.addEventListener("click", () => tap("market", tr.dataset.market, { filterable: true })));
    $("#subBudget").textContent = `${ctx.label}: monthly budget pro-rated to ${rangeText(ctx.range)}`;
  }

  // ---------------------------------------------------------------------------
  // Heatmap: market × period
  // ---------------------------------------------------------------------------
  function renderHeat(ctx) {
    const c = C(), metric = state.heatMetric, m = METRICS[metric];
    if (CAPACITY_METRICS.has(metric) && !capacityOk()) {
      $("#heatTitle").textContent = `${m.label} by market and ${state.grain}`;
      return emptyChart("chHeat", "Utilization isn't defined for a corporate group or shift type (idle vet days carry neither). Pick Fill rate or Gross margin %, or clear those filters.");
    }
    $("#heatTitle").textContent = `${m.label} by market and ${state.grain}`;
    const byMarket = K.groupBy(schedFiltered("market"), "market");
    const markets = [...byMarket.keys()].sort().reverse();
    const pts = [];
    markets.forEach((mk, y) => ctx.trend.forEach((t, x) => {
      const v = K[metric](K.inRange(byMarket.get(mk), t.range[0], t.range[1]));
      pts.push([x, y, v == null ? "-" : v]);
    }));
    const vals = pts.map((p) => p[2]).filter((v) => v !== "-");
    if (!vals.length) return emptyChart("chHeat", "No data in this selection.");
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const sel = state.filters.market;
    const showLabels = ctx.trend.length <= 16;
    const ch = chart("chHeat");
    ch.setOption(Object.assign(base(c), {
      grid: { left: 8, right: 16, top: 8, bottom: 50, containLabel: true },
      tooltip: Object.assign(base(c).tooltip, { trigger: "item", formatter: (p) => {
        const t = ctx.trend[p.value[0]];
        return `<b>${esc(markets[p.value[1]])}</b> · ${esc(bucketLabel(t.key, state.grain, true))}${t.partial ? " (partial)" : ""}<br>${m.label}: <b>${p.value[2] === "-" ? "—" : m.fmt(p.value[2])}</b>`;
      } }),
      xAxis: Object.assign(axisCommon(c), { type: "category", data: ctx.trend.map((t) => bucketLabel(t.key, state.grain) + (t.partial ? "*" : "")), splitArea: { show: false }, axisLabel: { color: c.muted, fontSize: 10.5, interval: 0, rotate: ctx.trend.length > 16 ? 45 : 0 } }),
      yAxis: Object.assign(axisCommon(c), { type: "category", data: markets, axisLabel: { color: c.ink, fontWeight: 600, fontSize: 11.5,
        formatter: (v) => (sel.size && !sel.has(v) ? "{f|" + v + "}" : v), rich: { f: { color: c.muted, opacity: 0.6 } } } }),
      visualMap: { min: lo, max: hi, calculable: false, orient: "horizontal", left: "center", bottom: 0, itemWidth: 10, itemHeight: 160,
        textStyle: { color: c.muted, fontSize: 10 }, formatter: (v) => m.fmt(v),
        inRange: { color: metric === "grossMarginPct" || metric === "utilization" || metric === "fillRate" ? [c.alert, c.dark ? "#2A4A52" : "#F3F8F4", c.primary] : [c.tint, c.primary] } },
      series: [{ type: "heatmap", data: pts, itemStyle: { borderColor: c.card, borderWidth: 2, borderRadius: 3 },
        label: { show: showLabels, fontSize: 10, fontWeight: 700, formatter: (p) => (p.value[2] === "-" ? "" : m.fmt(p.value[2])),
          color: c.ink },
        emphasis: { itemStyle: { borderColor: c.ink, borderWidth: 1 } } }],
    }), true);
    // White labels on the darkest cells for contrast
    if (showLabels) ch.setOption({ series: [{ data: pts.map((p) => ({ value: p, label: { color: p[2] !== "-" && (p[2] - lo) / ((hi - lo) || 1) > 0.72 ? "#fff" : c.ink } })) }] });
    ch.off("click");
    ch.on("click", (p) => {
      const t = ctx.trend[p.value[0]], mk = markets[p.value[1]];
      tap("market", mk, { filterable: true, drill: { range: t.range, rangeLabel: bucketLabel(t.key, state.grain, true) } });
    });
  }

  // ---------------------------------------------------------------------------
  // Demand & fill
  // ---------------------------------------------------------------------------
  function renderDemand(ctx) {
    const c = C();
    // Fill rate by shift type (+ unfilled $)
    const selST = state.filters.shift_type;
    const rowsST = ctx.curExcept("shift_type");
    const st = K.breakdown(rowsST, "shift_type").filter((s) => s.netRequests > 0).sort((a, b) => b.fillRate - a.fillRate);
    const overall = K.fillRate(rowsST);
    const ch = chart("chShift");
    if (!st.length) emptyChart("chShift", "No hospital requests in this selection.");
    else {
      ch.setOption(Object.assign(base(c), {
        grid: { left: 8, right: 18, top: 24, bottom: 4, containLabel: true },
        tooltip: Object.assign(base(c).tooltip, { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (p) => {
          const s = st[p[0].dataIndex];
          return `<b>${esc(s.key)}</b><br>Fill rate: <b>${F.pct(s.fillRate)}</b> (overall ${F.pct(overall)})<br>Net requests: ${F.num(s.netRequests)}<br>Unfilled demand: <b>${F.money(s.unfilledDemand)}</b>`;
        } }),
        xAxis: Object.assign(axisCommon(c), { type: "value", max: 1, axisLabel: { color: c.muted, fontSize: 10, formatter: (v) => F.pct(v, 0) } }),
        // Left axis: shift types. Right axis: unfilled $ as its own column, so labels never collide with the bars.
        yAxis: [
          Object.assign(axisCommon(c), { type: "category", data: st.map((s) => s.key), inverse: true, axisLabel: { color: c.ink, fontWeight: 600, fontSize: 11.5 } }),
          Object.assign(axisCommon(c), { type: "category", data: st.map((s) => s.key), inverse: true, position: "right", axisLine: { show: false },
            name: "Unfilled", nameLocation: "start", nameGap: 8, nameTextStyle: { color: c.muted, fontSize: 10, fontWeight: 700, align: "left", padding: [0, 0, 0, 6] },
            axisLabel: { color: c.alert, fontWeight: 700, fontSize: 11, formatter: (v, i) => F.money(st[i].unfilledDemand) } }),
        ],
        series: [
          { name: "Fill rate", type: "bar", barMaxWidth: 18, data: st.map((s) => ({ value: s.fillRate, itemStyle: { color: s.fillRate < overall - 0.1 ? c.alert : c.secondary, opacity: fade(selST.has(s.key), selST.size), borderRadius: [0, 3, 3, 0] } })),
            label: { show: true, position: "insideRight", color: "#fff", fontWeight: 800, fontSize: 10.5, formatter: (p) => F.pct(p.value, 0) },
            markLine: { silent: true, symbol: "none", lineStyle: { type: "dashed", color: c.ink, width: 1.5 }, label: { formatter: "Overall " + F.pct(overall, 0), color: c.ink, fontSize: 10, fontWeight: 700, position: "start" }, data: [{ xAxis: overall }] } },
        ],
      }), true);
      ch.off("click");
      ch.on("click", (p) => tap("shift_type", st[p.dataIndex].key, { filterable: true }));
    }

    // Unfilled demand by lead time
    const lt = K.byLeadTime(ctx.cur);
    const chL = chart("chLead");
    chL.setOption(Object.assign(base(c), {
      legend: legend(c, { data: ["Unfilled $", "Fill rate"] }),
      tooltip: Object.assign(base(c).tooltip, { trigger: "axis", formatter: (p) => {
        const b = lt[p[0].dataIndex];
        return `<b>${esc(b.bucket)} notice</b><br>Requests: ${F.num(b.requests)}<br>Unfilled demand: <b>${F.money(b.unfilledDemand)}</b><br>Fill rate: <b>${F.pct(b.fillRate)}</b>`;
      } }),
      xAxis: Object.assign(axisCommon(c), { type: "category", data: lt.map((b) => b.bucket.replace(" days", "d")), name: "Lead time", nameLocation: "middle", nameGap: 26, nameTextStyle: { color: c.muted, fontSize: 10 } }),
      yAxis: [Object.assign(axisCommon(c), { type: "value", axisLabel: { color: c.muted, fontSize: 10, formatter: F.money } }),
        Object.assign(axisCommon(c), { type: "value", max: 1, splitLine: { show: false }, axisLabel: { color: c.muted, fontSize: 10, formatter: (v) => F.pct(v, 0) } })],
      grid: { left: 8, right: 12, top: 30, bottom: 22, containLabel: true },
      series: [
        { name: "Unfilled $", type: "bar", barMaxWidth: 34, data: lt.map((b) => b.unfilledDemand), itemStyle: { color: c.alert, borderRadius: [4, 4, 0, 0] } },
        { name: "Fill rate", type: "line", yAxisIndex: 1, data: lt.map((b) => b.fillRate), symbolSize: 7, lineStyle: { width: 2.5, color: c.primary }, itemStyle: { color: c.primary } },
      ],
    }), true);
    chL.off("click");
    chL.on("click", (p) => tap("lead_bucket", lt[p.dataIndex].bucket, { crumbs: [{ dim: "lead_bucket", key: lt[p.dataIndex].bucket }] }));

    // Cancellation rate by corporate group over time
    const selCG = state.filters.corporate_group;
    const byG = K.groupBy(schedFiltered("corporate_group"), "corporate_group");
    const groups = [...byG.keys()].filter(Boolean).sort();
    // Daily cancellation rates are too sparse to read, so the Day view rolls this chart up to weeks.
    const cGrain = state.grain === "day" ? "week" : state.grain;
    let cBuckets = ctx.trend;
    if (cGrain !== state.grain) {
      const weeks = data.buckets.length ? K.listBuckets(data.min, data.max, cGrain) : [];
      const end = weeks.indexOf(K.bucketKey(ctx.range[1], cGrain));
      cBuckets = weeks.slice(Math.max(0, end - GRAIN_N[cGrain] + 1), end + 1).map((k) => (
        { key: k, range: K.effectiveRange(k, cGrain, data.min, data.max), partial: isPartial(k, cGrain) }));
    }
    $("#cancelTitle").textContent = "Hospital cancellation rate by group" + (cGrain !== state.grain ? " (weekly)" : "");
    const chC = chart("chCancel");
    chC.setOption(Object.assign(base(c), {
      color: c.palette,
      legend: legend(c, { type: "plain", width: "100%", itemGap: 8 }),
      grid: { left: 8, right: 14, top: 58, bottom: 4, containLabel: true },
      tooltip: Object.assign(base(c).tooltip, { trigger: "axis", valueFormatter: (v) => F.pct(v) }),
      xAxis: Object.assign(axisCommon(c), { type: "category", boundaryGap: false, data: cBuckets.map((t) => bucketLabel(t.key, cGrain) + (t.partial ? "*" : "")) }),
      yAxis: Object.assign(axisCommon(c), { type: "value", axisLabel: { color: c.muted, fontSize: 10, formatter: (v) => F.pct(v, 0) } }),
      series: groups.map((g) => ({
        name: g, type: "line", smooth: 0.2, symbolSize: 5, connectNulls: true,
        lineStyle: { width: selCG.has(g) ? 3.5 : 2, opacity: fade(selCG.has(g), selCG.size) }, itemStyle: { opacity: fade(selCG.has(g), selCG.size) },
        data: cBuckets.map((t) => K.cancellationRate(K.inRange(byG.get(g), t.range[0], t.range[1]))),
      })),
    }), true);
    chC.off("click");
    chC.on("click", (p) => tap("corporate_group", p.seriesName, { filterable: true }));
  }

  // ---------------------------------------------------------------------------
  // Hospitals table
  // ---------------------------------------------------------------------------
  const HOSP_COLS = [
    { k: "name", l: "Hospital", left: true, f: esc }, { k: "market", l: "Market", left: true, f: esc }, { k: "group", l: "Corporate Group", left: true, f: esc },
    { k: "revenue", l: "Revenue", f: F.money }, { k: "grossMarginPct", l: "GM %", f: F.pct }, { k: "workedDays", l: "Worked Days", f: F.num },
    { k: "fillRate", l: "Fill Rate", f: F.pct }, { k: "cancellationRate", l: "Cancel Rate", f: F.pct },
    { k: "unfilledDemand", l: "Unfilled $", f: F.money }, { k: "avgVetRating", l: "Vet Rating", f: (v) => F.num(v, 1) },
  ];
  function renderHospitals(ctx) {
    const rows = K.breakdown(ctx.cur, "hospital_id").map((h) => Object.assign(h, data.hosp.get(h.key) || {}));
    const { key, dir } = state.hospSort;
    rows.sort((a, b) => {
      const x = a[key], y = b[key];
      if (x == null) return 1; if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
    });
    const top = rows.slice(0, state.hospTop);
    $("#tblHosp").innerHTML = `<table class="t"><thead><tr><th class="l">#</th>${HOSP_COLS.map((col) =>
      `<th class="sortable${col.left ? " l" : ""}" data-k="${col.k}">${col.l}${key === col.k ? `<span class="arrow">${dir < 0 ? "▼" : "▲"}</span>` : ""}</th>`).join("")}</tr></thead>
      <tbody>${top.map((h, i) => `<tr class="clickable" data-id="${esc(h.key)}"><td class="l muted">${i + 1}</td>${HOSP_COLS.map((col) => `<td class="${col.left ? "l" : ""}">${col.f(h[col.k])}</td>`).join("")}</tr>`).join("")}</tbody></table>
      <div class="hint" style="margin-top:6px">${F.num(rows.length)} hospitals in this selection.</div>`;
    $$("#tblHosp th.sortable").forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.k;
      state.hospSort = { key: k, dir: state.hospSort.key === k ? -state.hospSort.dir : (HOSP_COLS.find((x) => x.k === k).left ? 1 : -1) };
      renderHospitals(state.ctx);
    }));
    $$("#tblHosp tr.clickable").forEach((tr) => tr.addEventListener("click", () => tap("hospital_id", tr.dataset.id, {})));
  }

  // ---------------------------------------------------------------------------
  // Funnels
  // ---------------------------------------------------------------------------
  const stat = (l, v) => `<div class="stat"><div class="s-l">${esc(l)}</div><div class="s-v">${v}</div></div>`;
  function funnelBars(id, stages, c, colors) {
    const ch = chart(id);
    ch.setOption(Object.assign(base(c), {
      grid: { left: 8, right: 110, top: 4, bottom: 4, containLabel: true },
      tooltip: Object.assign(base(c).tooltip, { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (p) => {
        const i = p[0].dataIndex, s = stages[i];
        return `<b>${esc(s.stage)}</b><br>${F.num(s.count)}` + (s.conv != null ? `<br>${F.pct(s.conv)} of previous stage` : "");
      } }),
      xAxis: { type: "value", show: false },
      yAxis: Object.assign(axisCommon(c), { type: "category", inverse: true, data: stages.map((s) => s.stage), axisLabel: { color: c.ink, fontWeight: 600, fontSize: 11.5 } }),
      series: [{ type: "bar", barMaxWidth: 22, data: stages.map((s, i) => ({ value: s.count, itemStyle: { color: colors(i, s), borderRadius: [0, 4, 4, 0] } })),
        label: { show: true, position: "right", color: c.ink, fontSize: 11, fontWeight: 700,
          formatter: (p) => { const s = stages[p.dataIndex]; return F.num(s.count) + (s.conv != null ? `  {m|${F.pct(s.conv, 0)} conv.}` : ""); },
          rich: { m: { color: c.muted, fontWeight: 600, fontSize: 10.5 } } } }],
    }), true);
  }
  function renderFunnels() {
    const c = C();
    const vp = pipeFiltered(data.vetP), hp = pipeFiltered(data.hospP);
    const vf = K.vetFunnel(vp);
    $("#vetStats").innerHTML = stat("Offer acceptance", F.pct(vf.offerAcceptanceRate)) + stat("Accepted hires", F.num(vf.hires)) +
      stat("Cost per hire", F.money(vf.costPerHire)) + stat("Recruiting spend", F.money(vf.recruitingCost));
    const vs = vf.stages.map((s, i) => Object.assign({}, s, { conv: i ? K.div(s.count, vf.stages[i - 1].count) : null }));
    const shade = [c.primary, c.primary, c.secondary, c.secondary, c.accent, c.accent];
    funnelBars("chVetFunnel", vs, c, (i) => shade[i]);

    const sf = K.salesFunnel(hp);
    $("#salesStats").innerHTML = stat("Win rate", F.pct(sf.winRate)) + stat("Won", F.num(sf.won)) + stat("Open pipeline", F.num(sf.open)) + stat("Lost", F.num(sf.lost));
    const ss = sf.stages.concat([{ stage: "Closed - Lost", count: sf.lost }]);
    funnelBars("chSalesFunnel", ss, c, (i, s) => (s.stage === "Closed - Lost" ? c.muted : [c.primary, c.primary, c.secondary, c.accent, c.accent][i]));

    // Recruiting by source
    const src = K.funnelBySource(vp);
    $("#tblSource").innerHTML = `<table class="t"><thead><tr><th class="l">Source</th><th>Applicants</th><th>Offer Accept.</th><th>Hires</th><th>Spend</th><th>Cost / Hire</th></tr></thead><tbody>
      ${src.map((s) => `<tr><td class="l">${esc(s.source)}</td><td>${F.num(s.applicants)}</td><td>${F.pct(s.offerAcceptanceRate)}</td><td>${F.num(s.hires)}</td><td>${F.money(s.recruitingCost)}</td><td>${F.money(s.costPerHire)}</td></tr>`).join("")}</tbody></table>`;

    // New hospitals live vs budget
    const budByMonth = {};
    for (const b of budgetFiltered()) budByMonth[b.month] = (budByMonth[b.month] || 0) + (b.budget_new_hospitals || 0);
    const months = [...new Set([...Object.keys(sf.liveByMonth), ...Object.keys(budByMonth)])].sort();
    const chLv = chart("chLive");
    chLv.setOption(Object.assign(base(c), {
      legend: legend(c, { data: ["Hospitals live", "Budget"] }),
      tooltip: Object.assign(base(c).tooltip, { trigger: "axis" }),
      xAxis: Object.assign(axisCommon(c), { type: "category", data: months.map((m) => bucketLabel(m, "month") + (m === data.max?.slice(0, 7) && isPartial(m, "month") ? "*" : "")) }),
      yAxis: Object.assign(axisCommon(c), { type: "value", minInterval: 1 }),
      series: [
        { name: "Hospitals live", type: "bar", barMaxWidth: 34, data: months.map((m) => sf.liveByMonth[m] || 0), itemStyle: { color: c.accent, borderRadius: [4, 4, 0, 0] },
          label: { show: true, position: "top", color: c.ink, fontSize: 10, fontWeight: 700 } },
        { name: "Budget", type: "line", data: months.map((m) => (m in budByMonth ? budByMonth[m] : null)), symbolSize: 7, lineStyle: { type: "dashed", width: 2, color: c.primary }, itemStyle: { color: c.primary } },
      ],
    }), true);

    // Rep leaderboard
    const reps = K.repLeaderboard(hp);
    $("#tblReps").innerHTML = `<table class="t"><thead><tr><th class="l">#</th><th class="l">Sales Rep</th><th>Leads</th><th>Open</th><th>Won</th><th>Lost</th><th>Win Rate</th><th>Live</th></tr></thead><tbody>
      ${reps.map((r, i) => `<tr><td class="l muted">${i + 1}</td><td class="l">${esc(r.rep)}</td><td>${F.num(r.leads)}</td><td>${F.num(r.open)}</td><td>${F.num(r.won)}</td><td>${F.num(r.lost)}</td><td>${F.pct(r.winRate)}</td><td>${F.num(r.live)}</td></tr>`).join("")}</tbody></table>`;
  }

  // ---------------------------------------------------------------------------
  // Definitions & data sources
  // ---------------------------------------------------------------------------
  const DEFS = [
    ["Revenue", "Sum of Revenue", "Schedule rows. Includes cancellation fees (50% of rate when canceled with < 7 days' notice)."],
    ["Gross Margin %", "Sum of Gross Margin ÷ Sum of Revenue", "Gross Margin = Revenue − Total Direct Cost."],
    ["Utilization", "Count(Worked = 1 and Salaried Day = 1) ÷ (Sum of Salaried Day − Count of PTO)", "Booked share of paid vet capacity. Hidden for corporate group, shift type and hospital slices: idle and PTO days carry none of those."],
    ["Fill Rate", "Sum of Filled ÷ (Sum of Requested by Hospital − Sum of Canceled by Hospital)", "Share of hospital demand covered."],
    ["Unfilled Demand $", "Sum of (Bill Rate + Premium Billed) where Shift Status = Unfilled", "Lost revenue."],
    ["Paid Idle Cost", "Sum of Total Direct Cost where Shift Status = Paid Idle", "Salary paid with no shift booked."],
    ["Cancellation Rate", "Sum of Canceled by Hospital ÷ Count(Worked, Hospital Canceled, Sick Callout)", "Hospital cancellations of booked shifts."],
    ["Revenue / Worked Day", "Sum of Revenue ÷ Sum of Worked", ""],
    ["Active Vets", "Distinct Vet ID with Salaried Day = 1", "In the selected period."],
    ["Customer Concentration", "Revenue by Corporate Group ÷ Total Revenue", ""],
    ["Budget Variance", "Actual (Schedule) − Budget, by market", "Monthly budget pro-rated by business day (Mon–Fri; weekends are ~2.5% of revenue). A budget month covers days up to the latest schedule date. Active vets compare to the latest budget month."],
    ["Offer Acceptance", "Accepted ÷ (Accepted + Declined)", "Pending offers excluded."],
    ["Cost per Hire", "Sum of Recruiting Cost ÷ Accepted offers", "Accepted offers include future starts."],
    ["Win Rate", "(Agreement Signed + Active) ÷ (those + Closed - Lost)", "Hospital pipeline, latest snapshot."],
    ["Prior-period deltas", "Rates: difference in points. Dollars: change in per-business-day run rate.", "Keeps partial periods (e.g., Oct 1–16) comparable."],
  ];
  function renderDefs() {
    $("#tblDefs").innerHTML = `<table class="t"><thead><tr><th class="l">KPI</th><th class="l">Formula</th><th class="l">Notes</th></tr></thead><tbody>
      ${DEFS.map(([k, f, n]) => `<tr><td class="l"><b>${k}</b></td><td class="l wrap formula">${esc(f)}</td><td class="l wrap muted">${esc(n)}</td></tr>`).join("")}</tbody></table>`;
    const types = ["SCHEDULE", "BUDGET", "VET_PIPELINE", "HOSPITAL_PIPELINE"];
    const all = [...state.manifestSources, ...state.droppedSources];
    $("#dataSources").innerHTML = `<ul class="sources">${all.map((s, i) => `<li><span>${esc(s.name)}<br><span class="tag">${s.origin === "manifest" ? "From data/manifest.json" : "Added in this browser"}</span></span>
        <span>${F.num(s.rows.length)} rows${s.origin === "dropped" ? ` <button class="btn btn-sm btn-ghost" data-drop="${i - state.manifestSources.length}">Remove</button>` : ""}</span></li>`).join("")}</ul>
      <dl class="kv">
        <dt>Unique records</dt><dd>${F.num(state.rows.length)}</dd>
        <dt>Duplicates removed (by Record ID)</dt><dd>${F.num(state.dupes)}</dd>
        ${types.map((t) => `<dt>${esc(L.valueLabel("record_type", t))} rows</dt><dd>${F.num(K.ofType(state.rows, t).length)}</dd>`).join("")}
        <dt>Schedule dates</dt><dd>${data.min ? rangeText([data.min, data.max]) + ", " + data.max.slice(0, 4) : "—"}</dd>
      </dl>`;
    $$("#dataSources [data-drop]").forEach((b) => b.addEventListener("click", () => {
      const s = state.droppedSources.splice(Number(b.dataset.drop), 1)[0];
      rebuild(); renderAll(); toast(`Removed ${s.name}`);
    }));
  }

  // ---------------------------------------------------------------------------
  // Drill-down drawer
  // ---------------------------------------------------------------------------
  const DRILL_BY = ["market", "region", "hospital_id", "corporate_group", "hospital_type", "vet_id", "shift_type", "placement_type",
    "shift_status", "lead_bucket", "day_of_week", "vet_program_days", "__day", "__week", "__month"];
  const NEXT_DIM = { "": "market", market: "hospital_id", region: "market", corporate_group: "hospital_id", hospital_type: "hospital_id",
    hospital_id: "vet_id", vet_id: "hospital_id", shift_type: "market", placement_type: "market", shift_status: "market",
    lead_bucket: "shift_type", day_of_week: "market", vet_program_days: "vet_id", __day: "market", __week: "market", __month: "market", __period: "market" };
  const drill = { open: false, crumbs: [], range: null, rangeLabel: "", by: "market", metric: "revenue", dir: "desc", top: 10, tab: "rank" };

  function nextDim(crumbs) {
    const used = new Set(crumbs.map((c) => c.dim));
    const last = crumbs.length ? crumbs[crumbs.length - 1].dim : "";
    let d = NEXT_DIM[last] || "market";
    if (used.has(d)) d = DRILL_BY.find((x) => !used.has(x));
    return d;
  }
  function openDrill(crumbs, opts = {}) {
    drill.crumbs = crumbs.map((c) => ({ dim: c.dim, key: c.key }));
    drill.range = opts.range || state.ctx.range;
    drill.rangeLabel = opts.rangeLabel || state.ctx.label;
    if (opts.metric) drill.metric = opts.metric;
    drill.by = opts.by || nextDim(drill.crumbs);
    drill.tab = "rank";
    drill.open = true;
    $("#drawer").classList.add("open"); $("#drawer").setAttribute("aria-hidden", "false");
    $("#drawerScrim").hidden = false;
    renderDrill();
  }
  function closeDrill() {
    drill.open = false;
    $("#drawer").classList.remove("open"); $("#drawer").setAttribute("aria-hidden", "true");
    $("#drawerScrim").hidden = true;
  }
  function drillRows() {
    const preds = drill.crumbs.map((c) => (r) => String(DIMS[c.dim].get(r)) === String(c.key));
    return K.inRange(schedFiltered(), drill.range[0], drill.range[1]).filter((r) => preds.every((p) => p(r)));
  }
  function renderDrill() {
    if (!drill.open) return;
    const rows = drillRows();
    // Breadcrumbs
    $("#drillCrumbs").innerHTML = [`<button data-i="0">All</button>`]
      .concat(drill.crumbs.map((c, i) => `<span>›</span><button data-i="${i + 1}">${esc(DIMS[c.dim].label)}: ${esc(dimName(c.dim, c.key))}</button>`)).join(" ");
    $$("#drillCrumbs button").forEach((b) => b.addEventListener("click", () => {
      drill.crumbs = drill.crumbs.slice(0, Number(b.dataset.i)); drill.by = nextDim(drill.crumbs); renderDrill();
    }));
    const last = drill.crumbs[drill.crumbs.length - 1];
    $("#drillTitle").textContent = last ? dimName(last.dim, last.key) : "All markets";
    const gf = FILTER_DIMS.filter((d) => state.filters[d].size).map((d) => `${DIMS[d].label}: ${[...state.filters[d]].join(", ")}`);
    $("#drillSub").textContent = `${drill.rangeLabel} (${rangeText(drill.range)})` + (gf.length ? " · Page filters: " + gf.join(" · ") : "") + ` · ${F.num(rows.length)} source rows`;

    // Capacity metrics only make sense when the slice still includes idle / PTO vet days.
    const capOk = capacityOk() && !drill.crumbs.some((c) => HOSPITAL_SIDE.has(c.dim));
    const byCap = capOk && !HOSPITAL_SIDE.has(drill.by);
    const k = K.scheduleKpis(rows);
    $("#drillKpis").innerHTML = ["revenue", "grossMarginPct", "utilization", "fillRate", "unfilledDemand", "paidIdleCost", "cancellationRate", "activeVets"]
      .map((m) => (CAPACITY_METRICS.has(m) && !capOk
        ? `<div class="stat" title="${esc(NA_NOTE)}"><div class="s-l">${esc(METRICS[m].label)}</div><div class="s-v neutral">n/a</div></div>`
        : stat(METRICS[m].label, METRICS[m].fmt(k[m])))).join("");

    $$("#drillTabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === drill.tab));
    $("#drillRank").hidden = drill.tab !== "rank";
    $("#drillRows").hidden = drill.tab !== "rows";

    if (drill.tab === "rank") {
      const used = new Set(drill.crumbs.map((c) => c.dim));
      $("#drillBy").innerHTML = DRILL_BY.filter((d) => !used.has(d) || d === drill.by).map((d) => `<option value="${d}">${esc(DIMS[d].label)}</option>`).join("");
      $("#drillBy").value = drill.by;
      if (!byCap && CAPACITY_METRICS.has(drill.metric)) drill.metric = "revenue";
      $("#drillMetric").innerHTML = Object.keys(METRICS).filter((m) => byCap || !CAPACITY_METRICS.has(m))
        .map((m) => `<option value="${m}">${esc(METRICS[m].label)}</option>`).join("");
      $("#drillMetric").value = drill.metric;
      $("#drillDir").value = drill.dir; $("#drillTop").value = String(drill.top);
      const bd = K.breakdown(rows, DIMS[drill.by].get).filter((b) => b[drill.metric] != null);
      const m = METRICS[drill.metric];
      bd.sort((a, b) => (drill.dir === "desc" ? b[drill.metric] - a[drill.metric] : a[drill.metric] - b[drill.metric]));
      const shown = bd.slice(0, drill.top);
      const maxAbs = Math.max(...shown.map((b) => Math.abs(b[drill.metric])), 1e-9);
      $("#drillList").innerHTML = shown.length ? shown.map((b, i) => `<li data-key="${esc(b.key)}">
          <span class="rk">${i + 1}</span>
          <div style="min-width:0"><div class="nm">${esc(dimName(drill.by, b.key))}</div>
            <div class="meta">Rev ${F.money(b.revenue)} · GM ${F.pct(b.grossMarginPct)}${byCap ? ` · Util ${F.pct(b.utilization)}` : ""} · Fill ${F.pct(b.fillRate)} · ${F.num(b.rows)} rows</div>
            <div class="barbg"><div class="barfill" style="width:${(Math.abs(b[drill.metric]) / maxAbs) * 100}%;${m.good < 0 ? "background:var(--alert)" : ""}"></div></div></div>
          <span class="val">${m.fmt(b[drill.metric])}</span><span class="go">›</span></li>`).join("")
        : `<li style="cursor:default"><span></span><span class="hint">No rows have a value for ${esc(m.label)} at this level.</span></li>`;
      $(".drill-hint").textContent = `${F.num(bd.length)} ${DIMS[drill.by].label.toLowerCase()} values. Click any row to drill another level deeper.`;
      $$("#drillList li[data-key]").forEach((li) => li.addEventListener("click", () => {
        const key = shown.find((b) => String(b.key) === li.dataset.key).key;
        drill.crumbs.push({ dim: drill.by, key });
        drill.by = nextDim(drill.crumbs);
        renderDrill();
        $("#drawer").scrollTop = 0;
      }));
    } else {
      const sorted = [...rows].sort((a, b) => (a.record_date < b.record_date ? 1 : -1));
      const cols = ["record_date", "market", "hospital_name", "corporate_group", "vet_name", "shift_type", "placement_type", "shift_status",
        "request_lead_time_days", "bill_rate", "premium_billed", "revenue", "total_direct_cost", "gross_margin"];
      const money = new Set(["bill_rate", "premium_billed", "revenue", "total_direct_cost", "gross_margin"]);
      const left = new Set(["record_date", "market", "hospital_name", "corporate_group", "vet_name", "shift_type", "placement_type", "shift_status"]);
      const cell = (col, v) => v == null ? "" : money.has(col) ? "$" + Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : col === "shift_status" ? esc(L.valueLabel(col, v)) : esc(v);
      $("#drillRowCount").textContent = `Showing ${F.num(Math.min(200, rows.length))} of ${F.num(rows.length)} rows (newest first). Export includes every column.`;
      $("#drillTable").innerHTML = `<table class="t"><thead><tr>${cols.map((c) => `<th class="${left.has(c) ? "l" : ""}">${esc(L.label(c))}</th>`).join("")}</tr></thead>
        <tbody>${sorted.slice(0, 200).map((r) => `<tr>${cols.map((c) => `<td class="${left.has(c) ? "l" : ""}">${cell(c, r[c])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    }
  }
  function exportDrill() {
    const rows = drillRows();
    const skip = new Set(["week_start", "lead_bucket"]);
    const cols = Object.keys(L.COLUMN_LABELS).filter((c) => !skip.has(c) && rows.some((r) => r[c] != null));
    const q = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const csv = [cols.map((c) => q(L.label(c))).join(",")].concat(rows.map((r) => cols.map((c) => q(r[c])).join(","))).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const last = drill.crumbs[drill.crumbs.length - 1];
    a.download = `demovets_drill_${(last ? dimName(last.dim, last.key) : "all").replace(/[^\w]+/g, "_")}_${drill.range[0]}_${drill.range[1]}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------------------------------------------------------------------
  // Orchestration
  // ---------------------------------------------------------------------------
  function renderAll() {
    if (!data.buckets.length) return;
    const ctx = makeCtx();
    state.ctx = ctx;
    renderHeader(); renderPeriodSelect(); syncMultiSelects(); renderChips();
    renderCards(ctx); renderInsights(ctx);
    renderTrend(ctx); renderDonut(ctx); renderMarkets(ctx); renderBudget(ctx);
    renderHeat(ctx); renderDemand(ctx); renderHospitals(ctx); renderFunnels(); renderDefs();
    renderDrill();
  }
  function setPeriod(key) {
    state.period = key;
    state.followLatest = key === data.buckets[data.buckets.length - 1];
    renderAll();
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 4200);
  }

  async function refresh(isFirst) {
    const btn = $("#btnRefresh");
    btn.classList.add("spinning"); btn.disabled = true;
    const before = state.rows.length, beforeLatest = data.latest;
    try {
      state.manifestSources = await fetchManifest();
      rebuild(); renderAll();
      if (!isFirst) {
        const added = state.rows.length - before;
        toast(`Refreshed: ${F.num(state.rows.length)} rows from ${state.manifestSources.length} file(s)` +
          (added ? ` (${added > 0 ? "+" : ""}${F.num(added)} rows)` : ", no new rows") +
          (data.latest !== beforeLatest ? ` · data now through ${shortDate(data.latest)}` : ""));
      }
    } catch (e) {
      console.error(e);
      toast("Couldn't load data: " + e.message + ". You can still drag a CSV onto the page.");
      $("#loadedSummary").textContent = "Data failed to load";
    } finally {
      btn.classList.remove("spinning"); btn.disabled = false;
    }
  }

  async function addFiles(fileList) {
    const files = [...fileList].filter((f) => /\.csv$/i.test(f.name) || f.type === "text/csv");
    if (!files.length) return toast("Please drop a .csv file.");
    for (const f of files) {
      const rows = parseCsv(await f.text());
      if (!rows.length || !("record_id" in rows[0]) || !("record_type" in rows[0])) { toast(`${f.name}: missing record_id / record_type columns.`); continue; }
      const before = state.rows.length;
      state.droppedSources.push({ name: f.name, origin: "dropped", rows });
      rebuild(); renderAll();
      const added = state.rows.length - before;
      toast(`Added ${f.name}: ${F.num(added)} new rows${rows.length - added ? `, ${F.num(rows.length - added)} duplicates skipped` : ""} · data through ${shortDate(data.latest)}`);
    }
  }

  function applyCollapsed() {
    for (const sec of $$(".group")) {
      const id = sec.dataset.group, head = sec.querySelector(".group-head");
      head.setAttribute("aria-expanded", state.collapsed[id] ? "false" : "true");
    }
    const anyOpen = $$(".group-head").some((h) => h.getAttribute("aria-expanded") === "true");
    $("#btnCollapse").textContent = anyOpen ? "Collapse all" : "Expand all";
  }
  function resizeIn(el) { $$(".chart, .spark", el).forEach((c) => charts[c.id] && charts[c.id].resize()); }

  function wire() {
    $("#btnRefresh").addEventListener("click", () => refresh(false));
    $("#btnAdd").addEventListener("click", () => $("#fileInput").click());
    $("#fileInput").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
    $("#btnClear").addEventListener("click", () => { FILTER_DIMS.forEach((d) => state.filters[d].clear()); renderAll(); });
    $("#selGrain").addEventListener("change", (e) => {
      const anchor = state.ctx ? state.ctx.range[1] : null;
      state.grain = e.target.value; store.set("iv-grain", state.grain);
      setBuckets(anchor); renderAll();
    });
    $("#selPeriod").addEventListener("change", (e) => setPeriod(e.target.value));
    $("#btnTheme").addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("iv-theme", next); } catch (e) { /* ignore */ }
      renderAll();
    });
    $$(".group-head").forEach((h) => h.addEventListener("click", () => {
      const sec = h.closest(".group"), id = sec.dataset.group;
      state.collapsed[id] = h.getAttribute("aria-expanded") === "true";
      store.set("iv-collapsed", state.collapsed);
      applyCollapsed();
      if (!state.collapsed[id]) requestAnimationFrame(() => resizeIn(sec));
    }));
    $("#btnCollapse").addEventListener("click", () => {
      const collapse = $("#btnCollapse").textContent === "Collapse all";
      $$(".group").forEach((s) => { state.collapsed[s.dataset.group] = collapse; });
      store.set("iv-collapsed", state.collapsed);
      applyCollapsed();
      if (!collapse) requestAnimationFrame(() => resizeIn(document));
    });
    $$("#heatSeg button").forEach((b) => b.addEventListener("click", () => {
      state.heatMetric = b.dataset.m;
      $$("#heatSeg button").forEach((x) => x.classList.toggle("on", x === b));
      renderHeat(state.ctx);
    }));
    $("#selHospTop").addEventListener("change", (e) => { state.hospTop = Number(e.target.value); renderHospitals(state.ctx); });

    // Drill drawer
    $("#drillClose").addEventListener("click", closeDrill);
    $("#drawerScrim").addEventListener("click", closeDrill);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drill.open) closeDrill(); });
    $$("#drillTabs button").forEach((b) => b.addEventListener("click", () => { drill.tab = b.dataset.t; renderDrill(); }));
    $("#drillBy").addEventListener("change", (e) => { drill.by = e.target.value; renderDrill(); });
    $("#drillMetric").addEventListener("change", (e) => { drill.metric = e.target.value; renderDrill(); });
    $("#drillDir").addEventListener("change", (e) => { drill.dir = e.target.value; renderDrill(); });
    $("#drillTop").addEventListener("change", (e) => { drill.top = Number(e.target.value); renderDrill(); });
    $("#drillExport").addEventListener("click", exportDrill);

    // Close multi-select menus on outside click
    document.addEventListener("click", (e) => {
      $$(".ms details[open]").forEach((d) => { if (!d.contains(e.target)) d.removeAttribute("open"); });
    });

    // Drag-and-drop anywhere on the page
    let dragDepth = 0;
    const overlay = $("#dropOverlay");
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; overlay.hidden = false; });
    window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.hidden = true; });
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); dragDepth = 0; overlay.hidden = true;
      addFiles(e.dataTransfer.files);
    });

    let rt;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => Object.values(charts).forEach((c) => c.resize()), 120); });
  }

  // Expose a tiny hook for automated checks (read-only).
  window.__dash = { state, data, get ctx() { return state.ctx; } };

  buildCards();
  applyCollapsed();
  wire();
  refresh(true);
})();
