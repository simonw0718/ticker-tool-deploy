const DEFAULT_TICKERS = ["AAPL", "MSFT", "NVDA", "TSLA", "SPY", "QQQ"];
const STORE_KEYS = new Set(["records", "tickerLists"]);
const DISPLAY_TIMEZONE = "Asia/Taipei";
const EXCHANGE_TIMEZONE = "America/New_York";
const STOOQ_ORIGIN = "https://stooq.com";
const UPSTREAM_TIMEOUT_MS = 7000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return corsResponse();
      if (url.pathname === "/api/fetch") return json(await handleFetch(url));
      if (url.pathname === "/api/quotes") return json(await handleQuotes(url));
      if (url.pathname.startsWith("/api/store/")) return handleStore(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error.message || String(error) }, 500);
    }
  },
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
    },
  });
}

function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

async function handleStore(request, env, url) {
  const key = url.pathname.split("/").pop();
  if (!STORE_KEYS.has(key)) return json({ error: "Unknown store" }, 404);
  if (request.method === "GET") {
    const value = await env.STORE.get(key);
    return json(value ? JSON.parse(value) : null);
  }
  if (request.method === "POST") {
    const payload = await request.json();
    await env.STORE.put(key, JSON.stringify(payload, null, 2));
    return json({ ok: true });
  }
  return json({ error: "Method not allowed" }, 405);
}

async function handleFetch(url) {
  const tickers = (url.searchParams.get("tickers") || DEFAULT_TICKERS.join(","))
    .replace(/\n/g, ",")
    .split(",")
    .map(normalizeTicker)
    .filter(Boolean);
  const start = url.searchParams.get("start") || daysAgoIso(365 * 3);
  const end = url.searchParams.get("end") || todayIso();
  const rawDays = Number(url.searchParams.get("rawDays") || 30);
  const includeIntraday = url.searchParams.get("intraday") !== "0";
  const data = {};
  for (const ticker of tickers) {
    try {
      const daily = await fetchDaily(ticker, start, end);
      const weekly = weeklyFromDaily(daily.rows);
      let hourly = { rows: [], source: daily.source };
      if (includeIntraday) {
        try {
          hourly = await fetchYahoo(ticker, start, end, "1h");
        } catch {
          hourly = { rows: [], source: daily.source };
        }
      }
      const fourHour = hourly.rows.length ? fourHourFromHourly(hourly.rows) : [];
      const enrichedDaily = enrich(daily.rows);
      data[ticker] = {
        ticker,
        source: daily.source,
        intradaySource: hourly.source,
        intradayLoaded: includeIntraday,
        daily: enrichedDaily,
        weekly: enrich(weekly),
        hourly: hourly.rows.length ? enrich(hourly.rows) : [],
        fourHour: fourHour.length ? enrich(fourHour) : [],
        raw: enrichedDaily.slice(-rawDays),
      };
    } catch (error) {
      data[ticker] = { ticker, error: error.message || String(error), daily: [], weekly: [], hourly: [], fourHour: [], raw: [] };
    }
  }
  return { start, end, data };
}

async function handleQuotes(url) {
  const tickers = (url.searchParams.get("tickers") || "").split(",").map(normalizeTicker).filter(Boolean);
  const data = {};
  const start = daysAgoIso(14);
  const end = todayIso();
  for (const ticker of tickers) {
    try {
      const payload = await fetchYahoo(ticker, start, end, "1d");
      const rows = payload.rows;
      const last = rows[rows.length - 1];
      const previous = rows.length > 1 ? rows[rows.length - 2].close : last.open;
      const change = last.close - previous;
      data[ticker] = {
        ticker,
        price: round(last.close, 4),
        date: last.date,
        change: round(change, 4),
        changePct: previous ? round((change / previous) * 100, 4) : 0,
        source: payload.source,
      };
    } catch (error) {
      data[ticker] = { ticker, error: error.message || String(error) };
    }
  }
  return { data };
}

