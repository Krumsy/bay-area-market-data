# Bay Area Market Data

Monthly housing market charts for 17 Bay Area cities:

- Median sale price
- Price per square foot
- Days on market
- Share of listings with a price drop

Sales data comes from the [Redfin Data Center](https://www.redfin.com/news/data-center/)
city market tracker (monthly, not seasonally adjusted), written to `data/market.json`.

Current listing data (active listings, list prices, days listed, price cuts) comes from
[Realtor.com Economic Research](https://www.realtor.com/research/data/) ZIP-level
metrics, combined per city in `scripts/fetch_listings.mjs` and written to
`data/listings.json`. It covers the 8 cities on the WordPress site; each city's ZIP
codes are listed in `CITY_ZIPS`.

## How it updates

`.github/workflows/update.yml` runs every Monday (and on demand). It runs
`scripts/fetch_data.mjs` (streams Redfin's ~1 GB file and keeps the Bay Area cities)
and `scripts/fetch_listings.mjs` (Realtor.com's listing metrics). If the data changed, the workflow commits
it. Then it redeploys the site to GitHub Pages.

The script exits with an error, and the site stays on the last good data, when
Redfin's columns change or a city comes back empty or ambiguous.

## Setup (one time)

1. Create a GitHub repo and push this folder to `main`.
2. In the repo go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
3. Under **Actions**, run **Update market data** once. The Pages URL appears in the run summary.

## Run locally

Requires Node 18 or newer.

```bash
node scripts/fetch_data.mjs
npx serve .
```

## Add or change cities

Edit `CITIES` in `scripts/fetch_data.mjs`, using Redfin's city name. If a name
matches more than one place in the Bay Area, pin it in `METRO_OVERRIDE`.
