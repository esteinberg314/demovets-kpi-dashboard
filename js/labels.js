/*
 * labels.js — the ONE mapping from raw CSV column names to business labels.
 * Every chart label, tooltip, filter and table header reads from here,
 * so raw snake_case names never reach the UI.
 */
(function (root) {
  const COLUMN_LABELS = {
    // Common
    record_id: "Record ID",
    record_type: "Record Type",
    record_date: "Date",
    month: "Month",
    market: "Market",
    state: "State",
    region: "Region",
    day_of_week: "Day of Week",
    // Vet
    vet_id: "Vet ID",
    vet_name: "Vet Name",
    vet_program_days: "Program Days / Week",
    vet_hire_date: "Vet Hire Date",
    vet_termination_date: "Vet Termination Date",
    vet_hire_source: "Vet Hire Source",
    // Hospital
    hospital_id: "Hospital ID",
    hospital_name: "Hospital",
    hospital_type: "Hospital Type",
    corporate_group: "Corporate Group",
    preferred_partner: "Preferred Partner",
    hospital_onboard_date: "Hospital Onboard Date",
    hospital_acquisition_source: "Hospital Acquisition Source",
    // Shift
    shift_type: "Shift Type",
    placement_type: "Placement Type",
    shift_status: "Shift Status",
    request_lead_time_days: "Lead Time (Days)",
    shift_hours: "Shift Hours",
    vet_rating_of_hospital: "Vet Rating of Hospital",
    // Flags
    salaried_day_flag: "Salaried Day",
    worked_flag: "Worked",
    requested_flag: "Requested by Hospital",
    filled_flag: "Filled",
    hospital_canceled_flag: "Canceled by Hospital",
    // Money
    bill_rate: "Bill Rate",
    premium_billed: "Premium Billed",
    cancellation_fee: "Cancellation Fee",
    revenue: "Revenue",
    vet_salary_cost: "Vet Salary Cost",
    premium_pay: "Premium Pay",
    extra_shift_pay: "Extra Shift Pay",
    benefits_cost: "Benefits Cost",
    total_direct_cost: "Total Direct Cost",
    gross_margin: "Gross Margin",
    // Budget
    budget_revenue: "Budget Revenue",
    budget_worked_days: "Budget Worked Days",
    budget_gross_margin: "Budget Gross Margin",
    budget_utilization_pct: "Budget Utilization",
    budget_fill_rate_pct: "Budget Fill Rate",
    budget_active_vets: "Budget Active Vets",
    budget_new_hospitals: "Budget New Hospitals",
    // Vet recruiting pipeline
    candidate_id: "Candidate ID",
    candidate_source: "Candidate Source",
    screen_date: "Phone Screen Date",
    interview_date: "Clinical Interview Date",
    offer_date: "Offer Date",
    offer_status: "Offer Status",
    pipeline_stage: "Recruiting Stage",
    recruiting_cost: "Recruiting Cost",
    // Hospital sales pipeline
    lead_id: "Lead ID",
    lead_source: "Lead Source",
    lead_owner: "Sales Rep",
    lead_stage: "Sales Stage",
    agreement_date: "Agreement Date",
    first_shift_date: "First Shift Date",
    // Derived in kpis.js
    week_start: "Week",
    lead_bucket: "Lead-Time Bucket",
  };

  // Display labels for categorical values (only where the raw value needs help).
  const VALUE_LABELS = {
    record_type: {
      SCHEDULE: "Schedule",
      BUDGET: "Budget",
      VET_PIPELINE: "Vet Pipeline",
      HOSPITAL_PIPELINE: "Hospital Pipeline",
    },
    shift_status: {
      "Unbooked (Paid Idle)": "Paid Idle",
      "Canceled by Hospital": "Hospital Canceled",
      "Unfilled Request": "Unfilled",
    },
    preferred_partner: { Y: "Yes", N: "No" },
  };

  const label = (col) => COLUMN_LABELS[col] || col.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const valueLabel = (col, v) => (VALUE_LABELS[col] && VALUE_LABELS[col][v]) || v;

  const api = { COLUMN_LABELS, VALUE_LABELS, label, valueLabel };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.IV_LABELS = api;
})(typeof window !== "undefined" ? window : globalThis);