async function fetchYahoo(ticker, start, end, interval = "1d") {
  let startDate = parseExchangeDate(start);
  if (interval !== "1d") {
    const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    if (startDate < cutoff) startDate = cutoff;
  }
  const params = new URLSearchParams({
    period1: Math.floor(startDate.getTime() / 1000),
    period2: Math.floor(parseExchangeDate(addDays(end, 1)).getTime() / 1000),
    interval,
    events: "history",
    includeAdjustedClose: "true",
  });
  const payload = await fetchYahooJson(`https://query1.finance.yahoo.com/v8/finance/chart/${normalizeTicker(ticker)}?${params}`);
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error(payload.chart?.error?.description || "Yahoo returned no rows");
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjclose = result.indicators?.adjclose?.[0]?.adjclose || [];
  const rows = [];
  timestamps.forEach((ts, index) => {
    const open = quote.open?.[index];
    const high = quote.high?.[index];
    const low = quote.low?.[index];
    const close = quote.close?.[index];
    if ([open, high, low, close].some((value) => value === null || value === undefined || Number.isNaN(value))) return;
    const utc = new Date(ts * 1000);
    const exchangeParts = dateParts(utc, EXCHANGE_TIMEZONE);
    const displayParts = dateParts(utc, DISPLAY_TIMEZONE);
    const volume = Number(quote.volume?.[index] || 0);
    if (interval !== "1d" && volume <= 0) return;
    const row = {
      date: interval === "1d" ? exchangeParts.date : `${displayParts.date} ${displayParts.time}`,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume,
    };
    if (interval !== "1d") {
      row.sessionDate = exchangeParts.date;
      row.exchangeTime = exchangeParts.time;
    }
    if (adjclose[index] !== null && adjclose[index] !== undefined) row.adjClose = Number(adjclose[index]);
    rows.push(row);
  });
  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) throw new Error("Yahoo returned no usable OHLCV rows");
  return { rows, source: "yahoo" };
}

async function fetchDaily(ticker, start, end) {
  let yahoo = null;
  try {
    yahoo = await fetchYahoo(ticker, start, end, "1d");
    if (!shouldTryStooqRefresh(yahoo.rows, end)) return yahoo;
  } catch {
  }
  if (shouldUseIntradayDailyFallback(end)) {
    try {
      const hourly = await fetchYahoo(ticker, start, end, "1h");
      const merged = mergeDailyRows(yahoo?.rows || [], dailyFromIntraday(hourly.rows, yahoo?.rows.at(-1)?.date || "", end));
      if (merged.length && (!yahoo || merged.at(-1)?.date > yahoo.rows.at(-1)?.date)) return { rows: merged, source: yahoo ? "yahoo+1h" : "yahoo-1h" };
    } catch {
    }
  }
  try {
    const stooq = await fetchStooq(ticker, start, end);
    if (!yahoo || compareLastDate(stooq.rows, yahoo.rows) > 0) return { rows: mergeDailyRows(yahoo?.rows || [], stooq.rows), source: yahoo ? "yahoo+stooq" : stooq.source };
  } catch {
  }
  if (yahoo) return yahoo;
  throw new Error("No rows returned");
}

function shouldTryStooqRefresh(rows, end) {
  if (!rows.length) return true;
  const last = rows[rows.length - 1]?.date;
  if (!end || !last || end <= last) return false;
  return calendarDayDiff(last, end) > 4;
}

function shouldUseIntradayDailyFallback(end) {
  if (!end) return false;
  const endDate = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(endDate.getTime())) return false;
  const ageDays = (Date.now() - endDate.getTime()) / 86400000;
  return ageDays <= 7;
}

function compareLastDate(leftRows, rightRows) {
  const left = leftRows[leftRows.length - 1]?.date || "";
  const right = rightRows[rightRows.length - 1]?.date || "";
  return left.localeCompare(right);
}

