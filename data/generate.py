"""
GepukPrep AI - dataset builder.

What is REAL in the output:
  - date, day of week
  - public holidays (calendar.json, from public Perak 2026 listings)
  - UTP / UiTM / KPM status (calendar.json - approximate, group to confirm)
  - rain_mm: real daily rainfall for Seri Iskandar from the Open-Meteo
    historical archive (saved in rain_raw.json)

What is SIMULATED (source = "simulated"):
  - owner_planned, portions_sold, leftover_portions, sold_out
  The simulator uses the group's own IF-THEN rules (same values as the report,
  Section 3.0) and the vendor interview (see settings below). Replace these rows with the shop's real records when
  the owner shares them; the app retrains automatically.

Run:  python3 generate.py      (writes sales.csv and sales.js)
Re-fetch rain (needs internet):  python3 generate.py --fetch
Save the next 16 days of weather forecast into the app:  python3 generate.py --forecast
"""
import csv, json, random, sys, urllib.request
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).parent
START, END = date(2026, 3, 1), date(2026, 11, 21)
LAT, LON = 4.3594, 100.9653          # Seri Iskandar, Perak
RAIN_THRESHOLD_MM = 10.0             # a day with >= 10 mm counts as "rainy"
SEED = 2026

# ---- Simulator settings: the GROUP'S OWN RULES (AI_-_AI_Workflow_and_Portion_Prediction.xlsx, sheet "Rules")
# ---- and study (AI-Gepuk_AI_Survey_Data_Analysis.xlsx). Same values as the report, Section 3.0.
BASELINE_WEEKDAY = 117               # report: normal lecture weekday (vendor's 101-150 range)
DAY = {5: 1.24, 6: 1.24}             # Rule 1: weekend (Saturday, Sunday) x1.24 (survey: weekend vs weekday interest)
PERIOD = {                           # applied from the UTP calendar (76.7% of respondents study at UTP)
    "Lecture": 1.00,
    "Study break": 0.95,             # Rule 2: survey, no classes that day
    "Exams": 0.75,                   # Rule 3: survey, exam week / many assignments
    "Break": 0.50,                   # Rule 4: ASSUMPTION, same as report Section 3.0 (vendor later said ~40% fewer)
}
RAIN = 0.85                          # Rule 5: survey 0.83 rounded to 0.85 (vendor: 10-20% fewer)
HOLIDAY = 0.40                       # Rule 6: ASSUMPTION, not in survey; vendor "not sure"
# UiTM: ESTIMATE. 12% of respondents study at UiTM, so a UiTM period changes total demand by
# about 12% x (the same change seen for UTP students): break 1-0.12x0.50, exams 1-0.12x0.25.
UITM_PERIOD = {"Lecture": 1.00, "Study break": 0.99, "Exams": 0.97, "Break": 0.94}
# KPM (Kolej Profesional MARA) Seri Iskandar: ESTIMATE, same method. 4 of 43 respondents (9.3%).
KPM_PERIOD = {"Lecture": 1.00, "Study break": 0.99, "Exams": 0.98, "Break": 0.95}
# Owner: decides early morning "based on previous day's sales", leaves ~0 unsold portions
# and turns away 1-5 customers when chicken runs out. So: plan = recent days' customers + a little.
OWNER_EXTRA = (0.00, 0.06)          # a little extra on top of the recent average
NOISE = 5                            # report: random adjustment of plus/minus 5 portions a day


def fetch_rain():
    url = ("https://archive-api.open-meteo.com/v1/archive"
           f"?latitude={LAT}&longitude={LON}&start_date={START}&end_date={END}"
           "&daily=precipitation_sum&timezone=Asia%2FKuala_Lumpur")
    with urllib.request.urlopen(url, timeout=30) as r:
        (HERE / "rain_raw.json").write_bytes(r.read())


