// Downloads Redfin's Data Center city market data + price drops + metro affordability,
// keeps Bay Area cities/metros, writes data/market.json.
//
// Redfin retired the old redfin_market_tracker/*.tsv000.gz files in late 2026 and moved
// everything under redfin_data_center/, catalogued by index.json. We read those paths so
// the pipeline survives future moves. Files are plain (large) CSVs streamed line by line.
import https from "node:https";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_data_center/";

const CITIES = [
  "San Francisco", "Oakland", "San Jose", "Palo Alto", "Mountain View",
  "Sunnyvale", "Cupertino", "Fremont", "Berkeley", "Walnut Creek",
  "San Mateo", "Redwood City", "Santa Clara", "Pleasanton", "Hayward",
  "Los Altos", "Menlo Park",
];
const REGIONS = new Map(CITIES.map((c) => [`${c}, CA`, c]));

// Which metro's affordability figures apply to each city (Redfin only publishes
// affordability at the metro level). San Mateo County cities fall in the SF metro.
const CITY_METRO = {
  "San Jose": "San Jose", "Palo Alto": "San Jose", "Mountain View": "San Jose",
  "Sunnyvale": "San Jose", "Cupertino": "San Jose", "Santa Clara": "San Jose",
  "Los Altos": "San Jose",
  "San Francisco": "San Francisco", "Oakland": "San Francisco", "Berkeley": "San Francisco",
  "Fremont": "San Francisco", "Hayward": "San Francisco", "Walnut Creek": "San Francisco",
  "Pleasanton": "San Francisco", "San Mateo": "San Francisco", "Redwood City": "San Francisco",
  "Menlo Park": "San Francisco",
};
const AFF_METROS = new Map([
  ["San Jose, CA metro area", "San Jose"],
  ["San Francisco, CA metro area", "San Francisco"],
]);

// Bump when the fields written below change, so the file is rebuilt even if Redfin's
// publish date is unchanged.
const SCHEMA = 4;

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "market.json");

const num = (v) => (v === "" || v == null || v === "NA" ? null : Number(v));
const pct = (v) => { const n = num(v); return n == null ? null : Math.round(n / 100 * 1e4) / 1e4; };

// Quote-aware CSV line parser (fields may contain commas, e.g. "Palo Alto, CA").
function parseCsv(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "bay-area-market-data/1.0 (+github actions)" } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      resolve(res);
    }).on("error", reject);
  });
}

// Stream a CSV, calling onRow(colIndexMap, fields) for each data row.
async function streamCsv(url, required, onRow) {
  const res = await get(url);
  const rl = readline.createInterface({ input: res, crlfDelay: Infinity });
  let col = null;
  for await (const line of rl) {
    if (!line) continue;
    const f = parseCsv(line);
    if (!col) {
      col = Object.fromEntries(f.map((name, i) => [name.trim(), i]));
      const missing = required.filter((k) => !(k in col));
      if (missing.length) throw new Error(`${url}\n  missing columns: ${missing.join(", ")}`);
      continue;
    }
    onRow(col, f);
  }
}

async function loadIndex() {
  const res = await get(BASE + "index.json");
  let s = "";
  for await (const chunk of res) s += chunk;
  const j = JSON.parse(s);
  return {
    cityUrl:  BASE + j.housing_market.monthly.city.all,
    dropsUrl: BASE + j.price_drops.monthly.city.all,
    affUrl:   BASE + j.affordability.metro.all,
  };
}

