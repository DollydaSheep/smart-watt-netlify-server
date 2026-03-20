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

const TABLE = "energy_readings_aggregate";
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

  // current app assumes Asia/Manila
  if (tz === "Asia/Manila") {
    const utc = new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
    return utc.toISOString();
  }

  // fallback
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
  return `${hour12.toString()}${ampm}`;
}

function average(values) {
  if (!values.length) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return Number((sum / values.length).toFixed(2));
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

async function fetchRows(startIso, endIso) {
  const pageSize = 1000;
  let from = 0;
  let allRows = [];

  while (true) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("recorded_at, power_w")
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
    const { error } = await supabase.from(TABLE).select("id").limit(1);
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

    const rows = await fetchRows(startIso, endIso);

    const buckets = {};
    for (let h = 0; h < 24; h += 2) {
      buckets[h] = [];
    }

    for (const row of rows) {
      if (row.power_w == null) continue;
      const local = getLocalHourAndDate(row.recorded_at, tz);
      if (local.date !== date) continue;

      const bucketHour = Math.floor(local.hour / 2) * 2;
      if (buckets[bucketHour]) {
        buckets[bucketHour].push(Number(row.power_w));
      }
    }

    const data = [];
    for (let h = 0; h < 24; h += 2) {
      data.push({
        label: formatHourLabel(h),
        power_w: average(buckets[h]),
      });
    }

    res.json({
      period: "daily",
      date,
      timezone: tz,
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

    const startIso = toUtcISOStringFromLocal(sunday, 0, 0, 0, tz);
    const endIso = toUtcISOStringFromLocal(nextSunday, 0, 0, 0, tz);

    console.log("anchorDate:", anchorDate);
    console.log("sunday:", sunday);
    console.log("nextSunday:", nextSunday);
    console.log("startIso:", startIso);
    console.log("endIso:", endIso);

    const rows = await fetchRows(startIso, endIso);

    console.log("weekly rows count:", rows.length);

    const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayMap = {};

    for (let i = 0; i < 7; i++) {
      const d = addDays(sunday, i);
      dayMap[d] = [];
    }

    for (const row of rows) {
      if (row.power_w == null) continue;

      const local = getLocalHourAndDate(row.recorded_at, tz);

      if (dayMap[local.date]) {
        dayMap[local.date].push(Number(row.power_w));
      }
    }

    const data = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(sunday, i);
      data.push({
        label: labels[i],
        date: d,
        power_w: average(dayMap[d]),
      });
    }

    console.log("weekly data:", data);

    res.json({
      period: "weekly",
      anchorDate,
      weekStart: sunday,
      weekEnd: addDays(sunday, 6),
      timezone: tz,
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

    const startIso = toUtcISOStringFromLocal(monthStart, 0, 0, 0, tz);
    const endIso = toUtcISOStringFromLocal(nextMonthStart, 0, 0, 0, tz);

    const rows = await fetchRows(startIso, endIso);

    const dayMap = {};
    for (let day = 1; day <= lastDay; day++) {
      const d = `${monthStart.slice(0, 8)}${String(day).padStart(2, "0")}`;
      dayMap[d] = [];
    }

    for (const row of rows) {
      if (row.power_w == null) continue;
      const local = getLocalHourAndDate(row.recorded_at, tz);
      if (dayMap[local.date]) {
        dayMap[local.date].push(Number(row.power_w));
      }
    }

    const data = [];
    for (let day = 1; day <= lastDay; day++) {
      const d = `${monthStart.slice(0, 8)}${String(day).padStart(2, "0")}`;
      data.push({
        label: String(day),
        date: d,
        power_w: average(dayMap[d]),
      });
    }

    res.json({
      period: "monthly",
      anchorDate,
      monthStart,
      monthEnd: `${monthStart.slice(0, 8)}${String(lastDay).padStart(2, "0")}`,
      timezone: tz,
      data,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

app.use('/.netlify/functions/api', router);

module.exports.handler = serverless(app);