function mergeDailyRows(primaryRows, fallbackRows) {
  const byDate = new Map(primaryRows.map((row) => [row.date, row]));
  fallbackRows.forEach((row) => byDate.set(row.date, { ...byDate.get(row.date), ...row }));
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function dailyFromIntraday(rows, afterDate = "", end = "") {
  const byDate = new Map();
  rows.forEach((row) => {
    const date = row.sessionDate || row.date.split(" ")[0];
    if ((afterDate && date <= afterDate) || (end && date > end)) return;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(row);
  });
  return [...byDate.entries()].map(([date, dayRows]) => {
    dayRows.sort((a, b) => (a.exchangeTime || a.date).localeCompare(b.exchangeTime || b.date));
    return {
      date,
      open: dayRows[0].open,
      high: Math.max(...dayRows.map((row) => row.high)),
      low: Math.min(...dayRows.map((row) => row.low)),
      close: dayRows[dayRows.length - 1].close,
      volume: dayRows.reduce((sum, row) => sum + row.volume, 0),
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchStooq(ticker, start, end) {
  const symbol = `${normalizeTicker(ticker).toLowerCase()}.us`;
  const params = new URLSearchParams({
    s: symbol,
    d1: start.replaceAll("-", ""),
    d2: end.replaceAll("-", ""),
    i: "d",
  });
  const body = await stooqGet(`${STOOQ_ORIGIN}/q/d/l/?${params}`);
  const rows = parseStooqCsv(body);
  if (!rows.length) throw new Error("Stooq returned no usable OHLCV rows");
  return { rows, source: "stooq" };
}

async function stooqGet(url) {
  const response = await fetchWithTimeout(url, { headers: stooqHeaders() });
  let body = await response.text();
  if (!body.includes("__verify")) return body;

  const challenge = body.match(/const c="([^"]+)",d=(\d+)/);
  if (!challenge) return body;
  const token = challenge[1];
  const difficulty = Number(challenge[2]);
  const nonce = await solveStooqChallenge(token, difficulty);
  const verify = await fetchWithTimeout(`${STOOQ_ORIGIN}/__verify`, {
    method: "POST",
    headers: {
      ...stooqHeaders(),
      "content-type": "application/x-www-form-urlencoded",
      origin: STOOQ_ORIGIN,
      referer: url,
    },
    body: new URLSearchParams({ c: token, n: String(nonce) }),
  });
  const cookie = verify.headers.get("set-cookie")?.split(";")[0];
  const retryHeaders = cookie ? { ...stooqHeaders(), cookie } : stooqHeaders();
  body = await (await fetchWithTimeout(url, { headers: retryHeaders })).text();
  return body;
}

function stooqHeaders() {
  return { "user-agent": "Mozilla/5.0 ticker-tool-cloudflare/1.0" };
}

async function solveStooqChallenge(token, difficulty) {
  const prefix = "0".repeat(difficulty);
  const encoder = new TextEncoder();
  for (let nonce = 0; ; nonce += 1) {
    const hash = await crypto.subtle.digest("SHA-256", encoder.encode(`${token}${nonce}`));
    const hex = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (hex.startsWith(prefix)) return nonce;
  }
}

function parseStooqCsv(body) {
  if (!body || body.trimStart().startsWith("<")) return [];
  const lines = body.trim().split(/\r?\n/);
  const headers = lines.shift()?.split(",") || [];
  const rows = [];
  lines.forEach((line) => {
    const values = line.split(",");
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    if (!row.Date || row.Date === "No data") return;
    const parsed = {
      date: row.Date,
      open: Number(row.Open),
      high: Number(row.High),
      low: Number(row.Low),
      close: Number(row.Close),
      volume: Number(row.Volume || 0),
    };
    if ([parsed.open, parsed.high, parsed.low, parsed.close].some((value) => !Number.isFinite(value))) return;
    rows.push(parsed);
  });
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchYahooJson(url) {
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          "user-agent": "Mozilla/5.0 ticker-tool-cloudflare/1.0",
          accept: "application/json",
        },
      });
      if (!response.ok) throw new Error(`Yahoo ${response.status}`);
      const payload = await response.json();
      if (payload.chart?.result?.[0]) return payload;
      lastError = payload.chart?.error?.description || "Yahoo returned no rows";
    } catch (error) {
      lastError = error.message || String(error);
    }
    if (attempt < 2) await sleep(300 * (attempt + 1));
  }
  throw new Error(lastError);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: options.signal || controller.signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`Upstream timeout after ${Math.round(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTicker(ticker) {
  return String(ticker || "").trim().toUpperCase().replace(".", "-");
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function calendarDayDiff(start, end) {
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;
  return Math.floor((endDate - startDate) / 86400000);
}

function parseExchangeDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const parts = dateParts(noonUtc, EXCHANGE_TIMEZONE);
  const offsetMinutes = timezoneOffsetMinutes(noonUtc, EXCHANGE_TIMEZONE);
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 0, 0) - offsetMinutes * 60 * 1000);
}

function timezoneOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
  return (asUtc - date.getTime()) / 60000;
}

function dateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function weeklyFromDaily(rows) {
  const buckets = new Map();
  rows.forEach((row) => {
    const key = isoWeekKey(row.date);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  });
  return [...buckets.values()]
    .map((bucket) => {
      bucket.sort((a, b) => a.date.localeCompare(b.date));
      return {
        date: bucket[bucket.length - 1].date,
        open: bucket[0].open,
        high: Math.max(...bucket.map((row) => row.high)),
        low: Math.min(...bucket.map((row) => row.low)),
        close: bucket[bucket.length - 1].close,
        volume: bucket.reduce((sum, row) => sum + row.volume, 0),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function isoWeekKey(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-${String(week).padStart(2, "0")}`;
}

