# GepukPrep AI: prototype

A web app that recommends how many portions of ayam gepuk to prepare each day, and how much of each ingredient (bahan) that needs. It was built for the TEB2023 Artificial Intelligence group project.

This version starts like the original prototype, with **one dish** (Nasi Ayam Gepuk: chicken, rice, sambal). In the Data tab, or with the **+ Add menu item** button on Today, the owner can add more dishes, give each one a **% of orders**, and list its own ingredients and amounts per plate. The model still predicts total portions. The total is split by the % of orders, and ingredients are added up across dishes. Once 3 or more closing slips with sales per dish are saved, the % of orders is learned from those days.

## How to run
Open `index.html` in any browser. Nothing needs to be installed.
- The chart needs internet to load Chart.js. Everything else works offline.
- The live weather forecast (Open-Meteo) loads when it can. If it can't, the app assumes dry weather and the owner can change it.

## Files
| File | What it is |
|---|---|
| `index.html` | The screens and the design |
| `app.js` | The AI model, the rules and the screen logic, with comments |
| `data/sales.csv` | The dataset, one row per day (open it in Excel) |
| `data/sales.js` | The same data, in a form the page can load |
| `data/calendar.json` | Public holidays and UTP term dates |
| `data/rain_raw.json` | Real daily rainfall for Seri Iskandar from Open-Meteo |
| `data/generate.py` | Builds the dataset (run `python3 data/generate.py`) |

## What is real and what is simulated
The prototype follows the group's report only, and only the UTP academic calendar (76.7% of respondents study at UTP).

| Data | Status |
|---|---|
| Dates, day of week | Real |
| UTP periods | Real: UTP September 2026 calendar as in the report (lectures end 27 Nov, study break 28 Nov - 2 Dec, exams 3 - 15 Dec, semester break from 16 Dec) |
| Public holidays | Real (Perak 2026 list). The report sets no holiday multiplier, so a holiday has no effect; the owner adds a note instead. |
| Starting values | Report, Section 3.4: normal weekday 117 portions, weekend (Sat-Sun) ×1.24, rain ×0.85, study break ×0.95, exam week ×0.75, semester break ×0.40 |
| Recipe per plate | Report, Table 2: 1 chicken piece, 225 g rice (201-250 g), 28 g sambal (25-30 g) |
| Daily sales (30 days, 21 Nov - 20 Dec 2026) | **Simulated**: the report's table. Rainy days are the report's own choices. The five semester-break rows are recalculated with ×0.40 as the report text states (45, 45, 52, 62, 53). |

The History tab tests the model on the last 9 of the 30 days, which it never saw. **These are not real results**, because the data is simulated. Upload the shop's real records in the Data tab to get real results.

## How the AI works (for the report and presentation)
1. **Machine learning: linear regression** (the `train()` function in `app.js`)
   - The model learns: *portions = base × Friday × Saturday × Sunday × rain × UTP status*.
   - Each factor's multiplier is found by least squares on log(portions), meaning the numbers that best fit past sales. Nobody types these numbers in.
   - The model is **log-linear**: it learns a multiplier for each factor, the same form as the group's IF-THEN rules.
   - It is **hybrid**: each factor *starts* from the value in the report (Section 3.4) and moves towards what the shop's data shows. The study counts as 14 days of evidence (`STUDY_DAYS` in `app.js`). With little data the study decides; as the crew logs more days, the data takes over. The Data tab shows, for every factor, the study value, what the data alone says, the value used now, and how much weight the study still has.
   - **Sold-out correction:** on a sold-out day, sales are lower than real demand, so the model counts those days as 12% more than was sold.
2. **Testing**
   - The model learns from the first 70% of days and is tested on the last 30%, which it never saw.
   - The average error on those unseen days becomes the "expected to sell" range.
3. **IF-THEN rules**, only for things the model can't learn:
   - **Owner's note:** for an event or a public holiday, the owner chooses an adjustment, capped at ±25%.
   - **Low data:** fewer than 3 similar past days gives a low-confidence warning and a wider range.
   - **Kitchen limits:** the number is kept between the minimum and maximum portions.
   - **Safety buffer:** a percentage added last. A higher buffer means fewer sell-outs but more leftovers.
4. **Output**
   - Portions to prepare, multiplied by the recipe amounts to give the ingredients.
   - A "Why this number" list showing each step.
5. **Feedback loop**
   - Days saved in *Tutup kedai* are added to the data.
   - The model re-learns straight away.

Rain, weekends and UTP periods are learned by the model, not added again as fixed rules. Adding them as rules too would count their effect twice.

## Using the shop's real data
In the Data tab, use **Upload sales CSV**.

The file needs these columns, the same as `data/sales.csv`:
`date, holiday, weather, utp_status, portions_sold` (optional: `rain_mm, sold_out`)

## Limitations
- The app can't know about events, a new menu item, competitors or supply problems unless the owner types a note.
- With only a few weeks of real data, predictions will be rough.
- On sell-out days, "sold" is lower than real demand.
- Everything is saved only in that browser.
- It is an estimate to support the owner's judgement, not a guarantee.

## AI use declaration
The prototype code was written with an AI assistant (Claude). The study, the analysis, the report and the presentation are the group's own work.
