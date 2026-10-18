# DemoVets-Style KPI Dataset (SYNTHETIC)

**All data in these files is fake.** It was generated to resemble a veterinary relief-staffing business for a dashboard demo. DemoVets is a fictional company: no names, hospitals, rates or results are real.

## Files

| File | Rows | Covers |
|---|---|---|
| `demovets_synthetic_q3_2026.csv` | 10,142 | Jul 1 - Sep 30, 2026 (main dataset) |
| `demovets_synthetic_oct_2026_refresh.csv` | 1,923 | Oct 1 - Oct 16, 2026 (append this to demo a live data refresh) |

Both files have identical columns. To simulate a refresh, append the October file to the Q3 file (or drop it into the same data folder) and the dashboard should update.

## How the file is organized

One flat CSV. The `record_type` column tells you what each row is. **Always filter on `record_type` before calculating anything.**

| record_type | Grain (one row = ...) | Q3 rows |
|---|---|---|
| `SCHEDULE` | One vet-day or one hospital shift request | 9,549 |
| `BUDGET` | One market-month of plan figures | 30 |
| `VET_PIPELINE` | One vet candidate (recruiting funnel), status as of 9/30 | 316 |
| `HOSPITAL_PIPELINE` | One hospital sales lead, status as of 9/30 | 247 |

Columns that don't apply to a record type are blank.

### Business model behind the data
- Vets are W-2 employees on a guaranteed salary for a 1 to 5 day weekly program. DemoVets pays them on their salaried days **whether or not a shift is booked**.
- Hospitals request relief shifts and pay a daily bill rate (plus premiums for ER, surgery, dentistry, urgent care).
- So margin is driven by **utilization** (booked salaried days) and the **bill-pay spread**.

## SCHEDULE rows: `shift_status` values

| shift_status | What happened | Vet paid? | Revenue? |
|---|---|---|---|
| Worked | Vet worked a booked shift | Yes | Yes |
| Unbooked (Paid Idle) | Salaried day with no shift booked | Yes | No |
| PTO | Vet on paid time off | Yes | No |
| Sick Callout | Vet was booked but called out; hospital left uncovered | Yes | No |
| Canceled by Hospital | Hospital canceled a booked shift | Yes | Fee only if canceled with < 7 days notice (50% of rate) |
| Unfilled Request | Hospital asked for coverage, no vet available | No vet | No (bill_rate shows the lost revenue) |

`placement_type`: Relief (standard), Long-Term Placement (13 weeks at one hospital, +8% bill rate, +$60/day pay), Extra Shift (weekend shift a vet picked up on top of salary, paid $1,050 flat).

## Column dictionary

**Common:** `record_id`, `record_type`, `record_date` (shift date / budget month start / candidate application date / lead created date), `month` (YYYY-MM), `market`, `state`, `region`

**Vet:** `vet_id`, `vet_name`, `vet_program_days` (1-5), `vet_hire_date`, `vet_termination_date` (blank if active), `vet_hire_source`

**Hospital:** `hospital_id`, `hospital_name`, `hospital_type` (GP, Urgent Care, Emergency/Specialty), `corporate_group` (or Independent), `preferred_partner` (Y/N), `hospital_onboard_date`, `hospital_acquisition_source`

**Shift:** `day_of_week`, `shift_type` (GP, Surgery, Dentistry, Urgent Care, ER Day, ER Overnight), `placement_type`, `shift_status`, `request_lead_time_days` (days between request and shift; for cancellations, days of notice), `shift_hours`, `vet_rating_of_hospital` (1-5, worked shifts only)

**Flags (0/1):** `salaried_day_flag` (counts toward paid capacity), `worked_flag`, `requested_flag` (hospital asked for this shift), `filled_flag`, `hospital_canceled_flag`

**Money ($):** `bill_rate`, `premium_billed`, `cancellation_fee`, `revenue`, `vet_salary_cost` (daily share of salary), `premium_pay`, `extra_shift_pay`, `benefits_cost`, `total_direct_cost`, `gross_margin` (= revenue - total_direct_cost)