async function main() {
  const idx = await loadIndex();

  // 1) City housing metrics (all residential). New file is rolling 3-month, published monthly.
  const out = Object.fromEntries(CITIES.map((c) => [c, new Map()])); // city -> date -> row
  let sourceUpdated = null;
  await streamCsv(idx.cityUrl,
    ["LAST UPDATED", "PERIOD END", "REGION TYPE", "REGION NAME", "HOMES SOLD",
     "MEDIAN SALE PRICE NSA ($)", "MEDIAN SALE PRICE PER SQ.FT. ($)", "MEDIAN DAYS ON MARKET (DAYS)",
     "AVERAGE SALE TO LIST RATIO (%)", "SHARE SOLD ABOVE ORIGINAL LIST (%)", "INVENTORY"],
    (col, f) => {
      if (f[col["REGION TYPE"]] !== "City") return;
      const city = REGIONS.get(f[col["REGION NAME"]]);
      if (!city) return;
      sourceUpdated = f[col["LAST UPDATED"]] || sourceUpdated;
      const date = f[col["PERIOD END"]];
      const sold = num(f[col["HOMES SOLD"]]);
      const row = {
        date,
        price: num(f[col["MEDIAN SALE PRICE NSA ($)"]]),
        ppsf: num(f[col["MEDIAN SALE PRICE PER SQ.FT. ($)"]]),
        dom: num(f[col["MEDIAN DAYS ON MARKET (DAYS)"]]),
        priceDrops: null, // filled from the price_drops dataset below
        saleToList: pct(f[col["AVERAGE SALE TO LIST RATIO (%)"]]),
        soldAboveList: pct(f[col["SHARE SOLD ABOVE ORIGINAL LIST (%)"]]),
        sold,
        inventory: num(f[col["INVENTORY"]]),
      };
      const prev = out[city].get(date);
      // Same-name places can collide; keep the row with the most sales (the real city).
      if (!prev || (sold ?? -1) > (prev.sold ?? -1)) out[city].set(date, row);
    });

  // 2) Price drops (restores the metric Redfin moved out of the city housing file).
  await streamCsv(idx.dropsUrl,
    ["PERIOD END", "REGION TYPE", "REGION NAME", "PERCENT ACTIVE WITH PRICE DROPS (%)"],
    (col, f) => {
      if (f[col["REGION TYPE"]] !== "City") return;
      const city = REGIONS.get(f[col["REGION NAME"]]);
      if (!city) return;
      const row = out[city].get(f[col["PERIOD END"]]);
      if (row) row.priceDrops = pct(f[col["PERCENT ACTIVE WITH PRICE DROPS (%)"]]);
    });

  // 3) Metro affordability (All Residential, all income groups, 20% down).
  const aff = Object.fromEntries([...AFF_METROS.values()].map((m) => [m, new Map()]));
  await streamCsv(idx.affUrl,
    ["PERIOD END", "REGION NAME", "PROPERTY TYPE", "INCOME GROUP", "DOWN PAYMENT PERCENT (%)",
     "INCOME REQUIRED ($)", "YEARS TO SAVE DOWN PAYMENT", "SHARE OF INCOME ON HOUSING (%)",
     "MONTHLY HOUSING PAYMENT ($)", "DOWN PAYMENT AMOUNT ($)", "MEDIAN SALE PRICE ($)"],
    (col, f) => {
      const metro = AFF_METROS.get(f[col["REGION NAME"]]);
      if (!metro) return;
      if (f[col["PROPERTY TYPE"]] !== "All Residential") return;
      if (f[col["INCOME GROUP"]] !== "All") return;
      if (f[col["DOWN PAYMENT PERCENT (%)"]] !== "20") return;
      const date = f[col["PERIOD END"]];
      aff[metro].set(date, {
        date,
        incomeRequired: num(f[col["INCOME REQUIRED ($)"]]),
        yearsToSave: num(f[col["YEARS TO SAVE DOWN PAYMENT"]]),
        shareIncome: num(f[col["SHARE OF INCOME ON HOUSING (%)"]]),
        monthly: num(f[col["MONTHLY HOUSING PAYMENT ($)"]]),
        downPayment: num(f[col["DOWN PAYMENT AMOUNT ($)"]]),
        medianPrice: num(f[col["MEDIAN SALE PRICE ($)"]]),
      });
    });

  // Finalize: sort rows by date, validate coverage.
  const cities = {};
  for (const c of CITIES) {
    cities[c] = [...out[c].values()].sort((a, b) => a.date.localeCompare(b.date));
  }
  const empty = CITIES.filter((c) => cities[c].length === 0);
  if (empty.length) throw new Error(`No city rows for: ${empty.join(", ")}`);

  const affordability = { downPaymentPct: 20, metros: {}, cityMetro: CITY_METRO };
  for (const m of AFF_METROS.values()) {
    affordability.metros[m] = [...aff[m].values()].sort((a, b) => a.date.localeCompare(b.date));
    if (!affordability.metros[m].length) throw new Error(`No affordability rows for ${m} metro`);
  }

  // Skip the write when nothing is new so the workflow makes no commit.
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
    if (prev.schema === SCHEMA && prev.sourceUpdated && prev.sourceUpdated === sourceUpdated) {
      console.log(`No new Redfin data (still ${sourceUpdated}); leaving ${OUT} unchanged.`);
      return;
    }
  } catch { /* no previous file */ }

  const payload = {
    schema: SCHEMA,
    updated: new Date().toISOString(),
    sourceUpdated,
    source: "Redfin Data Center (redfin.com/news/data-center)",
    cities,
    byType: {}, // Redfin's new city file has no property-type breakdown.
    affordability,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));
  console.log(`Wrote ${OUT} (sourceUpdated ${sourceUpdated})`);
  for (const c of CITIES) {
    const last = cities[c].at(-1);
    console.log(`  ${c}: ${cities[c].length} periods, latest ${last.date} $${last.price} dom ${last.dom} drops ${last.priceDrops}`);
  }
  for (const m of AFF_METROS.values()) {
    const a = affordability.metros[m].at(-1);
    console.log(`  [${m} affordability] ${a.date}: income req $${a.incomeRequired}, ${a.yearsToSave} yrs to save, ${a.shareIncome}% of income`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
