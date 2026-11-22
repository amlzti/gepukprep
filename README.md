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
| `data/calendar.json` | Public holidays and UTP/UiTM term dates |
| `data/rain_raw.json` | Real daily rainfall for Seri Iskandar from Open-Meteo |
| `data/generate.py` | Builds the dataset (run `python3 data/generate.py`) |

## What is real and what is simulated
| Data | Status |
|---|---|
| Dates, day of week | Real |
| Rainfall, 1 Mar to 21 Nov 2026 | **Real**: Open-Meteo archive, lat 4.3594, lon 100.9653. A day with 10 mm or more counts as rainy. |
| Public holidays | Real, compiled from public Perak 2026 listings. **Check these against the official gazette.** |
| UiTM lecture, exam and break dates | **Real**: official UiTM Group B calendar 2025/2026 and 2026/2027 (hea.uitm.edu.my) |
| UTP lecture, exam and break dates | **Real key dates** from the UTP Academic Calendar 2026. The other week boundaries follow UTP's official 12-week pattern (Academic Calendar 2027). If you have the 2026 PDF, check `data/calendar.json` against it. |
| Effect sizes | **Real**: the group's study (*AI-Gepuk_AI_Survey_Data_Analysis.xlsx*). Survey (n = 40, 77% UTP students): rain ×0.83, exam week ×0.75, study break ×0.96. Vendor interview: real sales for 7 days (Mon 118, Tue 122, Wed 120, Thu 124, Fri 133, Sat 141, Sun 136) and semester break about 40% fewer. Public holiday ×0.40 is the group's assumption. |
| Recipe per plate | **Real**: vendor interview, 1 chicken piece, 225 g rice, about 28 g sambal |
| Portions sold, owner's plan, leftovers | **Simulated** by `generate.py` from the study above: Mon–Thu 121, Fri ×1.10, Sat ×1.17, Sun ×1.12 (vendor's 7 days), UTP study break ×0.96, exam week ×0.75, semester break ×0.60, rain ×0.83, holiday ×0.40, ±6% daily noise. The owner plans from the last 7 days' customers plus 0–6%, as the vendor described ("based on previous days' sales"). |

The History tab's results show how the method would be evaluated. **They are not real savings**, because the model is learning from simulated data that we generated ourselves. Upload the shop's real records in the Data tab to get real results.

## How the AI works (for the report and presentation)
1. **Machine learning: linear regression** (the `train()` function in `app.js`)
   - The model learns: *portions = base × Friday × Saturday × Sunday × rain × holiday × UTP status × UiTM status*.
   - Each factor's multiplier is found by least squares on log(portions), meaning the numbers that best fit past sales. Nobody types these numbers in.
   - The model is **log-linear**: it learns a multiplier for each factor, the same form as the group's IF-THEN rules.
   - It is **hybrid**: each factor *starts* from the group's study value (survey, vendor interview, or estimate) and moves towards what the shop's data shows. The study counts as 14 days of evidence (`STUDY_DAYS` in `app.js`). With little data the study decides; as the crew logs more days, the data takes over. The Data tab shows, for every factor, the study value, what the data alone says, the value used now, and how much weight the study still has.
   - UiTM effects are **estimates**: 12% of respondents study at UiTM, so a UiTM period is assumed to change total demand by 12% × the change seen for UTP students (semester break ×0.95, exam week ×0.97, study break ×0.99).
   - **Sold-out correction:** on a sold-out day, sales are lower than real demand, so the model counts those days as 12% more than was sold.
2. **Testing**
   - The model learns from the first 70% of days and is tested on the last 30%, which it never saw.
   - The average error on those unseen days becomes the "expected to sell" range.
3. **IF-THEN rules**, only for things the model can't learn:
   - **Owner's note:** for an event, the owner chooses an adjustment, capped at ±25%.
   - **Low data:** fewer than 3 similar past days gives a low-confidence warning and a wider range.
   - **Kitchen limits:** the number is kept between the minimum and maximum portions.
   - **Safety buffer:** a percentage added last. A higher buffer means fewer sell-outs but more leftovers.
4. **Output**
   - Portions to prepare, multiplied by the recipe amounts to give the ingredients.
   - A "Why this number" list showing each step.
5. **Feedback loop**
   - Days saved in *Tutup kedai* are added to the data.
   - The model re-learns straight away.

Rain, holidays and campus breaks are learned by the model, not added again as fixed rules. Adding them as rules too would count their effect twice.

## Using the shop's real data
In the Data tab, use **Upload sales CSV**.

The file needs these columns, the same as `data/sales.csv`:
`date, holiday, rain_mm, weather, utp_status, uitm_status, owner_planned, portions_sold, leftover_portions, sold_out`

## Limitations
- The app can't know about events, a new menu item, competitors or supply problems unless the owner types a note.
- With only a few weeks of real data, predictions will be rough.
- On sell-out days, "sold" is lower than real demand.
- Everything is saved only in that browser.
- It is an estimate to support the owner's judgement, not a guarantee.

## AI use declaration
The prototype code was written with an AI assistant (Claude). The study, the analysis, the report and the presentation are the group's own work.
