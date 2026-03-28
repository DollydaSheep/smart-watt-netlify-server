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

function addDays(dateStr, days) {
  const { year, month, day } = parseDateOnly(dateStr);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMonths(dateStr, months) {
  const { year, month, day } = parseDateOnly(dateStr);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCMonth(d.getUTCMonth() + months);
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

async function fetchDailyAggregateRows(startDate, endDate) {
  const pageSize = 1000;
  let from = 0;
  let allRows = [];

  while (true) {
    const { data, error } = await supabase
      .from(DAILY_TABLE)
      .select(
        "reading_date, avg_power_w, avg_voltage, avg_current, total_energy_kwh, hourly_power_w_avg, hourly_kwh"
      )
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

async function fetchDailyAggregateRow(date) {
  const { data, error } = await supabase
    .from(DAILY_TABLE)
    .select(
      "reading_date, avg_power_w, avg_voltage, avg_current, total_energy_kwh, hourly_power_w_avg, hourly_kwh"
    )
    .eq("reading_date", date)
    .maybeSingle();

  if (error) throw error;
  return data;
}

function getJsonNumber(obj, key) {
  if (!obj || typeof obj !== "object") return 0;
  const value = obj[key];
  return Number(value || 0);
}

function buildDailyChartData(row) {
  const hourlyKwh = row?.hourly_kwh || {};
  const hourlyPowerAvg = row?.hourly_power_w_avg || {};

  const data = [];
  for (let h = 0; h < 24; h += 2) {
    const h1 = `${String(h).padStart(2, "0")}:00`;
    const h2 = `${String(h + 1).padStart(2, "0")}:00`;

    data.push({
      label: formatHourLabel(h),
      start_hour: h1,
      end_hour: h2,
      energy_kwh: Number(
        (getJsonNumber(hourlyKwh, h1) + getJsonNumber(hourlyKwh, h2)).toFixed(6)
      ),
      avg_power_w: {
        [h1]: Number(getJsonNumber(hourlyPowerAvg, h1).toFixed(4)),
        [h2]: Number(getJsonNumber(hourlyPowerAvg, h2).toFixed(4)),
      },
    });
  }

  return data;
}

function buildCurrentDailySummary(row, date, tz) {
  return {
    date,
    total_energy_kwh: Number(row?.total_energy_kwh || 0),
    avg_power_w: Number(row?.avg_power_w || 0),
    avg_voltage: Number(row?.avg_voltage || 0),
    avg_current: Number(row?.avg_current || 0),
    data: buildDailyChartData(row),
    timezone: tz,
  };
}

function buildPreviousDailySummary(row, date) {
  return {
    date,
    total_energy_kwh: Number(row?.total_energy_kwh || 0),
  };
}

router.get("/", (_req, res) => {
  res.json({ ok: true, message: "API root works" });
});

router.get("/health", async (_req, res) => {
  try {
    const { error } = await supabase
      .from(DAILY_TABLE)
      .select("reading_date")
      .limit(1);

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
    const previousDate = addDays(date, -1);

    const [currentRow, previousRow] = await Promise.all([
      fetchDailyAggregateRow(date),
      fetchDailyAggregateRow(previousDate),
    ]);

    res.json({
      period: "daily",
      metric: "energy_kwh",
      source_table: DAILY_TABLE,
      timezone: tz,
      current: buildCurrentDailySummary(currentRow, date, tz),
      previous: buildPreviousDailySummary(previousRow, previousDate),
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
    const currentWeekStart = addDays(anchorDate, -dow);
    const nextCurrentWeekStart = addDays(currentWeekStart, 7);
    const previousWeekStart = addDays(currentWeekStart, -7);

    const rows = await fetchDailyAggregateRows(previousWeekStart, nextCurrentWeekStart);

    const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const rowMap = {};

    for (const row of rows) {
      rowMap[row.reading_date] = row;
    }

    function buildCurrentWeekData(weekStart) {
      let totalEnergy = 0;
      const data = [];

      for (let i = 0; i < 7; i++) {
        const d = addDays(weekStart, i);
        const row = rowMap[d];
        const energy = Number(row?.total_energy_kwh || 0);

        totalEnergy += energy;

        data.push({
          label: labels[i],
          date: d,
          energy_kwh: energy,
          avg_power_w: Number(row?.avg_power_w || 0),
          avg_voltage: Number(row?.avg_voltage || 0),
          avg_current: Number(row?.avg_current || 0),
        });
      }

      return {
        weekStart,
        weekEnd: addDays(weekStart, 6),
        total_energy_kwh: Number(totalEnergy.toFixed(4)),
        data,
      };
    }

    function buildPreviousWeekData(weekStart) {
      let totalEnergy = 0;

      for (let i = 0; i < 7; i++) {
        const d = addDays(weekStart, i);
        const row = rowMap[d];
        totalEnergy += Number(row?.total_energy_kwh || 0);
      }

      return {
        weekStart,
        weekEnd: addDays(weekStart, 6),
        total_energy_kwh: Number(totalEnergy.toFixed(4)),
      };
    }

    res.json({
      period: "weekly",
      metric: "energy_kwh",
      source_table: DAILY_TABLE,
      timezone: tz,
      anchorDate,
      current: buildCurrentWeekData(currentWeekStart),
      previous: buildPreviousWeekData(previousWeekStart),
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
    const previousMonthAnchor = addMonths(monthStart, -1);
    const {
      monthStart: previousMonthStart,
      lastDay: previousLastDay,
    } = getMonthBounds(previousMonthAnchor);

    const rows = await fetchDailyAggregateRows(previousMonthStart, nextMonthStart);

    const rowMap = {};
    for (const row of rows) {
      rowMap[row.reading_date] = row;
    }

    function buildCurrentMonthData(startDate, totalDays) {
      let totalEnergy = 0;
      const data = [];

      for (let day = 1; day <= totalDays; day++) {
        const d = `${startDate.slice(0, 8)}${String(day).padStart(2, "0")}`;
        const row = rowMap[d];
        const energy = Number(row?.total_energy_kwh || 0);

        totalEnergy += energy;

        data.push({
          label: String(day),
          date: d,
          energy_kwh: energy,
          avg_power_w: Number(row?.avg_power_w || 0),
          avg_voltage: Number(row?.avg_voltage || 0),
          avg_current: Number(row?.avg_current || 0),
        });
      }

      return {
        monthStart: startDate,
        monthEnd: `${startDate.slice(0, 8)}${String(totalDays).padStart(2, "0")}`,
        total_energy_kwh: Number(totalEnergy.toFixed(4)),
        data,
      };
    }

    function buildPreviousMonthData(startDate, totalDays) {
      let totalEnergy = 0;

      for (let day = 1; day <= totalDays; day++) {
        const d = `${startDate.slice(0, 8)}${String(day).padStart(2, "0")}`;
        const row = rowMap[d];
        totalEnergy += Number(row?.total_energy_kwh || 0);
      }

      return {
        monthStart: startDate,
        monthEnd: `${startDate.slice(0, 8)}${String(totalDays).padStart(2, "0")}`,
        total_energy_kwh: Number(totalEnergy.toFixed(4)),
      };
    }

    res.json({
      period: "monthly",
      metric: "energy_kwh",
      source_table: DAILY_TABLE,
      timezone: tz,
      anchorDate,
      current: buildCurrentMonthData(monthStart, lastDay),
      previous: buildPreviousMonthData(previousMonthStart, previousLastDay),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

router.get("/appliance-stats/daily", async (req, res) => {
  try {
    const tz = req.query.tz || DEFAULT_TZ;
    const date = getDateString(req.query.date, tz);

    const { data, error } = await supabase
      .from("appliance_stats_daily")
      .select(`
        reading_date,
        appliance_label,
        total_energy_kwh,
        total_duration_sec,
        hourly_energy_kwh_profile,
        hourly_duration_sec_profile,
        total_nilm_event_count,
        total_manual_app_count
      `)
      .eq("reading_date", date)
      .order("appliance_label", { ascending: true });

    if (error) throw error;

    res.json({
      period: "daily",
      source_table: "appliance_stats_daily",
      date,
      timezone: tz,
      data: data || [],
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

router.get("/appliance-stats/weekly", async (req, res) => {
  try {
    const tz = req.query.tz || DEFAULT_TZ;
    const anchorDate = getDateString(req.query.date, tz);

    const dow = getDayOfWeekSunday0(anchorDate);
    const weekStart = addDays(anchorDate, -dow);
    const nextWeekStart = addDays(weekStart, 7);

    const { data, error } = await supabase
      .from("appliance_stats_daily")
      .select(`
        reading_date,
        appliance_label,
        total_energy_kwh,
        total_duration_sec,
        total_nilm_event_count,
        total_manual_app_count
      `)
      .gte("reading_date", weekStart)
      .lt("reading_date", nextWeekStart)
      .order("reading_date", { ascending: true })
      .order("appliance_label", { ascending: true });

    if (error) throw error;

    const grouped = {};

    for (const row of data || []) {
      const label = row.appliance_label || "Unknown";

      if (!grouped[label]) {
        grouped[label] = {
          appliance_label: label,
          total_energy_kwh: 0,
          total_duration_sec: 0,
          total_nilm_event_count: 0,
          total_manual_app_count: 0,
        };
      }

      grouped[label].total_energy_kwh += Number(row.total_energy_kwh || 0);
      grouped[label].total_duration_sec += Number(row.total_duration_sec || 0);
      grouped[label].total_nilm_event_count += Number(row.total_nilm_event_count || 0);
      grouped[label].total_manual_app_count += Number(row.total_manual_app_count || 0);
    }

    const weeklyData = Object.values(grouped)
      .map((row) => ({
        appliance_label: row.appliance_label,
        total_energy_kwh: Number(row.total_energy_kwh.toFixed(6)),
        total_duration_sec: Number(row.total_duration_sec.toFixed(0)),
        total_nilm_event_count: row.total_nilm_event_count,
        total_manual_app_count: row.total_manual_app_count,
      }))
      .sort((a, b) => a.appliance_label.localeCompare(b.appliance_label));

    res.json({
      period: "weekly",
      source_table: "appliance_stats_daily",
      anchorDate,
      weekStart,
      weekEnd: addDays(weekStart, 6),
      timezone: tz,
      data: weeklyData,
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