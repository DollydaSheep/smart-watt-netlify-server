const express = require("express");
const serverless = require("serverless-http");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json());
const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const RAW_TABLE = "energy_readings_aggregate";
const DAILY_TABLE = "energy_readings_aggregate_daily";
const DEFAULT_TZ = "Asia/Manila";

function getLocalDateParts(date = new Date(), timeZone = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);

  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: map.weekday,
    isoDate: `${map.year}-${map.month}-${map.day}`,
  };
}

function getDateString(inputDate, timeZone = DEFAULT_TZ) {
  if (inputDate) return inputDate;
  return getLocalDateParts(new Date(), timeZone).isoDate;
}

function parseDateOnly(yyyyMmDd) {
  const [year, month, day] = yyyyMmDd.split("-").map(Number);
  return { year, month, day };
}

function toUtcISOStringFromLocal(dateStr, hour = 0, minute = 0, second = 0, tz = DEFAULT_TZ) {
  const [year, month, day] = dateStr.split("-").map(Number);

  if (tz === "Asia/Manila") {
    const utc = new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
    return utc.toISOString();
  }

  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return utc.toISOString();
}

function addDays(dateStr, days) {
  const { year, month, day } = parseDateOnly(dateStr);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function getDayOfWeekSunday0(dateStr) {
  const { year, month, day } = parseDateOnly(dateStr);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function formatHourLabel(hour24) {
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const ampm = hour24 < 12 ? "AM" : "PM";
  return `${hour12}${ampm}`;
}

function sumEnergyKwh(values) {
  if (!values.length) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number(total.toFixed(4));
}

function getMonthBounds(dateStr) {
  const { year, month } = parseDateOnly(dateStr);
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth =
    month === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(month + 1).padStart(2, "0")}-01`;

  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return {
    monthStart: first,
    nextMonthStart: nextMonth,
    lastDay: lastDate,
  };
}

async function fetchRawRows(startIso, endIso) {
  const pageSize = 1000;
  let from = 0;
  let allRows = [];

  while (true) {
    const { data, error } = await supabase
      .from(RAW_TABLE)
      .select("recorded_at, power_w, energy_kwh")
      .gte("recorded_at", startIso)
      .lt("recorded_at", endIso)
      .order("recorded_at", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    allRows = allRows.concat(data);

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return allRows;
}

async function fetchDailyAggregateRows(startDate, endDate) {
  const pageSize = 1000;
  let from = 0;
  let allRows = [];

  while (true) {
    const { data, error } = await supabase
      .from(DAILY_TABLE)
      .select("reading_date, avg_power_w, avg_voltage, avg_current, total_energy_kwh")
      .gte("reading_date", startDate)
      .lt("reading_date", endDate)
      .order("reading_date", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    allRows = allRows.concat(data);

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return allRows;
}

function getLocalHourAndDate(isoString, timeZone = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(isoString));

  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }

  return {
    date: `${map.year}-${map.month}-${map.day}`,
    hour: Number(map.hour),
  };
}

router.get("/", (_req, res) => {
  res.json({ ok: true, message: "API root works" });
});

router.get("/health", async (_req, res) => {
  try {
    const { error } = await supabase.from(RAW_TABLE).select("id").limit(1);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

router.get("/power/daily", async (req, res) => {
  try {
    const tz = req.query.tz || DEFAULT_TZ;
    const date = getDateString(req.query.date, tz);

    const startIso = toUtcISOStringFromLocal(date, 0, 0, 0, tz);
    const endIso = toUtcISOStringFromLocal(addDays(date, 1), 0, 0, 0, tz);

    const rows = await fetchRawRows(startIso, endIso);

    const buckets = {};
    const totalEnergyValues = [];

    for (let h = 0; h < 24; h += 2) {
      buckets[h] = [];
    }

    for (const row of rows) {
      const local = getLocalHourAndDate(row.recorded_at, tz);
      if (local.date !== date) continue;

      const energy = Number(row.energy_kwh || 0);
      totalEnergyValues.push(energy);

      const bucketHour = Math.floor(local.hour / 2) * 2;
      if (buckets[bucketHour]) {
        buckets[bucketHour].push(energy);
      }
    }

    const data = [];
    for (let h = 0; h < 24; h += 2) {
      data.push({
        label: formatHourLabel(h),
        energy_kwh: sumEnergyKwh(buckets[h]),
      });
    }

    res.json({
      period: "daily",
      metric: "energy_kwh",
      source_table: RAW_TABLE,
      date,
      timezone: tz,
      total_energy_kwh: sumEnergyKwh(totalEnergyValues),
      data,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

router.get("/power/weekly", async (req, res) => {
  try {
    const tz = req.query.tz || DEFAULT_TZ;
    const anchorDate = getDateString(req.query.date, tz);

    const dow = getDayOfWeekSunday0(anchorDate);
    const sunday = addDays(anchorDate, -dow);
    const nextSunday = addDays(sunday, 7);

    const rows = await fetchDailyAggregateRows(sunday, nextSunday);

    const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const rowMap = {};
    let totalEnergy = 0;

    for (const row of rows) {
      rowMap[row.reading_date] = row;
      totalEnergy += Number(row.total_energy_kwh || 0);
    }

    const data = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(sunday, i);
      const row = rowMap[d];

      data.push({
        label: labels[i],
        date: d,
        energy_kwh: Number(row?.total_energy_kwh || 0),
        avg_power_w: Number(row?.avg_power_w || 0),
        avg_voltage: Number(row?.avg_voltage || 0),
        avg_current: Number(row?.avg_current || 0),
      });
    }

    res.json({
      period: "weekly",
      metric: "energy_kwh",
      source_table: DAILY_TABLE,
      anchorDate,
      weekStart: sunday,
      weekEnd: addDays(sunday, 6),
      timezone: tz,
      total_energy_kwh: Number(totalEnergy.toFixed(4)),
      data,
    });
  } catch (err) {
    console.error("weekly route error:", err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

router.get("/power/monthly", async (req, res) => {
  try {
    const tz = req.query.tz || DEFAULT_TZ;
    const anchorDate = getDateString(req.query.date, tz);

    const { monthStart, nextMonthStart, lastDay } = getMonthBounds(anchorDate);

    const rows = await fetchDailyAggregateRows(monthStart, nextMonthStart);

    const rowMap = {};
    let totalEnergy = 0;

    for (const row of rows) {
      rowMap[row.reading_date] = row;
      totalEnergy += Number(row.total_energy_kwh || 0);
    }

    const data = [];
    for (let day = 1; day <= lastDay; day++) {
      const d = `${monthStart.slice(0, 8)}${String(day).padStart(2, "0")}`;
      const row = rowMap[d];

      data.push({
        label: String(day),
        date: d,
        energy_kwh: Number(row?.total_energy_kwh || 0),
        avg_power_w: Number(row?.avg_power_w || 0),
        avg_voltage: Number(row?.avg_voltage || 0),
        avg_current: Number(row?.avg_current || 0),
      });
    }

    res.json({
      period: "monthly",
      metric: "energy_kwh",
      source_table: DAILY_TABLE,
      anchorDate,
      monthStart,
      monthEnd: `${monthStart.slice(0, 8)}${String(lastDay).padStart(2, "0")}`,
      timezone: tz,
      total_energy_kwh: Number(totalEnergy.toFixed(4)),
      data,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

app.use("/.netlify/functions/api", router);

module.exports.handler = serverless(app);