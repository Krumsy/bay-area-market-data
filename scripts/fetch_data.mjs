// Downloads Redfin's city market tracker, keeps Bay Area cities, writes data/market.json.
// Zero dependencies: streams the ~1 GB gzip so memory stays small.
import https from "node:https";
import zlib from "node:zlib";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL =
  "https://redfin-public-data.s3.us-west-2.amazonaws.com/redfin_market_tracker/city_market_tracker.tsv000.gz";

const CITIES = [
  "San Francisco", "Oakland", "San Jose", "Palo Alto", "Mountain View",
  "Sunnyvale", "Cupertino", "Fremont", "Berkeley", "Walnut Creek",
  "San Mateo", "Redwood City", "Santa Clara", "Pleasanton", "Hayward",
  "Los Altos", "Menlo Park",
];
const REGIONS = new Map(CITIES.map((c) => [`${c}, CA`, c]));
// Some names repeat elsewhere in CA (e.g. a second "Mountain View"), so also require a Bay Area metro.
const BAY_AREA_METRO = /^(San Francisco|Oakland|San Jose|San Rafael|Santa Rosa|Vallejo|Napa|Santa Cruz), CA/;
// Cities whose name also matches a different place inside the Bay Area.
const METRO_OVERRIDE = { "Mountain View": /^San Jose, CA/ }; // vs. the Contra Costa CDP

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "market.json");

const num = (v) => (v === "" || v === undefined || v === "NA" ? null : Number(v));
const unquote = (s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

function fetchStream(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      resolve(res);
    }).on("error", reject);
  });
}

async function main() {
  const res = await fetchStream(SOURCE_URL);
  const rl = readline.createInterface({ input: res.pipe(zlib.createGunzip()), crlfDelay: Infinity });

  let col = null;
  let lastUpdated = null;
  const out = Object.fromEntries(CITIES.map((c) => [c, []]));
  let scanned = 0;
  const skippedMetros = new Set();

  for await (const line of rl) {
    const f = line.split("\t").map(unquote);
    if (!col) {
      col = Object.fromEntries(f.map((name, i) => [name, i]));
      const required = ["REGION", "STATE_CODE", "PROPERTY_TYPE", "IS_SEASONALLY_ADJUSTED", "PERIOD_END",
        "MEDIAN_SALE_PRICE", "MEDIAN_PPSF", "MEDIAN_DOM", "PRICE_DROPS", "HOMES_SOLD", "INVENTORY",
        "PARENT_METRO_REGION"];
      const missing = required.filter((k) => !(k in col));
      if (missing.length) throw new Error(`Redfin schema changed; missing columns: ${missing.join(", ")}`);
      continue;
    }
    if (++scanned % 1_000_000 === 0) console.log(`scanned ${scanned.toLocaleString()} rows`);
    if (f[col.STATE_CODE] !== "CA") continue;
    const city = REGIONS.get(f[col.REGION]);
    if (!city) continue;
    if (f[col.PROPERTY_TYPE] !== "All Residential" || f[col.IS_SEASONALLY_ADJUSTED] !== "false") continue;
    if (!(METRO_OVERRIDE[city] || BAY_AREA_METRO).test(f[col.PARENT_METRO_REGION])) {
      skippedMetros.add(`${city} -> ${f[col.PARENT_METRO_REGION]}`);
      continue;
    }

    out[city].push({
      date: f[col.PERIOD_END],
      price: num(f[col.MEDIAN_SALE_PRICE]),
      ppsf: num(f[col.MEDIAN_PPSF]) && Math.round(num(f[col.MEDIAN_PPSF])),
      dom: num(f[col.MEDIAN_DOM]),
      priceDrops: num(f[col.PRICE_DROPS]),
      sold: num(f[col.HOMES_SOLD]),
      inventory: num(f[col.INVENTORY]),
    });
    if ("LAST_UPDATED" in col) lastUpdated = f[col.LAST_UPDATED];
  }

  if (skippedMetros.size) console.log(`Skipped same-name places in other metros: ${[...skippedMetros].join("; ")}`);
  const empty = CITIES.filter((c) => out[c].length === 0);
  if (empty.length) throw new Error(`No rows found for: ${empty.join(", ")}`);

  for (const c of CITIES) {
    out[c].sort((a, b) => a.date.localeCompare(b.date));
    const dupe = out[c].find((r, i) => i && r.date === out[c][i - 1].date);
    if (dupe) throw new Error(`Duplicate ${dupe.date} rows for ${c}; region match is ambiguous`);
  }

  // Redfin republishes monthly; skip the write when nothing is new so the workflow makes no commit.
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
    if (prev.sourceUpdated && prev.sourceUpdated === lastUpdated) {
      console.log(`No new Redfin data (still ${lastUpdated}); leaving ${OUT} unchanged.`);
      return;
    }
  } catch { /* no previous file */ }

  const payload = {
    updated: new Date().toISOString(),
    sourceUpdated: lastUpdated,
    source: "Redfin Data Center (redfin.com/news/data-center)",
    cities: out,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));
  console.log(`Wrote ${OUT}`);
  for (const c of CITIES) console.log(`  ${c}: ${out[c].length} months, latest ${out[c].at(-1).date}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
