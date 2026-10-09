// Downloads Realtor.com's monthly ZIP-level listing metrics, combines each city's ZIP codes,
// and writes data/listings.json. These are active-listing figures (what's for sale now),
// published about a week after each month ends, so they run months ahead of sales data.
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://econdata.s3-us-west-2.amazonaws.com/Reports/Core/RDC_Inventory_Core_Metrics_Zip.csv";

// Bump when the fields written below change, so the file is rebuilt even if the month hasn't.
const SCHEMA = 1;

// ZIP codes per city, chosen by hand. Realtor.com's own ZIP names don't follow city limits:
// 94303 is labeled Palo Alto but is mostly East Palo Alto, so it's left out.
const CITY_ZIPS = {
  "Palo Alto": ["94301", "94304", "94306"],
  "Los Altos": ["94022", "94024"],
  "Mountain View": ["94040", "94041", "94043"],
  "Sunnyvale": ["94085", "94086", "94087", "94089"],
  "Santa Clara": ["95050", "95051", "95054"],
  "Cupertino": ["95014"],
  "Menlo Park": ["94025"],
  "Redwood City": ["94061", "94062", "94063", "94065"],
};

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "listings.json");

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

// One CSV line into fields; zip_name is quoted and contains a comma.
function splitCsv(line) {
  const out = [];
  let cur = "", quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const num = (v) => (v === undefined || v === "" ? null : Number(v));

// Weighted mean of [value, weight] pairs, skipping missing values.
function weighted(pairs) {
  let sum = 0, w = 0;
  for (const [v, wt] of pairs) {
    if (v == null || !wt) continue;
    sum += v * wt;
    w += wt;
  }
  return w ? sum / w : null;
}

// Realtor.com's "_yy" columns are a percent change for counts and prices, and a
// difference in points for shares. A blank change on a count means last year was zero.
const priorFromChange = (v, yy) => (v == null || yy == null ? null : yy <= -1 ? null : v / (1 + yy));
const priorCount = (v, yy) => (v == null ? null : yy == null ? 0 : priorFromChange(v, yy));

function combine(rows) {
  const r = rows.map((z) => ({
    active: num(z.active_listing_count),
    total: num(z.total_listing_count),
    newListings: num(z.new_listing_count),
    pending: num(z.pending_listing_count),
    price: num(z.median_listing_price),
    ppsf: num(z.median_listing_price_per_square_foot),
    dom: num(z.median_days_on_market),
    reducedShare: num(z.price_reduced_share),
    yy: {
      active: num(z.active_listing_count_yy),
      total: num(z.total_listing_count_yy),
      newListings: num(z.new_listing_count_yy),
      price: num(z.median_listing_price_yy),
      ppsf: num(z.median_listing_price_per_square_foot_yy),
      dom: num(z.median_days_on_market_yy),
      reducedShare: num(z.price_reduced_share_yy),
    },
  }));
  const sum = (f) => r.reduce((a, z) => a + (f(z) ?? 0), 0);

  // Medians can't be combined exactly across ZIPs; a listing-weighted average of the
  // ZIP medians is a close stand-in. Single-ZIP cities get Realtor.com's exact figure.
  const now = {
    active: sum((z) => z.active),
    newListings: sum((z) => z.newListings),
    pending: sum((z) => z.pending),
    medianListPrice: weighted(r.map((z) => [z.price, z.active])),
    medianListPpsf: weighted(r.map((z) => [z.ppsf, z.active])),
    medianDaysListed: weighted(r.map((z) => [z.dom, z.active])),
    priceCutShare: weighted(r.map((z) => [z.reducedShare, z.total])),
  };
  const p = r.map((z) => ({
    active: priorCount(z.active, z.yy.active),
    total: priorCount(z.total, z.yy.total),
    newListings: priorCount(z.newListings, z.yy.newListings),
    price: priorFromChange(z.price, z.yy.price),
    ppsf: priorFromChange(z.ppsf, z.yy.ppsf),
    dom: priorFromChange(z.dom, z.yy.dom),
    reducedShare: z.reducedShare == null || z.yy.reducedShare == null ? null : z.reducedShare - z.yy.reducedShare,
  }));
  const psum = (f) => (p.some((z) => f(z) == null) ? null : p.reduce((a, z) => a + f(z), 0));
  const yearAgo = {
    active: psum((z) => z.active),
    newListings: psum((z) => z.newListings),
    medianListPrice: weighted(p.map((z) => [z.price, z.active])),
    medianListPpsf: weighted(p.map((z) => [z.ppsf, z.active])),
    medianDaysListed: weighted(p.map((z) => [z.dom, z.active])),
    priceCutShare: weighted(p.map((z) => [z.reducedShare, z.total])),
  };

  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) =>
    [k, v == null ? null : k === "priceCutShare" ? Math.round(v * 1e4) / 1e4 : Math.round(v)]));
  return { now: round(now), yearAgo: round(yearAgo) };
}

async function main() {
  const lines = (await fetchText(SOURCE_URL)).split(/\r?\n/).filter(Boolean);
  const header = splitCsv(lines[0]);
  const required = ["month_date_yyyymm", "postal_code", "active_listing_count", "total_listing_count",
    "new_listing_count", "pending_listing_count", "median_listing_price", "median_listing_price_per_square_foot",
    "median_days_on_market", "price_reduced_share"];
  const missing = required.filter((k) => !header.includes(k));
  if (missing.length) throw new Error(`Realtor.com schema changed; missing columns: ${missing.join(", ")}`);

  const wanted = new Set(Object.values(CITY_ZIPS).flat());
  const byZip = {};
  const months = new Set();
  for (const line of lines.slice(1)) {
    const f = splitCsv(line);
    const row = Object.fromEntries(header.map((k, i) => [k, f[i]]));
    months.add(row.month_date_yyyymm);
    if (wanted.has(row.postal_code)) byZip[row.postal_code] = row;
  }
  if (months.size !== 1) throw new Error(`Expected one month in the file, found: ${[...months].join(", ")}`);
  const ym = [...months][0];
  const month = `${ym.slice(0, 4)}-${ym.slice(4, 6)}`;

  const cities = {};
  for (const [city, zips] of Object.entries(CITY_ZIPS)) {
    const rows = zips.map((z) => byZip[z]).filter(Boolean);
    if (!rows.length) throw new Error(`No Realtor.com rows for ${city} (${zips.join(", ")})`);
    cities[city] = { zips: rows.map((z) => z.postal_code), ...combine(rows) };
  }

  try {
    const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
    if (prev.schema === SCHEMA && prev.month === month) {
      console.log(`No new Realtor.com month (still ${month}); leaving ${OUT} unchanged.`);
      return;
    }
  } catch { /* no previous file */ }

  const payload = {
    schema: SCHEMA,
    updated: new Date().toISOString(),
    month,
    source: "Realtor.com Economic Research (realtor.com/research/data)",
    cities,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));
  console.log(`Wrote ${OUT} for ${month}`);
  for (const [c, v] of Object.entries(cities)) {
    console.log(`  ${c} (${v.zips.join(", ")}): ${v.now.active} active, list $${v.now.medianListPrice?.toLocaleString()}, ` +
      `${v.now.medianDaysListed} days, ${(v.now.priceCutShare * 100).toFixed(1)}% cut`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
