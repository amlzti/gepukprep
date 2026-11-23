/* GepukPrep AI - prototype logic.
 *
 * 1. MODEL  - linear regression trained in the browser (least squares).
 *             portions = base + Fri + Sat + Sun + rain + holiday + UTP status + UiTM status
 * 2. RULES  - IF-THEN adjustments for what the model cannot know
 *             (owner's event note, low data, kitchen capacity, safety buffer).
 * 3. OUTPUT - expected range, portions to prepare, ingredients, "why this number".
 *
 * Data: window.GEPUK_DATA (data/sales.js) + days logged in this browser.
 */
(function () {
  "use strict";

  // ---------- Storage (per browser; safe if blocked) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("gpc_" + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("gpc_" + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  const DEFAULT_SETTINGS = {
    pieceGrams: 150,   // used only to turn leftover "pcs" into kg of waste
    // The owner builds the menu. It starts with ONE dish, like the original prototype.
    // share = % of daily orders; ings = what goes on one plate.
    menu: [
      { id: "m1", name: "Nasi Ayam Gepuk", share: 100, ings: [
        { name: "Ayam", unit: "pcs", qty: 1 }, { name: "Nasi", unit: "g", qty: 225 }, { name: "Sambal", unit: "g", qty: 28 } ] },
    ],
    minPortions: 30, maxPortions: 200, buffer: 5,
    rules: { note: true, lowData: true, capacity: true, buffer: true },
  };
  let settings = Object.assign({}, DEFAULT_SETTINGS, store.get("settings", {}));
  settings.rules = Object.assign({}, DEFAULT_SETTINGS.rules, settings.rules || {});
  if (!Array.isArray(settings.menu) || !settings.menu.length || !settings.menu[0].ings) settings.menu = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.menu));
  if (settings.recipeVersion !== 2) {   // vendor interview: 225 g rice, 28 g sambal per plate
    settings.menu.forEach((m) => m.ings.forEach((g) => { if (/nasi/i.test(g.name) && g.qty === 150) g.qty = 225; if (/sambal/i.test(g.name) && g.qty === 30) g.qty = 28; }));
    settings.recipeVersion = 2; store.set("settings", settings);
  }
  const UNITS = { pcs: "pcs", g: "g", ml: "ml", pack: "pack" };
  const ingKey = (g) => g.name.trim().toLowerCase() + "|" + g.unit;
  // Pick a drawing from the ingredient or dish name.
  function iconFor(name) {
    const n = name.toLowerCase();
    if (/keli|catfish|lele/.test(n)) return "keli";
    if (/talapia|tilapia|ikan|fish/.test(n)) return "tilapia";
    if (/indomee|mee|mi |noodle/.test(n)) return "noodle";
    if (/ayam|chicken|paha|dada/.test(n)) return "drum";
    if (/nasi|rice/.test(n)) return "rice";
    if (/sambal|cili|chili/.test(n)) return "sambal";
    if (/tauhu|tempe|tofu/.test(n)) return "tt";
    return "rice";
  }
  // Every ingredient used anywhere on the menu, in first-seen order.
  function catalog() {
    const seen = {}, list = [];
    settings.menu.forEach((m) => m.ings.forEach((g) => { if (!g.name.trim()) return; const k = ingKey(g); if (!seen[k]) { seen[k] = 1; list.push({ key: k, name: g.name.trim(), unit: g.unit }); } }));
    return list;
  }
  // How an amount is shown: grams as kg, ml as litres.
  const showUnit = (u) => (u === "g" ? "kg" : u === "ml" ? "L" : u);
  const showAmt = (v, u) => (u === "g" || u === "ml" ? (v / 1000).toFixed(1) : String(Math.round(v)));
  const uid = () => "m" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const ICONS = window.GEPUK_ICONS || {};
  let uploaded = store.get("uploaded", null);   // replaces simulated data if set
  let logs = store.get("logs", []);             // [{date, sold, leftChicken, leftRice, leftSambal, soldOut, soldOutTime, weather, planned}]
  let plans = store.get("plans", {});           // {date: {ai, final, note, notePct, adjusted}}

  const CAL = window.GEPUK_CALENDAR;
  const SAVED_FC = window.GEPUK_FORECAST || null;   // forecast saved by generate.py --forecast
  const RAIN_MM = 10;
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DOW_MS = ["Ahad", "Isnin", "Selasa", "Rabu", "Khamis", "Jumaat", "Sabtu"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ---------- Dates & calendar ----------
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const pretty = (s) => { const d = parse(s); return DOW[d.getDay()] + " " + d.getDate() + " " + MON[d.getMonth()] + " " + d.getFullYear(); };
  const statusOn = (periods, s) => { for (const [a, b, st] of periods) if (s >= a && s <= b) return st; return "Lecture"; };

  function baseRows() {
    const src = uploaded || window.GEPUK_DATA;
    return src.map((r) => ({
      date: r.date, holiday: +r.holiday, holiday_name: r.holiday_name || "",
      rain_mm: +r.rain_mm, weather: r.weather || (+r.rain_mm >= RAIN_MM ? "Rainy" : "Dry"),
      utp_status: r.utp_status, uitm_status: r.uitm_status,
      owner_planned: +r.owner_planned, portions_sold: +r.portions_sold,
      leftover_portions: +r.leftover_portions, sold_out: +r.sold_out, source: r.source || "real",
    }));
  }
  function allRows() {
    const rows = baseRows();
    const have = new Set(rows.map((r) => r.date));
    logs.forEach((l) => {
      if (have.has(l.date)) return;
      const c = conditionsFor(l.date, true);
      rows.push({
        date: l.date, holiday: c.holiday ? 1 : 0, holiday_name: c.holidayName, rain_mm: null,
        weather: l.weather, utp_status: c.utp, uitm_status: c.uitm,
        owner_planned: l.planned || null, portions_sold: l.sold,
        leftover_portions: null, sold_out: l.soldOut ? 1 : 0, source: "logged",
      });
    });
    return rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  // ---------- 1. MODEL: linear regression ----------
  const FEATURES = [
    { key: "fri", label: "Friday", test: (r) => parse(r.date).getDay() === 5 },
    { key: "sat", label: "Saturday", test: (r) => parse(r.date).getDay() === 6 },
    { key: "sun", label: "Sunday", test: (r) => parse(r.date).getDay() === 0 },
    { key: "rain", label: "Rainy day", test: (r) => r.weather === "Rainy" },
    { key: "hol", label: "Public holiday", test: (r) => !!r.holiday },
    { key: "utpSt", label: "UTP study break", test: (r) => r.utp_status === "Study break" },
    { key: "utpEx", label: "UTP exam weeks", test: (r) => r.utp_status === "Exams" },
    { key: "utpBr", label: "UTP semester break", test: (r) => r.utp_status === "Break" },
    { key: "uitmSt", label: "UiTM study break", test: (r) => r.uitm_status === "Study break" },
    { key: "uitmEx", label: "UiTM exam weeks", test: (r) => r.uitm_status === "Exams" },
    { key: "uitmBr", label: "UiTM semester break", test: (r) => r.uitm_status === "Break" },
  ];
  // What the group's own study said for each factor (Excel: AI-Gepuk_AI_Survey_Data_Analysis).
  const SURVEY = { fri: "weekday rule", sat: "weekend rule", sun: "weekend rule", rain: "survey", hol: "assumption",
    utpSt: "survey", utpEx: "survey", utpBr: "vendor", uitmSt: "estimate", uitmEx: "estimate", uitmBr: "estimate" };
  // HYBRID: the group's study gives each factor a STARTING value. The model starts from it and
  // moves towards what the shop's own data shows. The study counts as STUDY_DAYS days of evidence,
  // so with few data days the study decides; with many, the data decides.
  // UiTM values are estimates: 12% of respondents x the change seen for UTP students.
  // Values from the group's IF-THEN rules (report Section 3.0 / 4.4). Friday counts as a weekday.
  const STUDY = { fri: 1.00, sat: 1.24, sun: 1.24, rain: 0.85, hol: 0.40, utpSt: 0.95, utpEx: 0.75, utpBr: 0.60,
    uitmSt: 0.99, uitmEx: 0.97, uitmBr: 0.95 };
  const STUDY_DAYS = 14;
  const xOf = (r) => [1].concat(FEATURES.map((f) => (f.test(r) ? 1 : 0)));

  // Log-linear regression: we fit log(portions), so each learned weight w becomes a
  // MULTIPLIER e^w (e.g. rain ×0.85), the same form as the group's IF-THEN rules.
  // Solve (X'X + λI) w = X'y with Gaussian elimination. λ is small, only to keep it stable.
  // On a sold-out day, "sold" is lower than what customers wanted (they came after it ran out).
  // Demand correction: count a sold-out day as SOLD_OUT_UPLIFT more than was sold.
  const SOLD_OUT_UPLIFT = 1.12;
  const demandOf = (r) => (r.sold_out ? r.portions_sold * SOLD_OUT_UPLIFT : r.portions_sold);
  // studyDays > 0: hybrid (study + data). studyDays = 0: data alone, for comparison.
  function train(rows, studyDays) {
    if (studyDays == null) studyDays = STUDY_DAYS;
    const p = FEATURES.length + 1, A = [], b = new Array(p).fill(0);
    for (let i = 0; i < p; i++) A.push(new Array(p).fill(0));
    rows.forEach((r) => {
      const x = xOf(r);
      for (let i = 0; i < p; i++) { b[i] += x[i] * Math.log(Math.max(1, demandOf(r))); for (let j = 0; j < p; j++) A[i][j] += x[i] * x[j]; }
    });
    // Pull each factor towards the study's value with the weight of studyDays days.
    for (let i = 1; i < p; i++) { const k = Math.max(studyDays, 0.05); A[i][i] += k; b[i] += (studyDays > 0 ? k * Math.log(STUDY[FEATURES[i - 1].key]) : 0); }
    for (let c = 0; c < p; c++) {
      let piv = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
      for (let r = 0; r < p; r++) {
        if (r === c || A[c][c] === 0) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < p; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const w = b.map((v, i) => (A[i][i] ? v / A[i][i] : 0));
    const counts = FEATURES.map((f) => rows.filter(f.test).length);
    const real = FEATURES.map((f) => rows.filter((r) => r.source !== "simulated" && f.test(r)).length);
    return { w, counts, real, n: rows.length };
  }
  const predictRaw = (m, r) => Math.exp(xOf(r).reduce((s, x, i) => s + x * m.w[i], 0));
  const mult = (w) => Math.exp(w);
  const fmtMult = (w) => "×" + mult(w).toFixed(2);

  // ---------- Model state ----------
  let rows, split, testModel, fullModel, dataOnlyModel, rmse, testRows;
  function retrain() {
    rows = allRows();
    split = Math.floor(rows.length * 0.7);
    testModel = train(rows.slice(0, split));
    testRows = rows.slice(split);
    const errs = testRows.map((r) => predictRaw(testModel, r) - r.portions_sold);
    rmse = Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / Math.max(1, errs.length));
    fullModel = train(rows);
    dataOnlyModel = train(rows, 0);
  }

  // ---------- Conditions for a date ----------
  let overrides = {};          // {date: {weather, holiday, utp, uitm}}
  let forecast = {};           // {date: rain_mm} from Open-Meteo (live, optional)
  function conditionsFor(s, ignoreOverride) {
    const known = (rows || []).find((r) => r.date === s);
    const holName = CAL.holidays[s] || "";
    let weather = "Dry", weatherSrc = "No forecast yet, assumed dry";
    if (known && known.rain_mm != null) {
      weather = known.weather; weatherSrc = "Recorded " + known.rain_mm + " mm (Open-Meteo archive)";
    } else if (forecast[s] != null) {
      weather = forecast[s] >= RAIN_MM ? "Rainy" : "Dry"; weatherSrc = "Live forecast " + forecast[s] + " mm (Open-Meteo)";
    } else if (SAVED_FC && SAVED_FC.days[s] != null) {
      weather = SAVED_FC.days[s] >= RAIN_MM ? "Rainy" : "Dry";
      weatherSrc = "Forecast " + SAVED_FC.days[s] + " mm (Open-Meteo, saved " + SAVED_FC.fetched_on + ")";
    }
    const c = {
      weather, weatherSrc, holiday: !!holName, holidayName: holName,
      utp: statusOn(CAL.utp, s), uitm: statusOn(CAL.uitm, s), edited: {},
    };
    const o = ignoreOverride ? null : overrides[s];
    if (o) for (const k in o) { if (c[k] !== o[k]) { c[k] = o[k]; c.edited[k] = true; } }
    return c;
  }

  // ---------- 2. RULES + 3. OUTPUT ----------
  function recommend(s, note) {
    const c = conditionsFor(s);
    const r = { date: s, weather: c.weather, holiday: c.holiday ? 1 : 0, utp_status: c.utp, uitm_status: c.uitm };
    const m = fullModel, x = xOf(r);
    let run = mult(m.w[0]);
    const lines = [{ label: "Typical Mon–Thu day", sub: "dry, no holiday, both campuses in lectures", v: Math.round(run), kind: "base" }];
    FEATURES.forEach((f, i) => {
      if (!x[i + 1]) return;
      const before = Math.round(run); run *= mult(m.w[i + 1]);
      lines.push({ label: f.label, sub: fmtMult(m.w[i + 1]) + " · study ×" + STUDY[f.key].toFixed(2) + " + " + m.counts[i] + " days of data", v: Math.round(run) - before, kind: "learned" });
    });
    let total = lines.reduce((t, l) => t + l.v, 0);
    const modelTotal = total;

    // R1 low data: how many past days look exactly like this one?
    const similar = rows.filter((p) => xOf(p).every((v, i) => v === x[i])).length;
    const lowData = settings.rules.lowData && similar < 3;
    // Range: the group's +/-10% of the prediction, or the test error if that is larger.
    const spread = Math.max(4, Math.round(Math.max(rmse, total * 0.10) * (lowData ? 1.6 : 1)));

    // R2 owner's note (capped at ±25%)
    if (settings.rules.note && note && note.pct) {
      const pct = Math.max(-25, Math.min(25, note.pct));
      const v = Math.round(total * pct / 100);
      lines.push({ label: "Your note: " + (note.text || "special day"), sub: (pct > 0 ? "+" : "") + pct + "% (you accepted)", v, kind: "rule" });
      total += v;
    }
    // R3 kitchen capacity
    if (settings.rules.capacity) {
      if (total > settings.maxPortions) { lines.push({ label: "Kitchen limit", sub: "max " + settings.maxPortions + " portions", v: settings.maxPortions - total, kind: "rule" }); total = settings.maxPortions; }
      if (total < settings.minPortions) { lines.push({ label: "Minimum to open", sub: "min " + settings.minPortions + " portions", v: settings.minPortions - total, kind: "rule" }); total = settings.minPortions; }
    }
    const expected = total;
    // R4 safety buffer (always last)
    if (settings.rules.buffer && settings.buffer > 0) {
      const v = Math.round(total * settings.buffer / 100);
      lines.push({ label: "Safety buffer", sub: settings.buffer + "% so you don't sell out early", v, kind: "rule" });
      total += v;
    }
    return {
      c, lines, modelTotal, prepare: total, lowData, similar,
      lo: Math.max(0, expected - spread), hi: expected + spread,
      ingredients: ingredientsFor(total),
    };
  }
  // ---------- Menu mix: learned from logged days, else the owner's shares ----------
  function menuMix() {
    const withItems = logs.filter((l) => l.items && Object.keys(l.items).length);
    const menu = settings.menu;
    if (withItems.length >= 3) {
      const tot = {}; let all = 0;
      withItems.forEach((l) => menu.forEach((m) => { const v = +l.items[m.id] || 0; tot[m.id] = (tot[m.id] || 0) + v; all += v; }));
      if (all > 0) return { shares: menu.map((m) => tot[m.id] / all), learned: true, days: withItems.length };
    }
    const sum = menu.reduce((t, m) => t + (+m.share || 0), 0) || 1;
    return { shares: menu.map((m) => (+m.share || 0) / sum), learned: false, days: withItems.length };
  }
  // Split n portions across the menu so the parts add up exactly (largest remainder).
  function splitPortions(n) {
    const mix = menuMix();
    const raw = mix.shares.map((sh) => sh * n);
    const base = raw.map(Math.floor);
    let left = n - base.reduce((a, b) => a + b, 0);
    raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { base[i]++; left--; } });
    return { counts: base, mix };
  }
  function ingredientsFor(n) {
    const sp = splitPortions(n), tot = {};
    settings.menu.forEach((m, i) => m.ings.forEach((g) => { if (!g.name.trim()) return; const k = ingKey(g); tot[k] = (tot[k] || 0) + sp.counts[i] * (+g.qty || 0); }));
    return { split: sp, list: catalog().map((c) => Object.assign({ total: tot[c.key] || 0 }, c)) };
  }
  // Average kg of food in one portion, weighted by the menu mix (used for waste in History).
  const kgPerPortion = () => {
    const mix = menuMix().shares;
    const kg = (g) => (g.unit === "g" || g.unit === "ml" ? g.qty / 1000 : g.unit === "pcs" ? g.qty * settings.pieceGrams / 1000 : g.qty * 0.08);
    return settings.menu.reduce((t, m, i) => t + mix[i] * m.ings.reduce((a, g) => a + kg(g), 0), 0);
  };

  // ---------- Evaluation on held-out days ----------
  function evaluate(buffer) {
    const out = { days: 0, aiMiss: 0, ownMiss: 0, aiWaste: 0, ownWaste: 0, aiOut: 0, ownOut: 0, series: [] };
    testRows.forEach((r) => {
      if (r.owner_planned == null) return;
      const pred = predictRaw(testModel, r);
      const ai = Math.round(pred * (1 + buffer / 100));
      // Score both plans against estimated DEMAND, not "sold": on a sold-out day, sold only
      // equals what the owner cooked, which would make the owner look perfect on exactly the
      // days customers were turned away.
      const sold = r.portions_sold, dem = demandOf(r);
      const aiOut = ai < Math.round(dem);
      out.days++;
      out.aiMiss += Math.abs(ai - dem); out.ownMiss += Math.abs(r.owner_planned - dem);
      out.aiWaste += Math.max(0, ai - dem); out.ownWaste += r.sold_out ? 0 : Math.max(0, r.owner_planned - sold);
      out.aiOut += aiOut ? 1 : 0; out.ownOut += r.sold_out ? 1 : 0;
      out.series.push({ date: r.date, sold, ai, own: r.owner_planned, aiOut, ownOut: !!r.sold_out, source: r.source });
    });
    if (out.days) { out.aiMiss /= out.days; out.ownMiss /= out.days; }
    return out;
  }

  // ---------- UI helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const signed = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v);
  const fmtKg = (v) => v.toFixed(1);
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
  }
  function dataLabel() {
    const src = new Set(rows.map((r) => r.source));
    if (src.has("simulated") && src.size === 1) return "Simulated sales data";
    if (src.has("simulated")) return "Simulated + logged data";
    return "Real data";
  }

  // ---------- TODAY ----------
  const todayISO = iso(new Date());
  let selDate = addDays(todayISO, 1);
  let notes = {};   // {date: {text, pct}}

  function renderToday() {
    const note = notes[selDate];
    const rec = recommend(selDate, note);
    const c = rec.c;
    $("t-date").textContent = pretty(selDate);
    $("t-date-ms").textContent = DOW_MS[parse(selDate).getDay()];
    $("t-picker").value = selDate;
    $("t-rel").textContent = selDate === todayISO ? "Today" : selDate === addDays(todayISO, 1) ? "Tomorrow" : selDate < todayISO ? "Past day" : "Upcoming";
    $("t-prepare").textContent = rec.prepare;
    $("t-range").textContent = rec.lo + "–" + rec.hi;
    $("t-conf").textContent = rec.lowData ? "Low confidence: only " + rec.similar + " similar past days" : "Based on " + rec.similar + " similar past days";
    $("t-conf").className = "conf " + (rec.lowData ? "conf-low" : "conf-ok");
    const ing = rec.ingredients, sp = ing.split;
    $("menu-split").innerHTML = settings.menu.map((m, i) =>
      '<div class="menu-item">' + (ICONS[iconFor(m.name)] || "") + '<span class="mi-name">' + esc(m.name) + '</span><span class="mi-n">' + sp.counts[i] +
      "<small>" + Math.round(sp.mix.shares[i] * 100) + "%</small></span></div>").join("") +
      '<button type="button" class="menu-add" id="t-add-item">+ Add menu item</button>';
    $("mix-src").textContent = settings.menu.length === 1 ? "One dish on the menu, so every plate is " + settings.menu[0].name + ". Add more dishes and their ingredients with the button."
      : sp.mix.learned ? "Menu shares learned from " + sp.mix.days + " closing slips."
      : "Menu shares are the owner's estimates (Data tab) until 3 closing slips with sales per item are saved.";
    $("t-add-item").onclick = () => addMenuItem();
    $("ingr").innerHTML = ing.list.map((g) => {
      const raw = g.unit === "g" && /nasi|rice/i.test(g.name) ? "≈ " + (g.total / 1000 / 2.5).toFixed(1) + " kg uncooked" : "";
      return '<div class="tile">' + (ICONS[iconFor(g.name)] || "") + '<div><div class="t-name">' + esc(g.name) + '</div><div class="t-sub">' + raw + '</div></div><div class="t-val">' +
        showAmt(g.total, g.unit) + "<small>" + showUnit(g.unit) + "</small></div></div>";
    }).join("");
    $("t-badge").textContent = dataLabel();

    // Why this number
    const ul = $("why");
    ul.innerHTML = rec.lines.map((l, i) =>
      '<li class="why-' + l.kind + '"><div><span class="why-label">' + (i === 0 ? "" : l.v >= 0 ? "+ " : "− ") + esc(l.label) +
      '</span><span class="why-sub">' + esc(l.sub) + '</span></div><span class="why-v">' + (i === 0 ? l.v : Math.abs(l.v)) + "</span></li>").join("") +
      '<li class="why-total"><span>Prepare</span><span class="why-v">' + rec.prepare + "</span></li>";

    // Conditions
    const cond = [
      ["weather", "Weather", c.weather, c.weatherSrc, ["Dry", "Rainy"]],
      ["holiday", "Public holiday", c.holiday ? "Yes" : "No", c.holiday ? c.holidayName : "Perak holiday calendar", ["No", "Yes"]],
      ["utp", "UTP", c.utp, "UTP academic calendar", ["Lecture", "Study break", "Exams", "Break"]],
      ["uitm", "UiTM", c.uitm, "UiTM calendar, Group B", ["Lecture", "Study break", "Exams", "Break"]],
    ];
    $("cond").innerHTML = cond.map(([k, name, val, src, opts]) =>
      '<div class="cond-row"><div class="cond-head"><span class="cond-name">' + name + "</span>" +
      (c.edited[k] ? '<span class="tag-edit">Edited by you</span>' : '<span class="cond-src">' + esc(src) + "</span>") + "</div>" +
      '<div class="seg" role="group" aria-label="' + name + '">' + opts.map((o) =>
        '<button type="button" class="seg-btn' + (o === val ? " on" : "") + '" aria-pressed="' + (o === val) + '" data-k="' + k + '" data-v="' + o + '">' + o + "</button>").join("") +
      "</div></div>").join("");

    // Note
    if (document.activeElement !== $("note-text")) $("note-text").value = note ? note.text : ($("note-text").dataset.date === selDate ? $("note-text").value : "");
    $("note-text").dataset.date = selDate;
    const noteLine = rec.lines.find((l) => l.label.indexOf("Your note") === 0);
    const eff = $("note-effect");
    if (noteLine) {
      eff.textContent = (noteLine.v >= 0 ? "Adds " : "Removes ") + Math.abs(noteLine.v) + " portions to the plan above. Tap the same button again to undo.";
      eff.className = "note-effect on";
    } else if (!settings.rules.note) {
      eff.textContent = "Notes are switched off in the Data tab."; eff.className = "note-effect";
    } else {
      eff.textContent = "Nothing added yet. Normal days don't need a note."; eff.className = "note-effect";
    }
    document.querySelectorAll(".chip").forEach((b) => {
      const on = note && note.pct === +b.dataset.pct;
      b.classList.toggle("on", !!on); b.setAttribute("aria-pressed", !!on);
    });
    $("buffer").value = settings.buffer;
    $("buffer-v").textContent = settings.buffer + "%";

    // Saved plan
    const p = plans[selDate];
    $("plan-status").textContent = p ? (p.adjusted ? "Saved: you chose " + p.final + " portions (AI said " + p.ai + ")" : "Saved: using the plan, " + p.final + " portions") : "";
    $("adjust-box").hidden = true;
    renderToday._rec = rec;
  }

  function setCond(k, v) {
    overrides[selDate] = overrides[selDate] || {};
    overrides[selDate][k] = k === "holiday" ? v === "Yes" : v;
    renderToday();
  }

  const SCENARIOS = {
    weekend: { date: "2026-10-17", o: { weather: "Dry" }, note: null, label: "Sunny weekend during lectures" },
    rainwk: { date: "2026-10-21", o: { weather: "Rainy" }, note: null, label: "Rainy weekday during lectures" },
    sembreak: { date: "2026-08-25", o: { weather: "Dry" }, note: null, label: "Weekday in the semester break" },
    holiday: { date: "2026-11-06", o: { weather: "Dry" }, note: null, label: "Public holiday (Sultan of Perak's Birthday)" },
    event: { date: "2026-11-28", o: { weather: "Dry" }, note: { text: "UTP convocation", pct: 25 }, label: "Big campus event the data can't know about" },
  };

  // ---------- HISTORY ----------
  let chart, histDays = 30;
  function renderHistory() {
    const ev = evaluate(settings.buffer);
    $("h-buffer").value = settings.buffer; $("h-buffer-v").textContent = settings.buffer + "%";
    $("m-ai").textContent = "±" + ev.aiMiss.toFixed(1);
    $("m-own").textContent = "±" + ev.ownMiss.toFixed(1);
    const kg = (ev.ownWaste - ev.aiWaste) * kgPerPortion();
    $("m-waste").textContent = Math.abs(kg).toFixed(0) + " kg";
    $("m-waste-l").textContent = kg >= 0 ? "less food left over than the owner's plans" : "more food left over than the owner's plans";
    $("m-out").textContent = ev.aiOut + " vs " + ev.ownOut;
    $("m-days").textContent = ev.days;
    $("m-period").textContent = ev.series.length ? pretty(ev.series[0].date) + " to " + pretty(ev.series[ev.series.length - 1].date) : "";

    const s = ev.series.slice(-histDays);
    const labels = s.map((d) => { const x = parse(d.date); return x.getDate() + " " + MON[x.getMonth()]; });
    const data = {
      labels,
      datasets: [
        { label: "Actually sold", data: s.map((d) => d.sold), borderColor: "#2A1205", backgroundColor: "#2A1205", borderWidth: 3, pointRadius: 3, tension: 0.2 },
        { label: "GepukPrep plan", data: s.map((d) => d.ai), borderColor: "#E31E24", backgroundColor: "#E31E24", borderWidth: 3, pointRadius: 3, pointStyle: "rectRot", tension: 0.2 },
        { label: "Owner's own plan", data: s.map((d) => d.own), borderColor: "#B8860B", backgroundColor: "#B8860B", borderWidth: 2, borderDash: [6, 4], pointRadius: 2, tension: 0.2 },
      ],
    };
    if (window.Chart) {
      if (chart) { chart.data = data; chart.update(); }
      else {
        Chart.defaults.font.family = "Poppins, system-ui, sans-serif";
        Chart.defaults.color = "#5A3A22";
        chart = new Chart($("chart"), {
          type: "line", data,
          options: {
            responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
            plugins: { legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 10 } } },
            scales: { y: { title: { display: true, text: "portions" }, grid: { color: "#EAD9BF" } }, x: { grid: { display: false } } },
          },
        });
      }
    } else {
      $("chart-wrap").innerHTML = '<p class="muted">Chart needs an internet connection to load. The numbers below still work.</p>';
    }

    $("h-table").innerHTML = s.slice().reverse().map((d) =>
      '<tr tabindex="0" data-date="' + d.date + '"><td>' + pretty(d.date) + "</td><td>" + d.sold + "</td><td>" + d.ai +
      (d.aiOut ? ' <span class="pill pill-bad">ran out</span>' : "") + "</td><td>" + d.own +
      (d.ownOut ? ' <span class="pill pill-bad">ran out</span>' : "") + "</td><td>" + d.source + "</td></tr>").join("");
  }

  // ---------- DAILY LOG ----------
  function renderLog() {
    $("l-date").value = $("l-date").value || todayISO;
    const p = plans[$("l-date").value];
    $("l-plan").textContent = p ? "Plan for this day: " + p.final + " portions" : "No saved plan for this day";
    $("l-table").innerHTML = logs.length ? logs.slice().reverse().map((l) =>
      "<tr><td>" + pretty(l.date) + "</td><td>" + (l.planned || "–") + "</td><td>" + l.sold + "</td><td>" + (l.items ? settings.menu.map((m) => esc(m.name) + " " + (l.items[m.id] || 0)).join(" · ") : "–") + "</td><td>" + (l.left ? Object.keys(l.left).filter((k) => l.left[k]).map((k) => l.left[k] + " " + showUnit(k.split("|")[1]) + " " + k.split("|")[0]).join(" · ") || "none" : "–") + "</td><td>" +
      (l.soldOut ? "Yes" + (l.soldOutTime ? ", " + l.soldOutTime : "") : "No") + "</td><td>" + l.weather + "</td></tr>").join("")
      : '<tr><td colspan="7" class="muted">No days logged yet. Fill in the form after closing and press Save.</td></tr>';
    $("l-undo").disabled = !logs.length;
    const box = $("l-items");
    if (box.dataset.built !== settings.menu.map((m) => m.id + m.name).join()) {
      box.innerHTML = settings.menu.map((m) =>
        '<div class="field"><label for="l-item-' + m.id + '">' + esc(m.name) + '</label><input type="number" id="l-item-' + m.id + '" class="l-item" min="0" step="1" inputmode="numeric" placeholder="0"></div>').join("");
      box.dataset.built = settings.menu.map((m) => m.id + m.name).join();
      box.querySelectorAll(".l-item").forEach((inp) => (inp.oninput = updateTotal));
    }
    const lb = $("l-left"), cat = catalog(), sig = cat.map((c) => c.key).join();
    if (lb.dataset.built !== sig) {
      lb.innerHTML = cat.map((c, i) => '<div class="field"><label for="l-left-' + i + '">' + esc(c.name) + " (" + showUnit(c.unit) + ')</label><input type="number" id="l-left-' + i + '" data-key="' + esc(c.key) + '" class="l-left" min="0" step="' + (c.unit === "g" || c.unit === "ml" ? 0.1 : 1) + '" inputmode="decimal" placeholder="0"></div>').join("");
      lb.dataset.built = sig;
    }
    updateTotal();
  }
  function updateTotal() {
    $("l-total").textContent = settings.menu.reduce((t, m) => t + (Math.round(+$("l-item-" + m.id).value) || 0), 0);
  }

  // ---------- DATA tab ----------
  function renderData() {
    const m = fullModel;
    $("d-coef").innerHTML =
      "<tr><td>Typical Mon–Thu day</td><td>117 portions <span class=\"muted\">report baseline</span></td><td>" + Math.round(mult(dataOnlyModel.w[0])) + "</td><td><strong>" + Math.round(mult(m.w[0])) + "</strong></td><td>data</td><td>" + m.n + "</td></tr>" +
      FEATURES.map((f, i) => {
        const n = m.counts[i], studyPct = Math.round(STUDY_DAYS / (STUDY_DAYS + n) * 100);
        return "<tr><td>" + f.label + "</td><td>×" + STUDY[f.key].toFixed(2) + ' <span class="muted">' + SURVEY[f.key] + "</span></td><td>" + fmtMult(dataOnlyModel.w[i + 1]) +
          "</td><td><strong>" + fmtMult(m.w[i + 1]) + "</strong></td><td>" +
          '<span class="mixbar" title="Study ' + studyPct + "%, data " + (100 - studyPct) + '%"><span style="width:' + studyPct + '%"></span></span> ' + studyPct + "% study</td><td>" + n +
          (m.real[i] ? " (" + m.real[i] + " real)" : "") + "</td></tr>";
      }).join("");
    $("d-rmse").textContent = rmse.toFixed(1);
    $("d-split").textContent = split + " days to learn, " + testRows.length + " days to test";
    $("d-label").textContent = dataLabel();
    ["minPortions", "maxPortions"].forEach((k) => ($("s-" + k).value = settings[k]));
    renderMenuEditor();
    ["note", "lowData", "capacity", "buffer"].forEach((k) => ($("r-" + k).checked = settings.rules[k]));
    $("d-reset").hidden = !uploaded;
  }

  // ---------- Menu editor ----------
  function saveMenu() { store.set("settings", settings); renderMenuEditor(); }
  function addMenuItem() {
    settings.menu.push({ id: uid(), name: "New dish " + (settings.menu.length + 1), share: 10, ings: [{ name: "Nasi", unit: "g", qty: 225 }, { name: "Sambal", unit: "g", qty: 28 }] });
    store.set("settings", settings);
    showTab("data");
    const names = document.querySelectorAll('#d-menu input[data-f="name"]');
    const last = names[names.length - 1];
    if (last) { last.scrollIntoView({ block: "center" }); last.focus(); last.select(); }
    toast("New dish added. Give it a name, its share of orders and its ingredients.");
  }
  function renderMenuEditor() {
    const one = settings.menu.length === 1;
    $("d-menu").innerHTML = settings.menu.map((m, i) =>
      '<div class="dish"><div class="dish-head">' +
      '<div class="field"><label for="dm-name-' + i + '">Dish name</label><input id="dm-name-' + i + '" type="text" data-i="' + i + '" data-f="name" value="' + esc(m.name) + '"></div>' +
      '<div class="field"><label for="dm-share-' + i + '">% of orders</label><input id="dm-share-' + i + '" type="number" min="0" step="1" data-i="' + i + '" data-f="share" value="' + m.share + '"' + (one ? " disabled" : "") + "></div>" +
      (one ? "" : '<button type="button" class="link-btn" data-act="del-item" data-i="' + i + '">Remove dish</button>') + "</div>" +
      '<table class="ing-tbl"><thead><tr><th>Ingredient (bahan)</th><th>Amount on one plate</th><th>Unit</th><th></th></tr></thead><tbody>' +
      m.ings.map((g, j) => "<tr><td><input type=\"text\" aria-label=\"Ingredient name\" placeholder=\"e.g. Tempe\" data-i=\"" + i + "\" data-j=\"" + j + "\" data-f=\"gname\" value=\"" + esc(g.name) + "\"></td>" +
        "<td><input type=\"number\" min=\"0\" step=\"any\" aria-label=\"Amount\" data-i=\"" + i + "\" data-j=\"" + j + "\" data-f=\"qty\" value=\"" + g.qty + "\"></td>" +
        "<td><select aria-label=\"Unit\" data-i=\"" + i + "\" data-j=\"" + j + "\" data-f=\"unit\">" + Object.keys(UNITS).map((u) => "<option" + (u === g.unit ? " selected" : "") + ">" + u + "</option>").join("") + "</select></td>" +
        "<td><button type=\"button\" class=\"link-btn\" data-act=\"del-ing\" data-i=\"" + i + "\" data-j=\"" + j + "\" aria-label=\"Remove " + esc(g.name || "ingredient") + "\">Remove</button></td></tr>").join("") +
      '</tbody></table><button type="button" class="pill-btn" data-act="add-ing" data-i="' + i + '">+ Add ingredient</button></div>').join("");
    menuSummary();
  }
  // The example sentence and note under the editor. Updated on every edit without
  // redrawing the editor itself, so a button you are clicking never disappears mid-click.
  function menuSummary() {
    const one = settings.menu.length === 1;
    const mix = menuMix(), tot = settings.menu.reduce((t, m) => t + (+m.share || 0), 0);
    const ex = splitPortions(100).counts;
    $("d-menu-example").innerHTML = one
      ? "<strong>One dish:</strong> every plate is " + esc(settings.menu[0].name) + ". Press <strong>+ Add menu item</strong> to add another dish and its ingredients."
      : "<strong>Example:</strong> if the shop sells 100 plates, the app plans " + settings.menu.map((m, i) => ex[i] + " " + esc(m.name)).join(", ") + ".";
    $("d-menu-note").textContent = one ? "" : (mix.learned ? "Shares in use: learned from " + mix.days + " closing slips. " : "Shares in use: the owner's estimates above, until 3 closing slips with sales per item are saved. ") +
      "The % column adds up to " + tot + "%" + (tot === 100 ? "." : "; the app scales them to 100%.");
  }

  // ---------- CSV ----------
  function toCSV(list) {
    if (!list.length) return "";
    const keys = Object.keys(list[0]);
    return keys.join(",") + "\n" + list.map((r) => keys.map((k) => {
      const v = r[k] == null ? "" : String(r[k]);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(",")).join("\n");
  }
  function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    const head = lines[0].split(",").map((h) => h.trim());
    return lines.slice(1).map((ln) => {
      const cells = []; let cur = "", q = false;
      for (const ch of ln) { if (ch === '"') q = !q; else if (ch === "," && !q) { cells.push(cur); cur = ""; } else cur += ch; }
      cells.push(cur);
      const o = {}; head.forEach((h, i) => (o[h] = (cells[i] || "").trim())); return o;
    });
  }
  function showExport(title, csv) {
    $("export-title").textContent = title;
    $("export-text").value = csv;
    $("export").hidden = false;
    $("export-text").focus(); $("export-text").select();
  }

  // ---------- Tabs ----------
  const TABS = ["today", "history", "log", "data"];
  function showTab(t) {
    if (!TABS.includes(t)) t = "today";
    TABS.forEach((x) => {
      $("tab-" + x).hidden = x !== t;
      document.querySelectorAll('[data-tab="' + x + '"]').forEach((b) => { b.classList.toggle("on", x === t); b.setAttribute("aria-selected", x === t); });
    });
    if (t === "today") renderToday();
    if (t === "history") renderHistory();
    if (t === "log") renderLog();
    if (t === "data") renderData();
    try { if (location.hash !== "#" + t) history.replaceState(null, "", "#" + t); } catch (e) { /* ignore */ }
  }

  // ---------- Live forecast (optional; silently skipped when blocked/offline) ----------
  function loadForecast() {
    if (!window.fetch) return;
    fetch("https://api.open-meteo.com/v1/forecast?latitude=4.3594&longitude=100.9653&daily=precipitation_sum&timezone=Asia%2FKuala_Lumpur&forecast_days=7")
      .then((r) => r.json()).then((j) => {
        j.daily.time.forEach((t, i) => (forecast[t] = j.daily.precipitation_sum[i]));
        renderToday();
      }).catch(() => { /* app works without it */ });
  }

  // ---------- Wire up ----------
  function init() {
    retrain();
    document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
    $("t-prev").onclick = () => { selDate = addDays(selDate, -1); renderToday(); };
    $("t-next").onclick = () => { selDate = addDays(selDate, 1); renderToday(); };
    $("t-picker").onchange = (e) => { if (e.target.value) { selDate = e.target.value; renderToday(); } };
    $("cond").onclick = (e) => { const b = e.target.closest(".seg-btn"); if (b) setCond(b.dataset.k, b.dataset.v); };
    $("cond-reset").onclick = () => { delete overrides[selDate]; renderToday(); };
    document.querySelectorAll(".chip").forEach((b) => (b.onclick = () => {
      const pct = +b.dataset.pct, cur = notes[selDate];
      if (cur && cur.pct === pct) delete notes[selDate];
      else notes[selDate] = { text: $("note-text").value.trim() || "special day", pct };
      renderToday();
    }));
    $("note-text").oninput = (e) => { if (notes[selDate]) { notes[selDate].text = e.target.value.trim() || "special day"; renderToday(); } };
    $("buffer").oninput = (e) => { settings.buffer = +e.target.value; store.set("settings", settings); renderToday(); };
    $("h-buffer").oninput = (e) => { settings.buffer = +e.target.value; store.set("settings", settings); renderHistory(); };
    document.querySelectorAll("[data-scn]").forEach((b) => (b.onclick = () => {
      const s = SCENARIOS[b.dataset.scn];
      selDate = s.date; overrides[s.date] = Object.assign({}, s.o);
      if (s.note) notes[s.date] = Object.assign({}, s.note); else delete notes[s.date];
      showTab("today"); toast("Loaded: " + s.label);
    }));
    $("use-plan").onclick = () => {
      const r = renderToday._rec, n = notes[selDate];
      plans[selDate] = { ai: r.prepare, final: r.prepare, note: n ? n.text : "", adjusted: false };
      store.set("plans", plans); renderToday(); toast("Plan saved for " + pretty(selDate));
    };
    $("adjust").onclick = () => { $("adjust-box").hidden = false; $("adjust-n").value = renderToday._rec.prepare; $("adjust-n").focus(); };
    $("adjust-save").onclick = () => {
      const v = Math.round(+$("adjust-n").value);
      if (!(v > 0)) { $("adjust-err").textContent = "Enter a number of portions above 0."; return; }
      $("adjust-err").textContent = "";
      const n = notes[selDate];
      plans[selDate] = { ai: renderToday._rec.prepare, final: v, note: n ? n.text : "", adjusted: true };
      store.set("plans", plans); renderToday(); toast("Your number is saved. The AI's number is kept for comparison.");
    };
    $("adjust-cancel").onclick = () => ($("adjust-box").hidden = true);

    document.querySelectorAll("[data-days]").forEach((b) => (b.onclick = () => {
      histDays = +b.dataset.days;
      document.querySelectorAll("[data-days]").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); });
      renderHistory();
    }));
    const openRow = (e) => { const tr = e.target.closest("tr[data-date]"); if (tr) { selDate = tr.dataset.date; showTab("today"); } };
    $("h-table").onclick = openRow;
    $("h-table").onkeydown = (e) => { if (e.key === "Enter") openRow(e); };

    $("l-date").onchange = renderLog;
    document.querySelectorAll("#tab-log .seg-btn").forEach((b) => (b.onclick = () => {
      document.querySelectorAll('#tab-log .seg-btn[data-f="' + b.dataset.f + '"]').forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", x === b); });
      if (b.dataset.f === "soldout") $("l-time-wrap").hidden = b.dataset.v !== "Yes";
    }));
    $("log-form").onsubmit = (e) => {
      e.preventDefault();
      const date = $("l-date").value;
      const items = {}; let sold = 0, any = false;
      settings.menu.forEach((m) => { const el = $("l-item-" + m.id); const v = Math.round(+el.value) || 0; if (el.value !== "") any = true; items[m.id] = v; sold += v; });
      if (!date || !any) { $("l-err").textContent = "Fill in the date and how many of each item were sold."; return; }
      $("l-err").textContent = "";
      const pick = (f) => document.querySelector('#tab-log .seg-btn.on[data-f="' + f + '"]').dataset.v;
      const p = plans[date];
      logs = logs.filter((l) => l.date !== date);
      logs.push({
        date, sold, items, left: Array.from(document.querySelectorAll(".l-left")).reduce((o, el) => { o[el.dataset.key] = +el.value || 0; return o; }, {}),
        soldOut: pick("soldout") === "Yes", soldOutTime: pick("soldout") === "Yes" ? $("l-time").value : "",
        weather: pick("weather"), planned: p ? p.final : null,
      });
      logs.sort((a, b) => (a.date < b.date ? -1 : 1));
      store.set("logs", logs); retrain(); renderLog();
      toast("Saved. The model has re-learned with this day included.");
    };
    $("l-undo").onclick = () => { logs.pop(); store.set("logs", logs); retrain(); renderLog(); toast("Removed the last saved day."); };
    $("l-export").onclick = () => showExport("Daily log (CSV)", toCSV((logs.length ? logs : [{ date: "", sold: "", items: {} }]).map((l) => {
      const o = { date: l.date, sold_total: l.sold };
      settings.menu.forEach((m) => (o["sold_" + m.name.replace(/\W+/g, "_").toLowerCase()] = l.items ? (l.items[m.id] || 0) : ""));
      catalog().forEach((c) => (o["left_" + c.name.replace(/\W+/g, "_").toLowerCase() + "_" + showUnit(c.unit)] = l.left ? (l.left[c.key] || 0) : ""));
      return Object.assign(o, {
        sold_out: l.soldOut, sold_out_time: l.soldOutTime, weather: l.weather, planned: l.planned });
    })));

    $("d-menu").onchange = (e) => {
      const t = e.target, i = +t.dataset.i, f = t.dataset.f; if (!f) return;
      const m = settings.menu[i];
      if (f === "name") { if (t.value.trim()) m.name = t.value.trim(); }
      else if (f === "share") { if (+t.value >= 0) m.share = +t.value; }
      else { const g = m.ings[+t.dataset.j]; if (f === "gname") g.name = t.value; if (f === "qty" && +t.value >= 0) g.qty = +t.value; if (f === "unit") g.unit = t.value; }
      store.set("settings", settings); menuSummary(); toast("Saved");
    };
    $("d-menu").onclick = (e) => {
      const b = e.target.closest("button[data-act]"); if (!b) return;
      const i = +b.dataset.i, m = settings.menu[i];
      if (b.dataset.act === "add-ing") m.ings.push({ name: "", unit: "g", qty: 0 });
      if (b.dataset.act === "del-ing") m.ings.splice(+b.dataset.j, 1);
      if (b.dataset.act === "del-item" && settings.menu.length > 1) { const gone = settings.menu.splice(i, 1)[0]; toast("Removed " + gone.name + "."); }
      saveMenu();
      if (b.dataset.act === "add-ing") { const ins = document.querySelectorAll('#d-menu input[data-i="' + i + '"][data-f="gname"]'); if (ins.length) ins[ins.length - 1].focus(); }
    };
    $("d-add-item").onclick = () => addMenuItem();
    ["minPortions", "maxPortions"].forEach((k) =>
      ($("s-" + k).onchange = (e) => { const v = +e.target.value; if (v >= 0) { settings[k] = v; store.set("settings", settings); toast("Saved"); } }));
    ["note", "lowData", "capacity", "buffer"].forEach((k) => ($("r-" + k).onchange = (e) => { settings.rules[k] = e.target.checked; store.set("settings", settings); }));
    $("d-file").onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        const list = parseCSV(rd.result);
        const need = ["date", "portions_sold", "utp_status", "uitm_status"];
        const miss = need.filter((k) => !(k in (list[0] || {})));
        if (miss.length) { $("d-err").textContent = "This file is missing columns: " + miss.join(", ") + ". Use the same columns as data/sales.csv."; return; }
        $("d-err").textContent = "";
        uploaded = list.map((r) => Object.assign({ source: "real" }, r));
        store.set("uploaded", uploaded); retrain(); renderData(); toast("Loaded " + list.length + " days. The model has re-learned.");
      };
      rd.readAsText(f);
    };
    $("d-reset").onclick = () => { uploaded = null; store.set("uploaded", null); retrain(); renderData(); toast("Back to the simulated data."); };
    $("d-export").onclick = () => showExport("Dataset used by the model (CSV)", toCSV(rows));
    $("export-close").onclick = () => ($("export").hidden = true);
    $("export-copy").onclick = () => {
      const t = $("export-text");
      (navigator.clipboard ? navigator.clipboard.writeText(t.value) : Promise.reject()).then(() => toast("Copied. Paste it into Excel or a .csv file."))
        .catch(() => { t.focus(); t.select(); toast("Press Ctrl+C to copy the selected text."); });
    };

    showTab((location.hash || "#today").slice(1));
    loadForecast();
  }

  window.GepukPrep = { train, predictRaw, evaluate: (b) => evaluate(b), recommend: (d, n) => recommend(d, n), get model() { return fullModel; }, get rmse() { return rmse; } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
