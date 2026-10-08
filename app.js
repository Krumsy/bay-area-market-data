(() => {
  "use strict";

  const MAX_CITIES = 8; // one per categorical color slot; never generate a 9th hue
  const DEFAULT_CITIES = ["San Francisco", "San Jose", "Oakland", "Palo Alto"];
  const RANGES = [
    { id: "1y", label: "1Y", months: 12 },
    { id: "3y", label: "3Y", months: 36 },
    { id: "5y", label: "5Y", months: 60 },
    { id: "10y", label: "10Y", months: 120 },
    { id: "all", label: "All", months: Infinity },
  ];

  const money = (v) =>
    v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 1 : 2)}M` : `$${Math.round(v / 1e3)}K`;
  const METRICS = [
    {
      key: "price", title: "Median sale price",
      note: "Half of homes sold for more, half for less",
      axis: (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`),
      tip: money,
    },
    {
      key: "ppsf", title: "Price per square foot",
      note: "Median sale price ÷ living area",
      axis: (v) => `$${v.toLocaleString()}`,
      tip: (v) => `$${Math.round(v).toLocaleString()}`,
    },
    {
      key: "dom", title: "Days on market",
      note: "Median days from listing to accepted offer",
      axis: (v) => `${v}`,
      tip: (v) => `${Math.round(v)} days`,
    },
    {
      key: "priceDrops", title: "Listings with a price drop",
      note: "Share of active listings that cut their price that month",
      axis: (v) => `${Math.round(v * 100)}%`,
      tip: (v) => `${(v * 100).toFixed(1)}%`,
    },
  ];

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  let data = null;
  const state = {
    range: store.get("bam.range") || "5y",
    smooth: store.get("bam.smooth") ?? true,
    // city -> color slot (0..7). A city keeps its slot while selected, so toggling
    // other cities never repaints it.
    slots: new Map(),
  };
  const charts = {};

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const colorOf = (city) => css(`--s${state.slots.get(city) + 1}`);
  const selected = () => [...state.slots.keys()];

  function addCity(city) {
    if (state.slots.has(city) || state.slots.size >= MAX_CITIES) return;
    const used = new Set(state.slots.values());
    let slot = 0;
    while (used.has(slot)) slot++;
    state.slots.set(city, slot);
  }

  // ---------- data shaping ----------
  function rollingMean(values, n) {
    return values.map((_, i) => {
      const win = values.slice(Math.max(0, i - n + 1), i + 1).filter((v) => v != null);
      return win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
    });
  }

  function seriesFor(metric) {
    const range = RANGES.find((r) => r.id === state.range);
    const allDates = [...new Set(selected().flatMap((c) => data.cities[c].map((r) => r.date)))].sort();
    const labels = range.months === Infinity ? allDates : allDates.slice(-range.months);
    const first = labels[0];
    return {
      labels,
      datasets: selected().map((city) => {
        const rows = data.cities[city];
        const byDate = new Map(rows.map((r) => [r.date, r[metric.key]]));
        // Smooth over the full history so the window's first months aren't truncated averages.
        const fullDates = allDates;
        let vals = fullDates.map((d) => byDate.get(d) ?? null);
        if (state.smooth) vals = rollingMean(vals, 3);
        const start = fullDates.indexOf(first);
        return { city, values: vals.slice(start) };
      }),
    };
  }

  // ---------- chart plugins ----------
  const crosshair = {
    id: "crosshair",
    afterDatasetsDraw(chart) {
      const active = chart.tooltip?.getActiveElements?.() || [];
      if (!active.length) return;
      const x = active[0].element.x;
      const { top, bottom } = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = css("--axis");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  // Direct labels at the line ends when 4 or fewer cities are shown. Text uses ink tokens,
  // not the series color; a short colored stroke carries identity.
  const endLabels = {
    id: "endLabels",
    afterDatasetsDraw(chart) {
      if (chart.data.datasets.length > 4) return;
      const ctx = chart.ctx;
      const items = [];
      chart.data.datasets.forEach((ds, i) => {
        const meta = chart.getDatasetMeta(i);
        for (let j = ds.data.length - 1; j >= 0; j--) {
          if (ds.data[j] != null) {
            items.push({ y: meta.data[j].y, x: meta.data[j].x, label: ds.label, color: ds.borderColor });
            break;
          }
        }
      });
      items.sort((a, b) => a.y - b.y);
      const gap = 14;
      for (let i = 1; i < items.length; i++) {
        if (items[i].y - items[i - 1].y < gap) items[i].y = items[i - 1].y + gap;
      }
      const overflow = items.length ? items.at(-1).y - chart.chartArea.bottom : 0;
      if (overflow > 0) items.forEach((it) => (it.y -= overflow));
      ctx.save();
      ctx.font = "12px system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.textBaseline = "middle";
      const x0 = chart.chartArea.right + 8;
      for (const it of items) {
        ctx.strokeStyle = it.color;
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x0, it.y);
        ctx.lineTo(x0 + 8, it.y);
        ctx.stroke();
        ctx.fillStyle = css("--text-secondary");
        ctx.fillText(it.label, x0 + 12, it.y);
      }
      ctx.restore();
    },
  };

  // ---------- rendering ----------
  function shortDate(d) {
    const [y, m] = d.split("-");
    return new Date(+y, +m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }

  function buildCards() {
    const grid = document.getElementById("charts");
    for (const m of METRICS) {
      const card = document.createElement("section");
      card.className = "card";
      const h = document.createElement("h2");
      h.textContent = m.title;
      const note = document.createElement("p");
      note.className = "card-note";
      note.textContent = m.note;
      const box = document.createElement("div");
      box.className = "chart-box";
      const canvas = document.createElement("canvas");
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `${m.title} by city over time. Values are in the table below.`);
      box.append(canvas);
      card.append(h, note, box);
      grid.append(card);
      charts[m.key] = new Chart(canvas, chartConfig(m));
    }
  }

  function chartConfig(m) {
    return {
      type: "line",
      data: { labels: [], datasets: [] },
      plugins: [crosshair, endLabels],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        spanGaps: true,
        interaction: { mode: "index", intersect: false },
        layout: { padding: { right: 0 } },
        elements: {
          line: { borderWidth: 2, tension: 0.25 },
          point: { radius: 0, hoverRadius: 4, hitRadius: 12, hoverBorderWidth: 2 },
        },
        scales: {
          x: {
            grid: { display: false },
            border: {},
            ticks: { maxTicksLimit: 6, maxRotation: 0, callback(v) { return shortDate(this.getLabelForValue(v)); } },
          },
          y: {
            grid: { drawTicks: false },
            border: { display: false },
            ticks: { maxTicksLimit: 6, padding: 8, callback: (v) => m.axis(v) },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            usePointStyle: true,
            boxWidth: 12,
            boxHeight: 2,
            padding: 10,
            itemSort: (a, b) => b.parsed.y - a.parsed.y,
            callbacks: {
              title: (items) => shortDate(items[0].label),
              label: (item) => ` ${m.tip(item.parsed.y)}  ${item.dataset.label}`,
              labelPointStyle: () => ({ pointStyle: "line", rotation: 0 }),
            },
          },
        },
      },
    };
  }

  function applyTheme(chart) {
    const muted = css("--text-muted");
    const o = chart.options;
    o.scales.x.ticks.color = muted;
    o.scales.y.ticks.color = muted;
    o.scales.y.grid.color = css("--grid");
    o.scales.x.border.color = css("--axis");
    const t = o.plugins.tooltip;
    t.backgroundColor = css("--surface");
    t.titleColor = css("--text-secondary");
    t.bodyColor = css("--text-primary");
    t.borderColor = css("--border");
    t.borderWidth = 1;
    o.layout.padding.right = chart.data.datasets.length <= 4 ? 110 : 0;
  }

  function renderCharts() {
    for (const m of METRICS) {
      const chart = charts[m.key];
      const { labels, datasets } = seriesFor(m);
      chart.data.labels = labels;
      chart.data.datasets = datasets.map(({ city, values }) => ({
        label: city,
        data: values,
        borderColor: colorOf(city),
        backgroundColor: colorOf(city),
        pointBackgroundColor: colorOf(city),
        pointBorderColor: css("--surface"),
      }));
      applyTheme(chart);
      chart.update();
    }
  }

  function renderTable() {
    const tbody = document.querySelector("#latest tbody");
    tbody.replaceChildren();
    let latestDate = "";
    for (const city of selected()) {
      const rows = data.cities[city];
      const last = rows.at(-1);
      latestDate = last.date > latestDate ? last.date : latestDate;
      const yearAgo = rows.find((r) => r.date.slice(0, 7) === `${+last.date.slice(0, 4) - 1}${last.date.slice(4, 7)}`);
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      const key = document.createElement("span");
      key.className = "key";
      key.style.background = colorOf(city);
      name.append(key, document.createTextNode(city));
      const yoy = document.createElement("td");
      if (yearAgo?.price && last.price) {
        const pct = (last.price / yearAgo.price - 1) * 100;
        yoy.textContent = `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}%`;
        yoy.className = pct >= 0 ? "up" : "down";
      } else yoy.textContent = "—";
      const cell = (text) => { const td = document.createElement("td"); td.textContent = text; return td; };
      tr.append(
        name,
        cell(last.price != null ? money(last.price) : "—"),
        yoy,
        cell(last.ppsf != null ? `$${last.ppsf.toLocaleString()}` : "—"),
        cell(last.dom != null ? `${last.dom}` : "—"),
        cell(last.priceDrops != null ? `${(last.priceDrops * 100).toFixed(1)}%` : "—"),
      );
      tbody.append(tr);
    }
    document.getElementById("table-note").textContent =
      latestDate ? `${shortDate(latestDate)}, unsmoothed. YoY compares median sale price with the same month last year.` : "";
  }

  function renderControls() {
    const range = document.getElementById("range");
    range.replaceChildren(...RANGES.map((r) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = r.label;
      b.setAttribute("aria-pressed", String(r.id === state.range));
      b.onclick = () => { state.range = r.id; store.set("bam.range", r.id); render(); };
      return b;
    }));

    const full = state.slots.size >= MAX_CITIES;
    document.getElementById("city-hint").textContent = `up to ${MAX_CITIES}`;
    const chips = document.getElementById("cities");
    chips.replaceChildren(...Object.keys(data.cities).sort().map((city) => {
      const on = state.slots.has(city);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.setAttribute("aria-pressed", String(on));
      b.disabled = !on && full;
      const key = document.createElement("span");
      key.className = "key";
      if (on) key.style.background = colorOf(city);
      b.append(key, document.createTextNode(city));
      b.onclick = () => {
        if (on) {
          if (state.slots.size === 1) return; // keep at least one city
          state.slots.delete(city);
        } else addCity(city);
        store.set("bam.cities", selected());
        render();
      };
      return b;
    }));
  }

  function render() {
    renderControls();
    renderCharts();
    renderTable();
  }

  async function init() {
    const res = await fetch("data/market.json", { cache: "no-cache" });
    data = await res.json();

    const saved = (store.get("bam.cities") || []).filter((c) => c in data.cities);
    (saved.length ? saved : DEFAULT_CITIES).forEach(addCity);

    const smooth = document.getElementById("smooth");
    smooth.checked = state.smooth;
    smooth.onchange = () => { state.smooth = smooth.checked; store.set("bam.smooth", state.smooth); renderCharts(); };

    // Redfin stamps look like "2026-06-02 14:33:24.470 Z"; make them ISO so every browser parses them.
    const published = new Date((data.sourceUpdated || data.updated).replace(" Z", "Z").replace(" ", "T"));
    document.getElementById("updated").textContent =
      `Redfin data published ${published.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.`;

    Chart.defaults.font.family = "system-ui, -apple-system, 'Segoe UI', sans-serif";
    Chart.defaults.font.size = 12;
    buildCards();
    render();

    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  }

  init().catch((e) => {
    document.getElementById("charts").textContent = "Couldn't load market data.";
    console.error(e);
  });
})();
