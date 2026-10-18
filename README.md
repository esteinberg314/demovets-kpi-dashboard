# DemoVets | FP&A KPI Dashboard (Demo)

A static KPI dashboard for a fictional veterinary relief-staffing company. **All data is synthetic.** DemoVets is a fictional company.

- `index.html`, `css/`, `js/`: the page. It fetches every CSV listed in `data/manifest.json` at runtime, de-duplicates on `record_id` and recomputes everything.
- `js/kpis.js`: every KPI formula, in one commented module (see `README_data_dictionary.md` for the definitions).
- `js/labels.js`: the single raw-column → business-label mapping.
- `js/insights.js`: the auto-generated "What changed" call-outs.
- `validate.html`: recomputes the Q3 headline numbers with the same KPI module.
- `add_data.sh` / `reset_demo.sh`: append a CSV and push it live, or roll back to the Q3-only state.

Built by Ethan Steinberg with Claude.