function fourHourFromHourly(rows) {
  const days = new Map();
  rows.forEach((row) => {
    const key = row.sessionDate || row.date.split(" ")[0];
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(row);
  });
  const out = [];
  for (const dayRows of days.values()) {
    dayRows.sort((a, b) => a.date.localeCompare(b.date));
    for (let index = 0; index < dayRows.length; index += 4) {
      const bucket = dayRows.slice(index, index + 4);
      if (!bucket.length) continue;
      out.push({
        date: bucket[0].date,
        sessionDate: bucket[0].sessionDate,
        exchangeTime: bucket[0].exchangeTime,
        open: bucket[0].open,
        high: Math.max(...bucket.map((row) => row.high)),
        low: Math.min(...bucket.map((row) => row.low)),
        close: bucket[bucket.length - 1].close,
        volume: bucket.reduce((sum, row) => sum + row.volume, 0),
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function enrich(rows) {
  const smaField = rows.some((row) => "adjClose" in row) ? "adjClose" : "close";
  const smaSets = Object.fromEntries([20, 50, 100, 150, 200].map((period) => [period, sma(rows, period, smaField)]));
  const rsiRows = rsi(rows, 14);
  const rsiMa = sma(rsiRows.map((item) => ({ date: item.date, close: item.value || 0 })), 14);
  return rows.map((row, index) => {
    const previous = index ? rows[index - 1].close : row.open;
    const change = row.close - previous;
    return {
      ...row,
      change: round(change, 4),
      changePct: previous ? round((change / previous) * 100, 4) : 0,
      rsi14: rsiRows[index]?.value ?? null,
      rsiMa14: rsiRows[index]?.value === null || rsiRows[index]?.value === undefined ? null : rsiMa[index]?.value ?? null,
      sma: Object.fromEntries(Object.entries(smaSets).map(([period, values]) => [period, values[index]?.value ?? null])),
    };
  });
}

function sma(rows, period, field = "close") {
  const values = [];
  const window = [];
  let total = 0;
  rows.forEach((row) => {
    const value = row[field] ?? row.close;
    window.push(value);
    total += value;
    if (window.length > period) total -= window.shift();
    values.push({ date: row.date, value: window.length === period ? round(total / period, 4) : null });
  });
  return values;
}

function rsi(rows, period = 14) {
  if (!rows.length) return [];
  const values = [{ date: rows[0].date, value: null }];
  const gains = [];
  const losses = [];
  let avgGain = null;
  let avgLoss = null;
  for (let index = 1; index < rows.length; index += 1) {
    const change = rows[index].close - rows[index - 1].close;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    gains.push(gain);
    losses.push(loss);
    if (index === period) {
      avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
      avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;
    } else if (index > period && avgGain !== null && avgLoss !== null) {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    const value = avgGain === null || avgLoss === null ? null : avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    values.push({ date: rows[index].date, value: value === null ? null : round(value, 4) });
  }
  return values;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