def fetch_forecast():
    url = ("https://api.open-meteo.com/v1/forecast"
           f"?latitude={LAT}&longitude={LON}&daily=precipitation_sum"
           "&timezone=Asia%2FKuala_Lumpur&forecast_days=16")
    with urllib.request.urlopen(url, timeout=30) as r:
        data = json.loads(r.read())
    if "daily" not in data:
        raise SystemExit("Open-Meteo said: " + data.get("reason", "no data"))
    data["fetched_on"] = date.today().isoformat()
    (HERE / "forecast_raw.json").write_text(json.dumps(data))
    print("Forecast saved for", data["daily"]["time"][0], "to", data["daily"]["time"][-1])


def status_on(periods, d):
    for a, b, s in periods:
        if date.fromisoformat(a) <= d <= date.fromisoformat(b):
            return s
    return "Lecture"


def main():
    if "--fetch" in sys.argv:
        fetch_rain()
    if "--forecast" in sys.argv:
        fetch_forecast()
    cal = json.loads((HERE / "calendar.json").read_text())
    raw = json.loads((HERE / "rain_raw.json").read_text())["daily"]
    rain = dict(zip(raw["time"], raw["precipitation_sum"]))
    rng = random.Random(SEED)

    rows, sold_history, demand_history = [], {}, {}
    d = START
    while d <= END:
        iso = d.isoformat()
        dow = d.weekday()
        hol = cal["holidays"].get(iso, "")
        rain_mm = round(rain.get(iso) or 0.0, 1)
        rainy = rain_mm >= RAIN_THRESHOLD_MM
        utp, uitm, kpm = status_on(cal["utp"], d), status_on(cal["uitm"], d), status_on(cal["kpm"], d)

        mult = DAY.get(dow, 1.0) * PERIOD[utp] * UITM_PERIOD[uitm] * KPM_PERIOD[kpm] * (RAIN if rainy else 1.0) * (HOLIDAY if hol else 1.0)
        demand = max(15, round(BASELINE_WEEKDAY * mult) + rng.randint(-NOISE, NOISE))

        # Owner's manual estimate: yesterday's sales plus a little (vendor interview)
        # The owner sees the queue and the customers turned away, so they know roughly how
        # many people came recently - but not how today's rain, holiday or exam week will change it.
        recent = [demand_history[k] for k in sorted(demand_history)[-7:]] or [BASELINE_WEEKDAY]
        guess = sum(recent) / len(recent) * (1 + rng.uniform(*OWNER_EXTRA))
        owner_planned = int(round(guess))

        sold = min(demand, owner_planned)
        sold_history[iso] = sold
        demand_history[iso] = demand
        rows.append({
            "date": iso, "dow": d.strftime("%a"), "holiday": int(bool(hol)),
            "holiday_name": hol, "rain_mm": rain_mm, "weather": "Rainy" if rainy else "Dry",
            "utp_status": utp, "uitm_status": uitm, "kpm_status": kpm,
            "owner_planned": owner_planned, "portions_sold": sold,
            "leftover_portions": owner_planned - sold,
            "sold_out": int(demand > owner_planned), "source": "simulated",
        })
        d += timedelta(days=1)

    with open(HERE / "sales.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)

    fc_file = HERE / "forecast_raw.json"
    forecast = None
    if fc_file.exists():
        fc = json.loads(fc_file.read_text())
        forecast = {"fetched_on": fc.get("fetched_on", ""),
                    "days": dict(zip(fc["daily"]["time"], fc["daily"]["precipitation_sum"]))}

    # Same data as a JS file so the app also works when opened straight from disk.
    (HERE / "sales.js").write_text(
        "// Generated by data/generate.py - do not edit by hand.\n"
        f"window.GEPUK_CALENDAR = {json.dumps(cal)};\n"
        f"window.GEPUK_FORECAST = {json.dumps(forecast)};\n"
        f"window.GEPUK_DATA = {json.dumps(rows)};\n")

    n = len(rows)
    print(f"{n} days written. Rainy: {sum(r['weather']=='Rainy' for r in rows)}, "
          f"holidays: {sum(r['holiday'] for r in rows)}, "
          f"owner sell-outs: {sum(r['sold_out'] for r in rows)}, "
          f"owner leftover portions: {sum(r['leftover_portions'] for r in rows)}")


if __name__ == "__main__":
    main()