**Budget rows:** `budget_revenue`, `budget_worked_days`, `budget_gross_margin`, `budget_utilization_pct`, `budget_fill_rate_pct`, `budget_active_vets`, `budget_new_hospitals`. The October budget covers Oct 1-16 only, to match the partial month of actuals.

**Vet pipeline rows:** `candidate_id`, `candidate_source`, `screen_date`, `interview_date`, `offer_date`, `offer_status`, `pipeline_stage`, `recruiting_cost` (ad spend, agency fee, referral bonus, sign-on bonus). Hired candidates carry `vet_id` and `vet_hire_date`, which link to SCHEDULE rows.

**Hospital pipeline rows:** `lead_id`, `lead_source`, `lead_owner` (sales rep), `lead_stage`, `agreement_date`, `first_shift_date`. Converted leads carry `hospital_id` and `hospital_name`, which link to SCHEDULE rows.

## KPI definitions

| KPI | Formula (SCHEDULE rows unless noted) |
|---|---|
| Revenue | sum(revenue) |
| Gross margin % | sum(gross_margin) / sum(revenue) |
| Utilization | count(worked_flag=1 AND salaried_day_flag=1) / (sum(salaried_day_flag) - count(shift_status='PTO')) |
| Fill rate | sum(filled_flag) / (sum(requested_flag) - sum(hospital_canceled_flag)) |
| Unfilled demand ($) | sum(bill_rate + premium_billed) where shift_status = 'Unfilled Request' |
| Paid idle cost ($) | sum(total_direct_cost) where shift_status = 'Unbooked (Paid Idle)' |
| Hospital cancellation rate | sum(hospital_canceled_flag) / count(rows where vet was booked: Worked, Canceled, Sick) |
| Revenue per worked day | sum(revenue) / sum(worked_flag) |
| Customer concentration | revenue by corporate_group / total revenue |
| Active vets | distinct vet_id with salaried_day_flag = 1 in the period |
| Budget variance | actual (from SCHEDULE) vs. BUDGET rows, by market and month |
| Recruiting funnel | VET_PIPELINE counts by stage; offer acceptance rate; cost per hire = sum(recruiting_cost) / hires |
| Sales funnel | HOSPITAL_PIPELINE counts by stage; win rate; new hospitals live by month (first_shift_date) |

**Q3 headline (for sanity-checking your dashboard):** revenue about $8.73M, gross margin about 24.0%, utilization about 84.9%, fill rate about 81.3%, 168 vets, 10 markets.

## Built-in storylines (talking points for the demo)

1. **Atlanta over-hired.** Six vets were added Jul-Sep (plan was three) while demand stayed flat. Utilization fell from about 91% (Jul) to about 76% (Sep) and gross margin from about 27% to about 16%, because idle vets are still paid. A September sales push adds hospital leads, and utilization recovers to about 84% in the October file. *Lesson: balance vet hiring with hospital demand.*
2. **Boston can't hire enough.** Demand far exceeds supply. Fill rate is about 71-74%, two vets left in Q3 and the market had only 13 applicants with a weak offer acceptance rate. Revenue is 10-15% under budget while utilization is high. Two hires start in October. *Lesson: a supply problem, not a demand problem.*
3. **Denver launch is ramping slower than plan.** The new market opened in July. It has negative-to-thin margins early and revenue 20% under budget in July, improving to 9% under by September and about 86% utilization in October.
4. **Kansas City cancellations.** One corporate group (Driftwood Vet Partners) canceled about 36% of its booked September shifts. KC utilization drops to about 70% and margin to about 12%. It normalizes in October.
5. **Customer concentration creeping up.** Aldergrove Veterinary Group (a preferred partner at a 10% discount) grows from about 20% of revenue in July to about 31% in September. That's good volume, but it dilutes margin and adds concentration risk.
6. **ER shifts are the hardest to fill.** The ER fill rate is about 53% vs. about 81% overall. Unfilled requests skew to short notice (median 2 days lead time vs. about 49 days for filled shifts).
7. **Summer PTO.** Vet PTO peaks in August, which pressures utilization and coverage.
