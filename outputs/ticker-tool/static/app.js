const state = {
  data: {},
  activeTicker: null,
  interval: "daily",
  yScale: 1,
  axisDrag: null,
  panDrag: null,
  touchDrag: null,
  touchPinch: null,
  crosshair: null,
  crosshairLocked: false,
  chartLayout: null,
  chartPointerDown: null,
  chartPointerDragged: false,
  xVisible: 180,
  xOffset: 0,
  activeGroupId: "own",
  tickerGroups: [
    { id: "own", name: "Own", tickers: "AAPL\nMSFT\nNVDA\nTSLA\nSPY\nQQQ" },
    { id: "keyWatch", name: "Key Watch", tickers: "AMZN\nGOOGL\nMETA\nAMD\nAVGO" },
    { id: "watchlist", name: "Watchlist", tickers: "PLTR\nCRWD\nNET\nSNOW\nSHOP" },
  ],
  saveTimer: null,
  saveController: null,
};

const els = {
  tickers: document.querySelector("#tickers"),
  groupSelect: document.querySelector("#groupSelect"),
  addListBtn: document.querySelector("#addListBtn"),
  renameListBtn: document.querySelector("#renameListBtn"),
  moveListLeftBtn: document.querySelector("#moveListLeftBtn"),
  moveListRightBtn: document.querySelector("#moveListRightBtn"),
  deleteListBtn: document.querySelector("#deleteListBtn"),
  start: document.querySelector("#start"),
  end: document.querySelector("#end"),
  rawDays: document.querySelector("#rawDays"),
  fetchBtn: document.querySelector("#fetchBtn"),
  fetchProgress: document.querySelector("#fetchProgress"),
  csvFile: document.querySelector("#csvFile"),
  status: document.querySelector("#status"),
  tickerButtons: document.querySelector("#tickerButtons"),
  dailyBtn: document.querySelector("#dailyBtn"),
  weeklyBtn: document.querySelector("#weeklyBtn"),
  hourlyBtn: document.querySelector("#hourlyBtn"),
  fourHourBtn: document.querySelector("#fourHourBtn"),
  copyChartBtn: document.querySelector("#copyChartBtn"),
  copyBundleBtn: document.querySelector("#copyBundleBtn"),
  downloadCsvBtn: document.querySelector("#downloadCsvBtn"),
  title: document.querySelector("#title"),
  subtitle: document.querySelector("#subtitle"),
  quoteBox: document.querySelector("#quoteBox"),
  chart: document.querySelector("#chart"),
  rawHead: document.querySelector("#rawTable thead"),
  rawBody: document.querySelector("#rawTable tbody"),
  tableTitle: document.querySelector(".table-head h2"),
  tableMeta: document.querySelector("#tableMeta"),
};

const intervalLabels = {
  daily: "Daily",
  weekly: "Weekly",
  hourly: "1H",
  fourHour: "4H",
};

const WORKER_ORIGIN = "https://ticker-tool.simonw0718.workers.dev";
const LIST_STORAGE_KEY = "ticker-k-tool-lists-v1";
const CHART_STORAGE_KEY = "ticker-k-tool-chart-session-v1";
const API_TIMEOUT_MS = 22000;
const DEFAULT_OWN_LIST = "AAPL\nMSFT\nNVDA\nTSLA\nSPY\nQQQ";
const DEFAULT_TICKER_GROUPS = [
  { id: "own", name: "Own", tickers: DEFAULT_OWN_LIST },
  { id: "keyWatch", name: "Key Watch", tickers: "AMZN\nGOOGL\nMETA\nAMD\nAVGO" },
  { id: "watchlist", name: "Watchlist", tickers: "PLTR\nCRWD\nNET\nSNOW\nSHOP" },
];

function apiUrl(path) {
  const host = location.hostname;
  if (host === "ticker-tool.simonw0718.workers.dev" || host === "127.0.0.1" || host === "localhost" || host === "") return path;
  return `${WORKER_ORIGIN}${path}`;
}

async function fetchJson(path, options = {}) {
  const firstUrl = apiUrl(path);
  let response = await fetchWithTimeout(firstUrl, options);
  let text = await response.text();
  if (shouldRetryWorker(firstUrl, response, text)) {
    response = await fetchWithTimeout(`${WORKER_ORIGIN}${path}`, options);
    text = await response.text();
  }
  if (!response.ok) throw new Error(`API ${response.status}: ${text.slice(0, 120)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`API returned ${response.headers.get("content-type") || "non-JSON"} from ${new URL(response.url).hostname}`);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: options.signal || controller.signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function shouldRetryWorker(url, response, text) {
  if (url.startsWith(WORKER_ORIGIN)) return false;
  const contentType = response.headers.get("content-type") || "";
  return !response.ok || contentType.includes("text/html") || text.trimStart().startsWith("<!DOCTYPE");
}

async function loadServerStore(key) {
  try {
    return await fetchJson(`/api/store/${key}`);
  } catch {
    return null;
  }
}

function saveServerStore(key, payload) {
  fetch(apiUrl(`/api/store/${key}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

async function loadTickerLists() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(LIST_STORAGE_KEY) || "{}");
  } catch {
    saved = null;
  }
  const serverSaved = await loadServerStore("tickerLists");
  const source = chooseTickerGroupSource(saved, serverSaved);
  applyTickerGroupPayload(source);
  const savedOwn = groupById("own")?.tickers || "";
  await hydrateOwnListFromRecords(savedOwn);
  syncTextareaFromActiveGroup();
  renderListTabs();
  saveTickerLists();
}

function normalizeTickerName(value) {
  const match = String(value || "").toUpperCase().match(/[A-Z][A-Z0-9.-]{0,9}/);
  return match ? match[0].replace(".", "-") : "";
}

function extractAccountTickers(records) {
  return [
    ...new Set(
      (records?.accounts || [])
        .flatMap((account) => account.rows || [])
        .map((row) => normalizeTickerName(row?.[0]))
        .filter(Boolean)
    ),
  ];
}

function shouldAutoFillOwnList(value) {
  const normalized = String(value || "").trim();
  return !normalized || normalized === DEFAULT_OWN_LIST;
}

async function hydrateOwnListFromRecords(savedOwn) {
  const ownGroup = groupById("own");
  const currentOwn = ownGroup?.tickers || "";
  if (!shouldAutoFillOwnList(savedOwn || currentOwn)) return;
  const records = await loadServerStore("records");
  const tickers = extractAccountTickers(records);
  if (!tickers.length) return;
  if (ownGroup) ownGroup.tickers = tickers.join("\n");
  if (state.activeGroupId === "own") els.status.textContent = "Own loaded from Records";
  saveTickerLists();
}

function saveTickerLists({ immediate = false } = {}) {
  normalizeTickerGroups();
  const payload = tickerGroupPayload();
  localStorage.setItem(LIST_STORAGE_KEY, JSON.stringify(payload));
  if (state.saveTimer) clearTimeout(state.saveTimer);
  const persist = () => saveTickerGroupPayload(payload);
  if (immediate) {
    persist();
  } else {
    state.saveTimer = setTimeout(persist, 450);
  }
}

function saveTickerGroupPayload(payload) {
  if (state.saveController) state.saveController.abort();
  state.saveController = new AbortController();
  fetch(apiUrl("/api/store/tickerLists"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: state.saveController.signal,
  }).catch((error) => {
    if (error.name !== "AbortError") console.warn("Ticker group cloud save failed", error);
  });
}

function renderListTabs() {
  normalizeTickerGroups();
  els.groupSelect.innerHTML = state.tickerGroups.map((group) => `<option value="${escapeAttr(group.id)}">${escapeHtml(group.name)}</option>`).join("");
  els.groupSelect.value = state.activeGroupId;
  const activeIndex = state.tickerGroups.findIndex((group) => group.id === state.activeGroupId);
  els.moveListLeftBtn.disabled = activeIndex <= 0;
  els.moveListRightBtn.disabled = activeIndex < 0 || activeIndex >= state.tickerGroups.length - 1;
  els.deleteListBtn.disabled = state.tickerGroups.length <= 1;
}

function syncActiveListFromInput() {
  normalizeTickerGroups();
  const group = activeGroup();
  if (!group) return;
  group.tickers = els.tickers.value;
  saveTickerLists();
}

function switchTickerList(nextList) {
  normalizeTickerGroups();
  if (!state.tickerGroups.some((group) => group.id === nextList)) return;
  if (nextList === state.activeGroupId) {
    syncTextareaFromActiveGroup();
    renderListTabs();
    return;
  }
  syncActiveListFromInput();
  state.activeGroupId = nextList;
  syncTextareaFromActiveGroup();
  renderListTabs();
  saveTickerLists({ immediate: true });
  els.status.textContent = `Editing ${labelForList(state.activeGroupId)}`;
}

function labelForList(list) {
  return groupById(list)?.name || list;
}

function addTickerList() {
  syncActiveListFromInput();
  const rawName = window.prompt("New ticker group name", "New Group");
  const label = String(rawName || "").trim();
  if (!label) return;
  const key = uniqueGroupId();
  state.tickerGroups.push({ id: key, name: label, tickers: "" });
  state.activeGroupId = key;
  els.tickers.value = "";
  renderListTabs();
  saveTickerLists({ immediate: true });
  els.tickers.focus();
  els.status.textContent = `Added ${label}`;
}

function renameTickerList() {
  normalizeTickerGroups();
  const group = activeGroup();
  if (!group) return;
  const rawName = window.prompt("Rename ticker group", group.name);
  const label = String(rawName || "").trim();
  if (!label) return;
  group.name = label;
  renderListTabs();
  saveTickerLists({ immediate: true });
  els.status.textContent = `Renamed to ${label}`;
}

function moveActiveTickerList(direction) {
  normalizeTickerGroups();
  const index = state.tickerGroups.findIndex((group) => group.id === state.activeGroupId);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= state.tickerGroups.length) return;
  [state.tickerGroups[index], state.tickerGroups[nextIndex]] = [state.tickerGroups[nextIndex], state.tickerGroups[index]];
  renderListTabs();
  saveTickerLists({ immediate: true });
  els.status.textContent = `Moved ${labelForList(state.activeGroupId)}`;
}

function deleteTickerList() {
  normalizeTickerGroups();
  if (state.tickerGroups.length <= 1) return;
  const key = state.activeGroupId;
  const index = state.tickerGroups.findIndex((group) => group.id === key);
  const label = labelForList(key);
  if (!window.confirm(`Delete ticker group "${label}"?`)) return;
  state.tickerGroups = state.tickerGroups.filter((group) => group.id !== key);
  const nextIndex = Math.max(0, Math.min(index, state.tickerGroups.length - 1));
  state.activeGroupId = state.tickerGroups[nextIndex]?.id || "own";
  syncTextareaFromActiveGroup();
  renderListTabs();
  saveTickerLists({ immediate: true });
  els.status.textContent = `Deleted ${label}`;
}

function chooseTickerGroupSource(localPayload, serverPayload) {
  const localScore = tickerGroupSourceScore(localPayload);
  const serverScore = tickerGroupSourceScore(serverPayload);
  if (localScore > serverScore) return localPayload;
  return serverPayload || localPayload || null;
}

function tickerGroupSourceScore(payload) {
  return groupsFromPayload(payload).reduce((score, group) => score + group.tickers.trim().length + 20, 0);
}

function groupsFromPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.tickerGroups)) {
    return payload.tickerGroups.map((group) => ({
      id: cleanGroupId(group.id),
      name: cleanGroupName(group.name || group.id),
      tickers: String(group.tickers || ""),
    }));
  }
  const lists = payload.tickerLists || {};
  const labels = payload.tickerListLabels || {};
  const orderedKeys = [...new Set([...(Array.isArray(payload.tickerListOrder) ? payload.tickerListOrder : []), ...Object.keys(lists)])];
  return orderedKeys
    .filter((key) => !shouldDropLegacyGroup(key, labels[key], lists[key]))
    .map((key) => ({
      id: cleanGroupId(key),
      name: cleanGroupName(labels[key] || builtinGroupName(key) || key),
      tickers: String(lists[key] || ""),
    }));
}

function applyTickerGroupPayload(payload) {
  const groups = groupsFromPayload(payload);
  state.tickerGroups = groups.length ? groups : DEFAULT_TICKER_GROUPS.map((group) => ({ ...group }));
  state.activeGroupId = cleanGroupId(payload?.activeGroupId || payload?.activeList || state.activeGroupId);
  normalizeTickerGroups();
}

function tickerGroupPayload() {
  normalizeTickerGroups();
  return {
    version: 2,
    activeGroupId: state.activeGroupId,
    tickerGroups: state.tickerGroups.map((group) => ({ id: group.id, name: group.name, tickers: group.tickers })),
  };
}

function normalizeTickerGroups() {
  const used = new Set();
  const groups = [];
  (state.tickerGroups || []).forEach((group) => {
    let id = cleanGroupId(group.id);
    const name = cleanGroupName(group.name || builtinGroupName(id) || "New Group");
    if (!id || used.has(id)) id = uniqueGroupId(used);
    used.add(id);
    groups.push({ id, name, tickers: String(group.tickers || "") });
  });
  if (!groups.length) groups.push(...DEFAULT_TICKER_GROUPS.map((group) => ({ ...group })));
  state.tickerGroups = groups;
  if (!state.tickerGroups.some((group) => group.id === state.activeGroupId)) state.activeGroupId = state.tickerGroups[0]?.id || "own";
}

function activeGroup() {
  return groupById(state.activeGroupId);
}

function groupById(id) {
  return state.tickerGroups.find((group) => group.id === id);
}

function syncTextareaFromActiveGroup() {
  els.tickers.value = activeGroup()?.tickers || "";
}

function cleanGroupId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48);
}

function cleanGroupName(value) {
  return String(value || "New Group").trim().slice(0, 40) || "New Group";
}

function builtinGroupName(key) {
  return DEFAULT_TICKER_GROUPS.find((group) => group.id === key)?.name || "";
}

function shouldDropLegacyGroup(key, label, tickers) {
  const normalizedLabel = String(label || key || "").trim().toUpperCase();
  const normalizedKey = String(key || "").toLowerCase();
  const isEmptyCustom = normalizedKey.startsWith("custom-") && !String(tickers || "").trim();
  return isEmptyCustom || normalizedLabel === "OWN1";
}

function uniqueGroupId(existing = new Set(state.tickerGroups.map((group) => group.id))) {
  let id = `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  while (existing.has(id)) id = `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return id;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

const colors = {
  bg: "#020303",
  grid: "#151a20",
  text: "#d9dee5",
  muted: "#8c949f",
  up: "#00b887",
  down: "#ff4c5a",
  sma20: "#d9344b",
  sma50: "#356dff",
  sma100: "#d18b00",
  sma150: "#32a852",
  sma200: "#6e2c91",
  rsi: "#9c6bff",
  rsiMa: "#f1c40f",
};

function setDefaultDates() {
  const end = new Date();
  const start = new Date();
  start.setFullYear(end.getFullYear() - 3);
  els.end.value = end.toISOString().slice(0, 10);
  els.start.value = start.toISOString().slice(0, 10);
}

function parseTickers() {
  return els.tickers.value
    .split(/[\n, ]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function fmt(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function fmtVolume(value) {
  if (!value) return "";
  if (value >= 1_000_000_000) return `${fmt(value / 1_000_000_000, 2)}B`;
  if (value >= 1_000_000) return `${fmt(value / 1_000_000, 2)}M`;
  if (value >= 1_000) return `${fmt(value / 1_000, 2)}K`;
  return String(value);
}

async function fetchData() {
  syncActiveListFromInput();
  const tickers = parseTickers();
  if (!tickers.length) return;
  const previousData = { ...state.data };
  setFetchProgress(0, `Fetching ${labelForList(state.activeGroupId)} · 0/${tickers.length}`);
  els.fetchBtn.disabled = true;
  const startedAt = performance.now();
  try {
    const results = await fetchTickersWithProgress(tickers, (done, total, ticker, retrying) => {
      const pct = Math.round((done / total) * 100);
      if (retrying) {
        setFetchProgress(pct, `${pct}% · retrying ${ticker}`);
      } else {
        setFetchProgress(pct, `${pct}% · ${done}/${total} loaded${ticker ? ` · ${ticker}` : ""}`);
      }
    });
    state.data = Object.fromEntries(
      tickers.map((ticker) => {
        const result = results[ticker] || { ticker, error: "No response", daily: [], weekly: [], hourly: [], fourHour: [], raw: [] };
        if (result.error && previousData[ticker]?.daily?.length) {
          return [ticker, { ...previousData[ticker], warning: result.error }];
        }
        return [ticker, result];
      })
    );
    const failedCount = Object.values(state.data).filter((item) => item.error).length;
    state.activeTicker = Object.keys(state.data).find((ticker) => !state.data[ticker].error) || state.activeTicker || Object.keys(state.data)[0];
    resetChartView();
    renderTickerButtons();
    render();
    saveChartSession();
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    setFetchProgress(100, `Loaded ${Object.keys(state.data).length - failedCount}/${Object.keys(state.data).length} tickers · ${seconds}s${failedCount ? ` · ${failedCount} failed` : ""}`);
  } catch (error) {
    setFetchProgress(100, error.message || String(error));
  } finally {
    els.fetchBtn.disabled = false;
  }
}

function saveChartSession() {
  try {
    const data = Object.fromEntries(
      Object.entries(state.data).map(([ticker, item]) => [
        ticker,
        {
          ...item,
          intradayLoading: false,
          intradayPromise: null,
        },
      ])
    );
    if (!Object.keys(data).length) return;
    sessionStorage.setItem(
      CHART_STORAGE_KEY,
      JSON.stringify({
        data,
        activeTicker: state.activeTicker,
        interval: state.interval,
        yScale: state.yScale,
        xVisible: state.xVisible,
        xOffset: state.xOffset,
        savedAt: Date.now(),
      })
    );
  } catch {
  }
}

function restoreChartSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CHART_STORAGE_KEY) || "null");
    if (!saved?.data || !Object.keys(saved.data).length) return;
    state.data = saved.data;
    state.activeTicker = saved.activeTicker && state.data[saved.activeTicker] ? saved.activeTicker : Object.keys(state.data)[0];
    state.interval = saved.interval || state.interval;
    state.yScale = Number(saved.yScale) || 1;
    state.xVisible = Number(saved.xVisible) || state.xVisible;
    state.xOffset = Number(saved.xOffset) || 0;
    renderTickerButtons();
    setIntervalButtons();
    render();
    els.status.textContent = `Restored ${Object.keys(state.data).length} cached tickers`;
  } catch {
  }
}

function setFetchProgress(percent, label) {
  els.fetchProgress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  els.status.textContent = label;
}

async function fetchTickersWithProgress(tickers, onProgress) {
  const results = {};
  let done = 0;
  const chunks = chunkArray(tickers, 1);
  for (const chunk of chunks) {
    const batch = await fetchTickerBatch(chunk, (retryTicker) => onProgress(done, tickers.length, retryTicker, true));
    for (const ticker of chunk) {
      results[ticker] = batch[ticker] || { ticker, error: "No response", daily: [], weekly: [], hourly: [], fourHour: [], raw: [] };
      done += 1;
      onProgress(done, tickers.length, ticker);
    }
    if (done < tickers.length) await delay(850);
  }
  return results;
}

async function fetchTickerBatch(tickers, onRetry) {
  const params = new URLSearchParams({
    tickers: tickers.join(","),
    start: els.start.value,
    end: els.end.value,
    rawDays: els.rawDays.value,
    intraday: "0",
  });
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const payload = await fetchJson(`/api/fetch?${params}`);
      const data = payload.data || {};
      const missing = tickers.filter((ticker) => !data[ticker]?.daily?.length);
      if (!missing.length) return data;
      if (missing.length < tickers.length) {
        const fallback = await fetchMissingTickers(missing, onRetry);
        return { ...data, ...fallback };
      }
      lastError = missing.map((ticker) => data[ticker]?.error).filter(Boolean).join("; ") || "No rows returned";
    } catch (error) {
      lastError = error.message || String(error);
    }
    if (attempt < 1) {
      tickers.forEach((ticker) => onRetry?.(ticker));
      await delay(1800);
    }
  }
  const fallback = await fetchMissingTickers(tickers, onRetry);
  return Object.keys(fallback).length ? fallback : Object.fromEntries(tickers.map((ticker) => [ticker, { ticker, error: lastError, daily: [], weekly: [], hourly: [], fourHour: [], raw: [] }]));
}

async function fetchMissingTickers(tickers, onRetry) {
  const results = {};
  for (const ticker of tickers) {
    results[ticker] = await fetchOneTicker(ticker, onRetry);
    await delay(450);
  }
  return results;
}

async function fetchOneTicker(ticker, onRetry, includeIntraday = false) {
  const params = new URLSearchParams({
    tickers: ticker,
    start: els.start.value,
    end: els.end.value,
    rawDays: els.rawDays.value,
    intraday: includeIntraday ? "1" : "0",
  });
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const payload = await fetchJson(`/api/fetch?${params}`);
      const result = payload.data?.[ticker] || payload.data?.[Object.keys(payload.data || {})[0]];
      if (result?.daily?.length) return result;
      lastError = result?.error || "No rows returned";
    } catch (error) {
      lastError = error.message || String(error);
    }
    if (attempt < 2) {
      onRetry?.(ticker);
      await delay(1200 * (attempt + 1));
    }
  }
  return { ticker, error: lastError, daily: [], weekly: [], hourly: [], fourHour: [], raw: [] };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines.shift().split(",").map((item) => item.trim().toLowerCase());
  const at = (names) => names.map((name) => headers.indexOf(name.toLowerCase())).find((index) => index >= 0);
  const idx = {
    date: at(["date", "time"]),
    open: at(["open"]),
    high: at(["high"]),
    low: at(["low"]),
    close: at(["close", "adj close"]),
    volume: at(["volume"]),
  };
  return lines
    .map((line) => line.split(",").map((item) => item.trim()))
    .map((cols) => ({
      date: cols[idx.date],
      open: Number(cols[idx.open]),
      high: Number(cols[idx.high]),
      low: Number(cols[idx.low]),
      close: Number(cols[idx.close]),
      volume: Number(cols[idx.volume] || 0),
    }))
    .filter((row) => row.date && Number.isFinite(row.open) && Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function localSma(rows, period, key = "close") {
  const out = [];
  let total = 0;
  const windowRows = [];
  rows.forEach((row) => {
    const value = row[key] ?? 0;
    windowRows.push(value);
    total += value;
    if (windowRows.length > period) total -= windowRows.shift();
    out.push(windowRows.length === period ? total / period : null);
  });
  return out;
}

function localRsi(rows, period = 14) {
  const out = [null];
  let avgGain = null;
  let avgLoss = null;
  const gains = [];
  const losses = [];
  for (let i = 1; i < rows.length; i += 1) {
    const change = rows[i].close - rows[i - 1].close;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    gains.push(gain);
    losses.push(loss);
    if (i === period) {
      avgGain = gains.slice(-period).reduce((a, b) => a + b, 0) / period;
      avgLoss = losses.slice(-period).reduce((a, b) => a + b, 0) / period;
    } else if (i > period) {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    out.push(avgGain === null ? null : avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
}

function localWeekly(rows) {
  const buckets = new Map();
  rows.forEach((row) => {
    const date = new Date(`${row.date}T00:00:00`);
    const thursday = new Date(date);
    thursday.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
    const key = `${thursday.getFullYear()}-${Math.ceil((((thursday - new Date(thursday.getFullYear(), 0, 1)) / 86400000) + 1) / 7)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  });
  return [...buckets.values()].map((bucket) => ({
    date: bucket[bucket.length - 1].date,
    open: bucket[0].open,
    high: Math.max(...bucket.map((row) => row.high)),
    low: Math.min(...bucket.map((row) => row.low)),
    close: bucket[bucket.length - 1].close,
    volume: bucket.reduce((sum, row) => sum + row.volume, 0),
  }));
}

function localEnrich(rows) {
  const sma20 = localSma(rows, 20);
  const sma50 = localSma(rows, 50);
  const sma100 = localSma(rows, 100);
  const sma150 = localSma(rows, 150);
  const sma200 = localSma(rows, 200);
  const rsi14 = localRsi(rows, 14);
  const rsiRows = rsi14.map((value) => ({ close: value ?? 0 }));
  const rsiMa = localSma(rsiRows, 14);
  return rows.map((row, index) => {
    const previous = index ? rows[index - 1].close : row.open;
    const change = row.close - previous;
    return {
      ...row,
      change,
      changePct: previous ? (change / previous) * 100 : 0,
      rsi14: rsi14[index],
      rsiMa14: rsi14[index] === null ? null : rsiMa[index],
      sma: { 20: sma20[index], 50: sma50[index], 100: sma100[index], 150: sma150[index], 200: sma200[index] },
    };
  });
}

async function importCsvFiles(event) {
  const files = [...event.target.files];
  if (!files.length) return;
  for (const file of files) {
    const text = await file.text();
    const ticker = file.name.replace(/\.[^.]+$/, "").split(/[-_ ]/)[0].toUpperCase();
    const daily = localEnrich(parseCsv(text));
    state.data[ticker] = {
      ticker,
      source: "csv-import",
      daily,
      weekly: localEnrich(localWeekly(daily)),
      raw: daily.slice(-Number(els.rawDays.value || 30)),
    };
  }
  state.activeTicker = Object.keys(state.data)[0];
  resetChartView();
  renderTickerButtons();
  render();
  saveChartSession();
  els.status.textContent = `Imported ${files.length} CSV file(s)`;
}

function renderTickerButtons() {
  els.tickerButtons.innerHTML = "";
  for (const ticker of Object.keys(state.data)) {
    const button = document.createElement("button");
    button.textContent = ticker;
    button.className = ticker === state.activeTicker ? "active" : "";
    button.onclick = async () => {
      state.activeTicker = ticker;
      resetChartView();
      renderTickerButtons();
      if (["hourly", "fourHour"].includes(state.interval)) await ensureIntradayLoaded(ticker);
      render();
      saveChartSession();
    };
    els.tickerButtons.appendChild(button);
  }
}

function getRows() {
  const ticker = state.data[state.activeTicker];
  if (!ticker) return [];
  return getRowsForInterval(ticker, state.interval);
}

function getRowsForInterval(item, interval) {
  return item?.[interval] || [];
}

function getTableRows(item, interval, limit = Number(els.rawDays.value || 30)) {
  return getRowsForInterval(item, interval).slice(-limit);
}

async function ensureIntradayLoaded(ticker = state.activeTicker) {
  const item = state.data[ticker];
  if (!item || item.error || item.intradayLoaded) return;
  if (item.intradayPromise) {
    await item.intradayPromise;
    return;
  }
  item.intradayLoading = true;
  els.status.textContent = `Loading 1H / 4H for ${ticker}...`;
  item.intradayPromise = (async () => {
    const result = await fetchOneTicker(ticker, null, true);
    if (result?.daily?.length) {
      state.data[ticker] = { ...item, ...result, intradayLoaded: true, intradayLoading: false, intradayPromise: null };
      els.status.textContent = `Loaded 1H / 4H for ${ticker}`;
      return;
    }
    item.warning = result?.error || "Intraday data unavailable";
  })();
  try {
    await item.intradayPromise;
  } finally {
    item.intradayLoading = false;
    item.intradayPromise = null;
  }
}

function getSelectedOutputIntervals() {
  const selected = [...document.querySelectorAll("[data-output-panel]:checked")].map((input) => input.dataset.outputPanel);
  const intervals = selected.filter((panel) => panel !== "table");
  return intervals.length ? intervals : [state.interval];
}

function shouldIncludeOutputTables() {
  return Boolean(document.querySelector('[data-output-panel="table"]:checked'));
}

function getSelectedOutputIndicators() {
  const selected = new Set([...document.querySelectorAll("[data-output-indicator]:checked")].map((input) => input.dataset.outputIndicator));
  return {
    rsi: selected.has("rsi"),
    macd: selected.has("macd"),
    volumeProfile: selected.has("volumeProfile"),
  };
}

function resetChartView() {
  state.yScale = 1;
  state.xVisible = 180;
  state.xOffset = 0;
  state.axisDrag = null;
  state.panDrag = null;
  state.touchDrag = null;
  state.touchPinch = null;
  state.crosshair = null;
  state.crosshairLocked = false;
  state.chartLayout = null;
}

function getVisibleRows(rows) {
  const count = clamp(Math.round(state.xVisible), 20, Math.max(20, rows.length));
  state.xVisible = count;
  state.xOffset = clamp(Math.round(state.xOffset), 0, Math.max(0, rows.length - count));
  const end = rows.length - state.xOffset;
  const start = Math.max(0, end - count);
  return rows.slice(start, end);
}

function render() {
  const item = state.data[state.activeTicker];
  if (!item) return;
  if (item.error) {
    els.title.textContent = `${state.activeTicker} - no data`;
    els.subtitle.textContent = item.error;
    return;
  }
  const rows = getRows();
  const last = rows[rows.length - 1];
  els.title.textContent = `${state.activeTicker} · ${intervalLabels[state.interval]} Chart`;
  const source = ["hourly", "fourHour"].includes(state.interval) ? item.intradaySource || item.source : item.source;
  els.subtitle.textContent = `Source: ${source} · ${rows[0]?.date || ""} to ${last?.date || ""}`;
  els.quoteBox.innerHTML = last
    ? `Close <strong>${fmt(last.close)}</strong><br><span class="${last.change >= 0 ? "up" : "down"}">${fmt(last.change)} (${fmt(last.changePct)}%)</span> · Vol ${fmtVolume(last.volume)}`
    : "";
  drawChart(rows, state.activeTicker, state.interval);
  renderTable(getTableRows(item, state.interval), state.interval);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatDateLabel(dateText, interval) {
  if (!dateText) return "";
  const [datePart, timePart] = dateText.split(" ");
  const [year, month, day] = datePart.split("-");
  if (interval === "weekly") return `${year.slice(2)}/${month}`;
  if (timePart) return `${month}/${day} ${timePart.slice(0, 2)}`;
  return `${month}/${day}`;
}

function drawChart(rows, ticker, interval) {
  const canvas = els.chart;
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const w = rect.width;
  const h = rect.height;
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, w, h);

  if (!rows.length) return;
  const visible = getVisibleRows(rows);
  const indicators = getSelectedOutputIndicators();
  const pad = { left: 56, right: 76, top: 24, bottom: 24 };
  const oscillatorPanels = [
    ...(indicators.rsi ? [{ key: "rsi", height: 120 }] : []),
    ...(indicators.macd ? [{ key: "macd", height: 120 }] : []),
  ];
  const oscillatorGap = oscillatorPanels.length ? 18 : 0;
  const oscillatorH = oscillatorPanels.reduce((sum, panel) => sum + panel.height, 0) + Math.max(0, oscillatorPanels.length - 1) * 10;
  const volH = 110;
  const priceH = Math.max(180, h - pad.top - pad.bottom - volH - oscillatorH - oscillatorGap);
  const priceTop = pad.top;
  const volTop = priceTop + priceH;
  const panelTops = {};
  let panelTop = volTop + volH + oscillatorGap;
  oscillatorPanels.forEach((panel) => {
    panelTops[panel.key] = panelTop;
    panelTop += panel.height + 10;
  });
  const plotW = w - pad.left - pad.right;
  const candleW = Math.max(2, Math.min(11, plotW / visible.length * 0.58));

  const prices = visible.flatMap((row) => [row.high, row.low, ...Object.values(row.sma || {}).filter(Boolean)]);
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);
  const pricePad = (maxPrice - minPrice) * 0.08 || 1;
  const baseMax = maxPrice + pricePad;
  const baseMin = minPrice - pricePad;
  const center = (baseMax + baseMin) / 2;
  const scaledRange = (baseMax - baseMin) / state.yScale;
  const pMax = center + scaledRange / 2;
  const pMin = center - scaledRange / 2;
  const maxVol = Math.max(...visible.map((row) => row.volume || 0));

  const xFor = (index) => pad.left + (index + 0.5) * (plotW / visible.length);
  const yPrice = (value) => priceTop + ((pMax - value) / (pMax - pMin)) * priceH;
  const yVol = (value) => volTop + volH - (value / maxVol) * (volH - 12);
  const yRsi = (value) => panelTops.rsi + ((80 - value) / 60) * 120;
  const macdAll = indicators.macd ? macdRows(rows) : [];
  const visibleMacd = indicators.macd ? macdAll.slice(-visible.length) : [];
  const macdMax = indicators.macd ? Math.max(...visibleMacd.flatMap((row) => [Math.abs(row.macd || 0), Math.abs(row.signal || 0), Math.abs(row.hist || 0)]), 0.01) : 1;
  const yMacd = (value) => panelTops.macd + 60 - (value / macdMax) * 50;
  state.chartLayout = { visible, pad, priceTop, priceH, volTop, volH, plotW, pMin, pMax, xFor, yPrice, width: w, height: h };

  drawGrid(ctx, pad.left, priceTop, plotW, priceH, 6, 6);
  drawGrid(ctx, pad.left, volTop, plotW, volH, 2, 6);
  if (indicators.rsi) drawGrid(ctx, pad.left, panelTops.rsi, plotW, 120, 3, 6);
  if (indicators.macd) drawGrid(ctx, pad.left, panelTops.macd, plotW, 120, 4, 6);

  ctx.font = "12px system-ui";
  ctx.fillStyle = colors.muted;
  for (let i = 0; i <= 6; i++) {
    const value = pMin + ((pMax - pMin) * i) / 6;
    const y = yPrice(value);
    ctx.fillText(fmt(value), w - pad.right + 10, y + 4);
  }
  if (indicators.rsi) {
    [30, 50, 70].forEach((value) => {
      const y = yRsi(value);
      ctx.fillText(String(value), w - pad.right + 12, y + 4);
    });
  }

  ctx.font = "12px system-ui";
  ctx.fillStyle = colors.muted;
  ctx.textAlign = "center";
  for (let i = 0; i <= 6; i++) {
    const x = pad.left + (plotW * i) / 6;
    const index = clamp(Math.round(((visible.length - 1) * i) / 6), 0, visible.length - 1);
    const label = formatDateLabel(visible[index]?.date, interval);
    ctx.fillText(label, x, volTop + volH + 13);
  }
  ctx.textAlign = "left";
  if (indicators.volumeProfile) drawVolumeProfile(ctx, visible, pMin, pMax, priceTop, priceH, pad.left, plotW);

  visible.forEach((row, index) => {
    const x = xFor(index);
    const up = row.close >= row.open;
    ctx.fillStyle = up ? "rgba(0,184,135,0.42)" : "rgba(255,76,90,0.48)";
    ctx.fillRect(x - candleW / 2, yVol(row.volume), candleW, volTop + volH - yVol(row.volume));
  });

  visible.forEach((row, index) => {
    const x = xFor(index);
    const up = row.close >= row.open;
    ctx.strokeStyle = up ? colors.up : colors.down;
    ctx.fillStyle = up ? colors.up : colors.down;
    ctx.beginPath();
    ctx.moveTo(x, yPrice(row.high));
    ctx.lineTo(x, yPrice(row.low));
    ctx.stroke();
    const yOpen = yPrice(row.open);
    const yClose = yPrice(row.close);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(1, Math.abs(yClose - yOpen));
    ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
  });

  drawLine(ctx, visible, (row) => row.sma?.["20"], xFor, yPrice, colors.sma20, 1.2);
  drawLine(ctx, visible, (row) => row.sma?.["50"], xFor, yPrice, colors.sma50, 1.2);
  drawLine(ctx, visible, (row) => row.sma?.["100"], xFor, yPrice, colors.sma100, 1.1);
  drawLine(ctx, visible, (row) => row.sma?.["150"], xFor, yPrice, colors.sma150, 1.1);
  drawLine(ctx, visible, (row) => row.sma?.["200"], xFor, yPrice, colors.sma200, 2.2);
  if (indicators.rsi) {
    drawLine(ctx, visible, (row) => row.rsi14, xFor, yRsi, colors.rsi, 1.1);
    drawLine(ctx, visible, (row) => row.rsiMa14, xFor, yRsi, colors.rsiMa, 1.2);
    drawDivergenceSignals(ctx, findDivergences(visible, visible, (row) => row?.rsi14), xFor, yPrice, yRsi, "RSI", w - 120);
  }
  if (indicators.macd) {
    const zeroY = yMacd(0);
    ctx.strokeStyle = "rgba(232,237,242,0.18)";
    ctx.beginPath();
    ctx.moveTo(pad.left, zeroY);
    ctx.lineTo(pad.left + plotW, zeroY);
    ctx.stroke();
    visibleMacd.forEach((row, index) => {
      const x = xFor(index);
      const y = yMacd(row.hist || 0);
      ctx.fillStyle = (row.hist || 0) >= 0 ? "rgba(0,184,135,0.62)" : "rgba(255,76,90,0.62)";
      ctx.fillRect(x - 3, Math.min(zeroY, y), 6, Math.max(1, Math.abs(zeroY - y)));
    });
    drawLine(ctx, visibleMacd, (row) => row.macd, xFor, yMacd, colors.sma50, 1.1);
    drawLine(ctx, visibleMacd, (row) => row.signal, xFor, yMacd, colors.rsiMa, 1.1);
    drawDivergenceSignals(ctx, findDivergences(visible, visibleMacd, (row) => row?.macd), xFor, yPrice, yMacd, "MACD", w - 120);
  }

  ctx.fillStyle = "rgba(232,237,242,0.08)";
  ctx.font = "700 74px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(`${ticker} ${intervalLabels[interval]}`, w / 2, priceTop + priceH / 2);
  ctx.textAlign = "left";
  ctx.font = "12px system-ui";
  ctx.fillStyle = colors.text;
  ctx.fillText("SMA 20 50 100 150 200", pad.left, 16);
  if (indicators.rsi) ctx.fillText("RSI 14", pad.left, panelTops.rsi + 16);
  if (indicators.macd) ctx.fillText("MACD 12 26 9", pad.left, panelTops.macd + 16);
  ctx.fillStyle = colors.muted;
  ctx.textAlign = "right";
  ctx.fillText(`Y ${state.yScale.toFixed(2)}x · ${visible.length} bars`, w - 10, 16);
  ctx.textAlign = "left";
  drawCrosshairOverlay(ctx, state.chartLayout);
}

function drawGrid(ctx, x, y, w, h, rows, cols) {
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= rows; i++) {
    const yy = y + (h * i) / rows;
    ctx.beginPath();
    ctx.moveTo(x, yy);
    ctx.lineTo(x + w, yy);
    ctx.stroke();
  }
  for (let i = 0; i <= cols; i++) {
    const xx = x + (w * i) / cols;
    ctx.beginPath();
    ctx.moveTo(xx, y);
    ctx.lineTo(xx, y + h);
    ctx.stroke();
  }
}

function drawLine(ctx, rows, getter, xFor, yFor, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  let started = false;
  rows.forEach((row, index) => {
    const value = getter(row);
    if (value === null || value === undefined) {
      started = false;
      return;
    }
    const x = xFor(index);
    const y = yFor(value);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
}

function updateCrosshairFromPoint(clientX, clientY, lock = false) {
  const layout = state.chartLayout;
  const rows = layout?.visible || [];
  if (!rows.length) return;
  const rect = els.chart.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const inPlotX = x >= layout.pad.left && x <= layout.pad.left + layout.plotW;
  const inChartY = y >= layout.priceTop && y <= layout.volTop + layout.volH;
  if (!inPlotX || !inChartY) {
    if (!state.crosshairLocked) {
      state.crosshair = null;
      render();
    }
    return;
  }
  const index = clamp(Math.round(((x - layout.pad.left) / layout.plotW) * rows.length - 0.5), 0, rows.length - 1);
  const price = layout.pMax - ((clamp(y, layout.priceTop, layout.priceTop + layout.priceH) - layout.priceTop) / layout.priceH) * (layout.pMax - layout.pMin);
  state.crosshair = { index, x, y, price };
  state.crosshairLocked = lock || state.crosshairLocked;
  render();
}

function drawCrosshairOverlay(ctx, layout) {
  if (!state.crosshair || !layout?.visible?.length) return;
  const index = clamp(state.crosshair.index, 0, layout.visible.length - 1);
  const row = layout.visible[index];
  if (!row) return;
  const x = layout.xFor(index);
  const y = clamp(state.crosshair.y, layout.priceTop, layout.volTop + layout.volH);
  const price = state.crosshair.price ?? row.close;
  ctx.save();
  ctx.strokeStyle = "rgba(232,237,242,0.72)";
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(x, layout.priceTop);
  ctx.lineTo(x, layout.volTop + layout.volH);
  ctx.moveTo(layout.pad.left, y);
  ctx.lineTo(layout.pad.left + layout.plotW, y);
  ctx.stroke();
  ctx.setLineDash([]);

  const changeColor = row.change >= 0 ? colors.up : colors.down;
  const lines = [
    row.date,
    `O ${fmt(row.open)}  H ${fmt(row.high)}  L ${fmt(row.low)}  C ${fmt(row.close)}`,
    `Change ${fmt(row.change)} (${fmt(row.changePct)}%)  Vol ${fmtVolume(row.volume)}`,
    `SMA ${fmt(row.sma?.["20"])} / ${fmt(row.sma?.["50"])} / ${fmt(row.sma?.["100"])} / ${fmt(row.sma?.["150"])} / ${fmt(row.sma?.["200"])}`,
    `RSI ${fmt(row.rsi14)}  Pointer ${fmt(price)}`,
  ];
  const macd = macdRows(layout.visible)[index];
  if (macd) lines.push(`MACD ${fmt(macd.macd)}  Signal ${fmt(macd.signal)}  Hist ${fmt(macd.hist)}`);
  if (state.crosshairLocked) lines.push("Locked");
  ctx.font = "12px system-ui";
  const boxW = Math.min(390, Math.max(...lines.map((line) => ctx.measureText(line).width)) + 22);
  const boxH = lines.length * 19 + 18;
  const boxX = x + boxW + 18 > layout.width ? x - boxW - 18 : x + 16;
  const boxY = y + boxH + 14 > layout.height ? y - boxH - 14 : y + 14;
  ctx.fillStyle = "rgba(5,7,9,0.92)";
  ctx.strokeStyle = "rgba(232,237,242,0.2)";
  roundRect(ctx, boxX, boxY, boxW, boxH, 7);
  ctx.fill();
  ctx.stroke();
  lines.forEach((line, lineIndex) => {
    ctx.fillStyle = lineIndex === 2 ? changeColor : line === "Locked" ? colors.rsiMa : colors.text;
    ctx.fillText(line, boxX + 11, boxY + 20 + lineIndex * 19);
  });

  const priceText = fmt(price);
  const priceW = ctx.measureText(priceText).width + 16;
  ctx.fillStyle = "rgba(232,237,242,0.16)";
  ctx.strokeStyle = "rgba(232,237,242,0.28)";
  roundRect(ctx, layout.width - layout.pad.right + 6, y - 12, priceW, 24, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = colors.text;
  ctx.fillText(priceText, layout.width - layout.pad.right + 14, y + 4);
  ctx.restore();
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function emaNumberSeries(values, period) {
  const out = [];
  const multiplier = 2 / (period + 1);
  let ema = null;
  values.forEach((value) => {
    if (value === null || value === undefined || Number.isNaN(value)) {
      out.push(null);
      return;
    }
    ema = ema === null ? value : value * multiplier + ema * (1 - multiplier);
    out.push(ema);
  });
  return out;
}

function macdRows(rows) {
  const closes = rows.map((row) => row.close);
  const ema12 = emaNumberSeries(closes, 12);
  const ema26 = emaNumberSeries(closes, 26);
  const macd = rows.map((row, index) => ema12[index] - ema26[index]);
  const signal = emaNumberSeries(macd, 9);
  return rows.map((row, index) => ({
    date: row.date,
    macd: macd[index],
    signal: signal[index],
    hist: macd[index] - signal[index],
  }));
}

function drawVolumeProfile(ctx, rows, pMin, pMax, priceTop, priceH, plotLeft, plotW) {
  const bins = 34;
  const totals = Array.from({ length: bins }, () => ({ up: 0, down: 0 }));
  rows.forEach((row) => {
    const low = clamp(row.low, pMin, pMax);
    const high = clamp(row.high, pMin, pMax);
    const start = clamp(Math.floor(((low - pMin) / (pMax - pMin || 1)) * bins), 0, bins - 1);
    const end = clamp(Math.floor(((high - pMin) / (pMax - pMin || 1)) * bins), 0, bins - 1);
    const span = Math.max(1, end - start + 1);
    const key = row.close >= row.open ? "up" : "down";
    for (let index = start; index <= end; index += 1) totals[index][key] += (row.volume || 0) / span;
  });
  const maxTotal = Math.max(...totals.map((item) => item.up + item.down), 1);
  const profileW = Math.min(180, plotW * 0.16);
  const right = plotLeft + plotW - 4;
  const binH = priceH / bins;
  ctx.save();
  ctx.globalAlpha = 0.62;
  totals.forEach((item, index) => {
    const total = item.up + item.down;
    if (!total) return;
    const width = (total / maxTotal) * profileW;
    const upW = width * (item.up / total);
    const downW = width - upW;
    const y = priceTop + priceH - (index + 1) * binH + 1;
    ctx.fillStyle = "rgba(53,109,255,0.78)";
    ctx.fillRect(right - width, y, downW, Math.max(1, binH - 2));
    ctx.fillStyle = "rgba(209,139,0,0.82)";
    ctx.fillRect(right - upW, y, upW, Math.max(1, binH - 2));
  });
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "rgba(232,237,242,0.12)";
  ctx.strokeRect(right - profileW, priceTop, profileW, priceH);
  drawReportText(ctx, "Volume Profile", right - profileW + 8, priceTop + 14, 12, colors.muted, "700");
  ctx.restore();
}

function findPivots(rows, getter, mode = "low", span = 3) {
  const pivots = [];
  for (let index = span; index < rows.length - span; index += 1) {
    const value = getter(rows[index], index);
    if (value === null || value === undefined || Number.isNaN(value)) continue;
    let isPivot = true;
    for (let offset = index - span; offset <= index + span; offset += 1) {
      if (offset === index) continue;
      const other = getter(rows[offset], offset);
      if (other === null || other === undefined || Number.isNaN(other)) continue;
      if (mode === "low" ? other <= value : other >= value) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) pivots.push({ index, value });
  }
  return pivots;
}

function findDivergences(priceRows, indicatorRows, indicatorGetter) {
  const minGap = 6;
  const priceTolerance = 0.002;
  const indicatorTolerance = 0.01;
  const lows = findPivots(priceRows, (row) => row.low, "low");
  const highs = findPivots(priceRows, (row) => row.high, "high");
  const signals = [];

  const scanPairs = (pivots, type) => {
    for (let index = 1; index < pivots.length; index += 1) {
      const previous = pivots[index - 1];
      const current = pivots[index];
      if (current.index - previous.index < minGap) continue;
      const previousIndicator = indicatorGetter(indicatorRows[previous.index], previous.index);
      const currentIndicator = indicatorGetter(indicatorRows[current.index], current.index);
      if ([previousIndicator, currentIndicator].some((value) => value === null || value === undefined || Number.isNaN(value))) continue;
      const priceMove = (current.value - previous.value) / Math.max(Math.abs(previous.value), 0.01);
      const indicatorMove = currentIndicator - previousIndicator;
      if (type === "bullish" && priceMove < -priceTolerance && indicatorMove > indicatorTolerance) {
        signals.push({ type, previous, current, previousIndicator, currentIndicator });
      }
      if (type === "bearish" && priceMove > priceTolerance && indicatorMove < -indicatorTolerance) {
        signals.push({ type, previous, current, previousIndicator, currentIndicator });
      }
    }
  };

  scanPairs(lows, "bullish");
  scanPairs(highs, "bearish");
  return signals.sort((a, b) => b.current.index - a.current.index).slice(0, 2);
}

function drawDivergenceSignals(ctx, signals, xFor, yPrice, yIndicator, label, maxTagX = 1390) {
  signals.forEach((signal) => {
    const color = signal.type === "bullish" ? colors.up : colors.down;
    const marker = signal.type === "bullish" ? "Bull div" : "Bear div";
    const priceY1 = yPrice(signal.previous.value);
    const priceY2 = yPrice(signal.current.value);
    const indicatorY1 = yIndicator(signal.previousIndicator);
    const indicatorY2 = yIndicator(signal.currentIndicator);
    const x1 = xFor(signal.previous.index);
    const x2 = xFor(signal.current.index);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(x1, priceY1);
    ctx.lineTo(x2, priceY2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, indicatorY1);
    ctx.lineTo(x2, indicatorY2);
    ctx.stroke();
    ctx.setLineDash([]);
    const tagX = clamp(x2 + 8, 64, maxTagX);
    const tagY = signal.type === "bullish" ? priceY2 + 20 : priceY2 - 20;
    ctx.font = "800 12px system-ui";
    const text = `${label} ${marker}`;
    const textW = ctx.measureText(text).width + 14;
    ctx.fillStyle = "rgba(2,3,3,0.82)";
    ctx.fillRect(tagX, tagY - 10, textW, 20);
    ctx.strokeStyle = color;
    ctx.strokeRect(tagX, tagY - 10, textW, 20);
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, tagX + 7, tagY);
    ctx.restore();
  });
}

function renderTable(rows, interval = state.interval) {
  const headers = ["Date", "Open", "High", "Low", "Close", "Change", "Volume", "SMA20", "SMA50", "SMA100", "SMA150", "SMA200", "RSI14", "RSI MA"];
  els.tableTitle.textContent = `${intervalLabels[interval]} Data`;
  els.rawHead.innerHTML = `<tr>${headers.map((item) => `<th>${item}</th>`).join("")}</tr>`;
  els.rawBody.innerHTML = rows
    .slice()
    .reverse()
    .map((row) => {
      const cls = row.change >= 0 ? "up" : "down";
      return `<tr>
        <td>${row.date}</td>
        <td>${fmt(row.open)}</td>
        <td>${fmt(row.high)}</td>
        <td>${fmt(row.low)}</td>
        <td>${fmt(row.close)}</td>
        <td class="${cls}">${fmt(row.change)} (${fmt(row.changePct)}%)</td>
        <td>${fmtVolume(row.volume)}</td>
        <td>${fmt(row.sma?.["20"])}</td>
        <td>${fmt(row.sma?.["50"])}</td>
        <td>${fmt(row.sma?.["100"])}</td>
        <td>${fmt(row.sma?.["150"])}</td>
        <td>${fmt(row.sma?.["200"])}</td>
        <td>${fmt(row.rsi14)}</td>
        <td>${fmt(row.rsiMa14)}</td>
      </tr>`;
    })
    .join("");
  els.tableMeta.textContent = `${rows.length} rows · ${intervalLabels[interval]}`;
}

async function copyChart() {
  els.chart.toBlob(async (blob) => {
    if (!blob) return;
    copyImageBlob(blob, "Chart image copied", `${state.activeTicker}-${state.interval}.png`);
  });
}

function drawReportText(ctx, text, x, y, size = 24, color = colors.text, weight = "500", align = "left") {
  ctx.font = `${weight} ${size}px system-ui`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

function createReportChartCanvas(rows, ticker, interval) {
  const canvas = document.createElement("canvas");
  canvas.width = 1532;
  canvas.height = 620;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, w, h);
  if (!rows?.length) {
    drawReportText(ctx, `${ticker} · ${intervalLabels[interval]} no data`, 28, 42, 26, colors.text, "800");
    return canvas;
  }

  const visible = rows.slice(-160);
  const indicators = getSelectedOutputIndicators();
  const pad = { left: 62, right: 84, top: 76, bottom: 28 };
  const oscillatorPanels = [
    ...(indicators.rsi ? [{ key: "rsi", height: 96 }] : []),
    ...(indicators.macd ? [{ key: "macd", height: 110 }] : []),
  ];
  const panelGap = oscillatorPanels.length ? 18 : 0;
  const oscillatorH = oscillatorPanels.reduce((sum, panel) => sum + panel.height, 0) + Math.max(0, oscillatorPanels.length - 1) * 10;
  const volH = 90;
  const priceH = h - pad.top - pad.bottom - volH - oscillatorH - panelGap;
  const priceTop = pad.top;
  const volTop = priceTop + priceH;
  const panelTops = {};
  let panelTop = volTop + volH + panelGap;
  oscillatorPanels.forEach((panel) => {
    panelTops[panel.key] = panelTop;
    panelTop += panel.height + 10;
  });
  const plotW = w - pad.left - pad.right;
  const candleW = Math.max(2, Math.min(9, plotW / visible.length * 0.58));
  const prices = visible.flatMap((row) => [row.high, row.low, ...Object.values(row.sma || {}).filter(Boolean)]);
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);
  const pricePad = (maxPrice - minPrice) * 0.08 || 1;
  const pMax = maxPrice + pricePad;
  const pMin = minPrice - pricePad;
  const maxVol = Math.max(...visible.map((row) => row.volume || 0), 1);
  const xFor = (index) => pad.left + (index + 0.5) * (plotW / visible.length);
  const yPrice = (value) => priceTop + ((pMax - value) / (pMax - pMin)) * priceH;
  const yVol = (value) => volTop + volH - (value / maxVol) * (volH - 12);
  const yRsi = (value) => panelTops.rsi + ((80 - value) / 60) * 96;
  const macdAll = indicators.macd ? macdRows(rows) : [];
  const visibleMacd = indicators.macd ? macdAll.slice(-visible.length) : [];
  const macdMax = indicators.macd ? Math.max(...visibleMacd.flatMap((row) => [Math.abs(row.macd || 0), Math.abs(row.signal || 0), Math.abs(row.hist || 0)]), 0.01) : 1;
  const yMacd = (value) => panelTops.macd + 55 - (value / macdMax) * 45;

  drawGrid(ctx, pad.left, priceTop, plotW, priceH, 5, 6);
  drawGrid(ctx, pad.left, volTop, plotW, volH, 2, 6);
  if (indicators.rsi) drawGrid(ctx, pad.left, panelTops.rsi, plotW, 96, 3, 6);
  if (indicators.macd) drawGrid(ctx, pad.left, panelTops.macd, plotW, 110, 4, 6);

  ctx.font = "15px system-ui";
  ctx.fillStyle = colors.muted;
  for (let i = 0; i <= 5; i++) {
    const value = pMin + ((pMax - pMin) * i) / 5;
    ctx.fillText(fmt(value), w - pad.right + 10, yPrice(value) + 5);
  }
  for (let i = 0; i <= 6; i++) {
    const x = pad.left + (plotW * i) / 6;
    const index = clamp(Math.round(((visible.length - 1) * i) / 6), 0, visible.length - 1);
    ctx.textAlign = "center";
    ctx.fillText(formatDateLabel(visible[index]?.date, interval), x, volTop + volH + 16);
  }
  ctx.textAlign = "left";
  if (indicators.volumeProfile) drawVolumeProfile(ctx, visible, pMin, pMax, priceTop, priceH, pad.left, plotW);

  visible.forEach((row, index) => {
    const x = xFor(index);
    const up = row.close >= row.open;
    ctx.fillStyle = up ? "rgba(0,184,135,0.42)" : "rgba(255,76,90,0.48)";
    ctx.fillRect(x - candleW / 2, yVol(row.volume), candleW, volTop + volH - yVol(row.volume));
  });

  visible.forEach((row, index) => {
    const x = xFor(index);
    const up = row.close >= row.open;
    ctx.strokeStyle = up ? colors.up : colors.down;
    ctx.fillStyle = up ? colors.up : colors.down;
    ctx.beginPath();
    ctx.moveTo(x, yPrice(row.high));
    ctx.lineTo(x, yPrice(row.low));
    ctx.stroke();
    const yOpen = yPrice(row.open);
    const yClose = yPrice(row.close);
    ctx.fillRect(x - candleW / 2, Math.min(yOpen, yClose), candleW, Math.max(1, Math.abs(yClose - yOpen)));
  });

  drawLine(ctx, visible, (row) => row.sma?.["20"], xFor, yPrice, colors.sma20, 1.4);
  drawLine(ctx, visible, (row) => row.sma?.["50"], xFor, yPrice, colors.sma50, 1.4);
  drawLine(ctx, visible, (row) => row.sma?.["100"], xFor, yPrice, colors.sma100, 1.2);
  drawLine(ctx, visible, (row) => row.sma?.["150"], xFor, yPrice, colors.sma150, 1.2);
  drawLine(ctx, visible, (row) => row.sma?.["200"], xFor, yPrice, colors.sma200, 2.2);
  if (indicators.rsi) {
    drawLine(ctx, visible, (row) => row.rsi14, xFor, yRsi, colors.rsi, 1.2);
    drawLine(ctx, visible, (row) => row.rsiMa14, xFor, yRsi, colors.rsiMa, 1.2);
    drawDivergenceSignals(ctx, findDivergences(visible, visible, (row) => row?.rsi14), xFor, yPrice, yRsi, "RSI");
  }
  if (indicators.macd) {
    const zeroY = yMacd(0);
    ctx.strokeStyle = "rgba(232,237,242,0.18)";
    ctx.beginPath();
    ctx.moveTo(pad.left, zeroY);
    ctx.lineTo(pad.left + plotW, zeroY);
    ctx.stroke();
    visibleMacd.forEach((row, index) => {
      const x = xFor(index);
      const y = yMacd(row.hist || 0);
      ctx.fillStyle = (row.hist || 0) >= 0 ? "rgba(0,184,135,0.62)" : "rgba(255,76,90,0.62)";
      ctx.fillRect(x - 3, Math.min(zeroY, y), 6, Math.max(1, Math.abs(zeroY - y)));
    });
    drawLine(ctx, visibleMacd, (row) => row.macd, xFor, yMacd, colors.sma50, 1.2);
    drawLine(ctx, visibleMacd, (row) => row.signal, xFor, yMacd, colors.rsiMa, 1.2);
    drawDivergenceSignals(ctx, findDivergences(visible, visibleMacd, (row) => row?.macd), xFor, yPrice, yMacd, "MACD");
  }

  const last = rows[rows.length - 1];
  drawReportText(ctx, `${ticker} · ${intervalLabels[interval]}`, 24, 28, 22, colors.text, "800");
  drawReportText(ctx, `Close ${fmt(last.close)} · ${fmt(last.change)} (${fmt(last.changePct)}%)`, w - 24, 28, 17, last.change >= 0 ? colors.up : colors.down, "700", "right");
  drawReportText(ctx, "SMA 20 50 100 150 200", pad.left, 58, 14, colors.text, "500");
  if (indicators.rsi) drawReportText(ctx, "RSI 14", pad.left, panelTops.rsi + 14, 14, colors.text, "500");
  if (indicators.macd) drawReportText(ctx, "MACD 12 26 9", pad.left, panelTops.macd + 14, 14, colors.text, "500");
  return canvas;
}

function getReportTableRows(item, interval) {
  return getTableRows(item, interval).slice().reverse().slice(0, 32);
}

function reportTableHeight(rowCount) {
  const rowH = 34;
  return 56 + rowH * (rowCount + 1) + 24;
}

function drawReportTable(ctx, rows, interval, yOffset, width) {
  const rowH = 34;
  drawReportText(ctx, `${intervalLabels[interval]} Data · latest ${rows.length} rows`, 34, yOffset + 18, 22, colors.text, "800");
  const columns = [
    ["Date", 34, "left"],
    ["Open", 206, "right"],
    ["High", 316, "right"],
    ["Low", 426, "right"],
    ["Close", 536, "right"],
    ["Change", 676, "right"],
    ["Volume", 806, "right"],
    ["SMA20", 924, "right"],
    ["SMA50", 1036, "right"],
    ["SMA100", 1156, "right"],
    ["SMA150", 1276, "right"],
    ["SMA200", 1396, "right"],
    ["RSI", 1516, "right"],
  ];
  const headerY = yOffset + 56;
  ctx.fillStyle = "#101317";
  ctx.fillRect(24, headerY - 22, width - 48, rowH);
  columns.forEach(([label, x, align]) => drawReportText(ctx, label, x, headerY - 4, 15, colors.muted, "800", align));
  rows.forEach((row, index) => {
    const y = headerY + rowH * (index + 1);
    ctx.fillStyle = index % 2 === 0 ? "#060809" : "#0b0f13";
    ctx.fillRect(24, y - 22, width - 48, rowH);
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.moveTo(24, y + 12);
    ctx.lineTo(width - 24, y + 12);
    ctx.stroke();
    const values = [
      row.date,
      fmt(row.open),
      fmt(row.high),
      fmt(row.low),
      fmt(row.close),
      `${fmt(row.change)} (${fmt(row.changePct)}%)`,
      fmtVolume(row.volume),
      fmt(row.sma?.["20"]),
      fmt(row.sma?.["50"]),
      fmt(row.sma?.["100"]),
      fmt(row.sma?.["150"]),
      fmt(row.sma?.["200"]),
      fmt(row.rsi14),
    ];
    values.forEach((value, col) => {
      const color = col === 5 ? (row.change >= 0 ? colors.up : colors.down) : colors.text;
      drawReportText(ctx, value, columns[col][1], y - 4, 15, color, "500", columns[col][2]);
    });
  });
  return reportTableHeight(rows.length);
}

function createReportCanvas() {
  const item = state.data[state.activeTicker];
  const chartPanels = getSelectedOutputIntervals().filter((panel) => item && getRowsForInterval(item, panel).length);
  const includeTables = shouldIncludeOutputTables();
  const width = 1600;
  const chartH = 620;
  const gap = 24;
  const panelHeights = chartPanels.map((panel) => {
    const rows = includeTables ? getReportTableRows(item, panel) : [];
    return chartH + gap + (includeTables ? reportTableHeight(rows.length) + gap : 0);
  });
  const height = 110 + panelHeights.reduce((sum, value) => sum + value, 0) + 24;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#0b0f13";
  ctx.fillRect(0, 0, width, 86);
  drawReportText(ctx, `${state.activeTicker} · Multi Panel`, 34, 32, 30, colors.text, "800");
  drawReportText(ctx, `Source: ${item?.source || ""} · Intraday: ${item?.intradaySource || "n/a"}`, 34, 64, 17, colors.muted);
  const last = item?.daily?.[item.daily.length - 1];
  if (last) {
    const changeColor = last.change >= 0 ? colors.up : colors.down;
    drawReportText(ctx, `Close ${fmt(last.close)}`, width - 34, 30, 21, colors.text, "700", "right");
    drawReportText(ctx, `${fmt(last.change)} (${fmt(last.changePct)}%) · Vol ${fmtVolume(last.volume)}`, width - 34, 62, 17, changeColor, "600", "right");
  }

  let yOffset = 110;
  chartPanels.forEach((panel) => {
    const chart = createReportChartCanvas(item[panel], state.activeTicker, panel);
    ctx.drawImage(chart, 34, yOffset, width - 68, chartH);
    yOffset += chartH + gap;
    if (includeTables) {
      yOffset += drawReportTable(ctx, getReportTableRows(item, panel), panel, yOffset, width) + gap;
    }
  });
  return canvas;
}

function createSingleReportCanvas(interval) {
  const item = state.data[state.activeTicker];
  const rows = item ? getRowsForInterval(item, interval) : [];
  const includeTable = shouldIncludeOutputTables();
  const width = 1600;
  const chartH = 620;
  const gap = 24;
  const tableRows = includeTable ? getReportTableRows(item, interval) : [];
  const tableH = includeTable ? reportTableHeight(tableRows.length) + gap : 0;
  const height = 110 + chartH + gap + tableH + 24;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#0b0f13";
  ctx.fillRect(0, 0, width, 86);
  drawReportText(ctx, `${state.activeTicker} · ${intervalLabels[interval]} Report`, 34, 32, 30, colors.text, "800");
  drawReportText(ctx, `Source: ${item?.source || ""} · Intraday: ${item?.intradaySource || "n/a"}`, 34, 64, 17, colors.muted);
  const last = rows?.[rows.length - 1] || item?.daily?.[item.daily.length - 1];
  if (last) {
    const changeColor = last.change >= 0 ? colors.up : colors.down;
    drawReportText(ctx, `Close ${fmt(last.close)}`, width - 34, 30, 21, colors.text, "700", "right");
    drawReportText(ctx, `${fmt(last.change)} (${fmt(last.changePct)}%) · Vol ${fmtVolume(last.volume)}`, width - 34, 62, 17, changeColor, "600", "right");
  }
  const chart = createReportChartCanvas(rows, state.activeTicker, interval);
  ctx.drawImage(chart, 34, 110, width - 68, chartH);
  if (includeTable) drawReportTable(ctx, tableRows, interval, 110 + chartH + gap, width);
  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function copyImageBlob(blob, successMessage, fallbackName) {
  if (await tryCopyOrShareBlob(blob, fallbackName, successMessage)) return;
  await showImageFallback(blob, fallbackName);
  els.status.textContent = "Clipboard/share blocked. Use the preview image.";
}

async function tryCopyOrShareBlob(blob, filename, successMessage = "Image copied") {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("Clipboard image copy is not supported");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    els.status.textContent = successMessage;
    return true;
  } catch {
  }
  const file = new File([blob], filename, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: filename });
      els.status.textContent = "Share sheet opened";
      return true;
    } catch {
    }
  }
  return false;
}

async function showImageFallback(blob, filename) {
  document.querySelector(".image-fallback")?.remove();
  const url = URL.createObjectURL(blob);
  const overlay = document.createElement("div");
  overlay.className = "image-fallback";
  overlay.innerHTML = `
    <div class="image-fallback__panel" role="dialog" aria-modal="true">
      <div class="image-fallback__head">
        <strong>Image ready</strong>
        <button type="button" data-close-preview>Close</button>
      </div>
      <p>Use the button first. If iOS blocks it, tap the image for a clean image-only view.</p>
      <img alt="Generated chart image" src="${url}" />
      <div class="image-fallback__actions">
        <button type="button" data-copy-single-image>Copy / Share Image</button>
      </div>
    </div>
  `;
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay || event.target.dataset.closePreview !== undefined) {
      overlay.remove();
      URL.revokeObjectURL(url);
    } else if (event.target.dataset.copySingleImage !== undefined) {
      tryCopyOrShareBlob(blob, filename, "Chart image copied");
    } else if (event.target.matches(".image-fallback__panel img")) {
      showImageCopyFocus({ url: event.target.src, alt: event.target.alt, blob, filename });
    }
  });
  document.body.appendChild(overlay);
}

function showImageCopyFocus({ url, alt = "Generated image", blob = null, filename = "image.png" }) {
  document.querySelector(".image-copy-focus")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "image-copy-focus";
  overlay.innerHTML = `
    <button type="button" class="image-copy-focus__close" aria-label="Close image preview" data-close-focus>&times;</button>
    ${blob ? '<button type="button" class="image-copy-focus__action" data-copy-focus-image>Copy / Share</button>' : ""}
    <img alt="${alt}" src="${url}" />
  `;
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay || event.target.dataset.closeFocus !== undefined) overlay.remove();
    if (event.target.dataset.copyFocusImage !== undefined && blob) tryCopyOrShareBlob(blob, filename, "Image copied");
  });
  document.body.appendChild(overlay);
}

async function copyFullPage() {
  if (!state.activeTicker) {
    els.status.textContent = "Fetch data first, then copy reports.";
    return;
  }
  let item = state.data[state.activeTicker];
  const selectedIntervals = getSelectedOutputIntervals();
  if (selectedIntervals.some((interval) => ["hourly", "fourHour"].includes(interval))) {
    await ensureIntradayLoaded(state.activeTicker);
    item = state.data[state.activeTicker];
  }
  const intervals = selectedIntervals.filter((interval) => item && getRowsForInterval(item, interval).length);
  if (!intervals.length) {
    els.status.textContent = "No selected report has data yet.";
    return;
  }
  els.copyBundleBtn.disabled = true;
  els.status.textContent = `Preparing ${intervals.length} report image${intervals.length > 1 ? "s" : ""}...`;
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const images = [];
    for (const interval of intervals) {
      const canvas = createSingleReportCanvas(interval);
      const blob = await canvasToBlob(canvas);
      if (blob) {
        images.push({
          interval,
          filename: `${state.activeTicker}-${intervalLabels[interval].replace(/\s+/g, "-")}-report.png`,
          blob,
        });
      }
    }
    if (!images.length) {
      els.status.textContent = "Could not create report image.";
      return;
    }
    await showImageSetFallback(images);
    els.status.textContent = `${images.length} report image${images.length > 1 ? "s" : ""} ready. Use Copy / Share Image.`;
  } catch (error) {
    els.status.textContent = `Copy preview failed: ${error.message || String(error)}`;
  } finally {
    els.copyBundleBtn.disabled = false;
  }
}

async function showImageSetFallback(images) {
  document.querySelector(".image-fallback")?.remove();
  const urls = images.map((image) => ({ ...image, url: URL.createObjectURL(image.blob) }));
  const overlay = document.createElement("div");
  overlay.className = "image-fallback image-fallback--set";
  overlay.innerHTML = `
    <div class="image-fallback__panel image-fallback__panel--wide" role="dialog" aria-modal="true">
      <div class="image-fallback__head">
        <strong>${state.activeTicker} reports</strong>
        <button type="button" data-close-preview>Close</button>
      </div>
      <p>Swipe to pick an image, then use Copy / Share Image.</p>
      <div class="image-carousel-wrap">
        ${urls.length > 1 ? '<button type="button" class="image-nav image-nav--prev" data-report-prev aria-label="Previous report">&lsaquo;</button>' : ""}
        <div class="image-carousel" tabindex="0">
          ${urls
            .map(
              (image, index) => `
                <figure class="image-slide">
                  <figcaption>${index + 1}. ${intervalLabels[image.interval]} + ${shouldIncludeOutputTables() ? "Table" : "Chart"}</figcaption>
                  <img alt="${state.activeTicker} ${intervalLabels[image.interval]} report" src="${image.url}" data-preview-index="${index}" />
                  <button type="button" class="image-copy-button" data-copy-preview-image="${index}">Copy / Share Image</button>
                </figure>
              `
            )
            .join("")}
        </div>
        ${urls.length > 1 ? '<button type="button" class="image-nav image-nav--next" data-report-next aria-label="Next report">&rsaquo;</button>' : ""}
      </div>
      <div class="image-fallback__dots">
        ${urls.map((image, index) => `<button type="button" data-report-jump="${index}">${intervalLabels[image.interval]}</button>`).join("")}
      </div>
    </div>
  `;
  const carousel = overlay.querySelector(".image-carousel");
  const jumpButtons = [...overlay.querySelectorAll("[data-report-jump]")];
  const setActiveSlide = (index) => {
    const nextIndex = clamp(index, 0, urls.length - 1);
    const slide = carousel.children[nextIndex];
    if (slide) carousel.scrollTo({ left: slide.offsetLeft, behavior: "smooth" });
    jumpButtons.forEach((button, buttonIndex) => {
      button.classList.toggle("active", buttonIndex === nextIndex);
    });
  };
  const syncActiveSlide = () => {
    const width = carousel.clientWidth || 1;
    const index = clamp(Math.round(carousel.scrollLeft / width), 0, urls.length - 1);
    jumpButtons.forEach((button, buttonIndex) => {
      button.classList.toggle("active", buttonIndex === index);
    });
  };
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay || event.target.dataset.closePreview !== undefined) {
      overlay.remove();
      urls.forEach((image) => URL.revokeObjectURL(image.url));
    } else if (event.target.dataset.reportPrev !== undefined) {
      syncActiveSlide();
      const current = jumpButtons.findIndex((button) => button.classList.contains("active"));
      setActiveSlide((current < 0 ? 0 : current) - 1);
    } else if (event.target.dataset.reportNext !== undefined) {
      syncActiveSlide();
      const current = jumpButtons.findIndex((button) => button.classList.contains("active"));
      setActiveSlide((current < 0 ? 0 : current) + 1);
    } else if (event.target.dataset.reportJump !== undefined) {
      setActiveSlide(Number(event.target.dataset.reportJump));
    } else if (event.target.dataset.copyPreviewImage !== undefined) {
      const image = urls[Number(event.target.dataset.copyPreviewImage)];
      if (image) tryCopyOrShareBlob(image.blob, image.filename, `${intervalLabels[image.interval]} report copied`);
    } else if (event.target.matches(".image-slide img")) {
      const image = urls[Number(event.target.dataset.previewIndex)];
      showImageCopyFocus({ url: event.target.src, alt: event.target.alt, blob: image?.blob, filename: image?.filename });
    }
  });
  document.body.appendChild(overlay);
  carousel.addEventListener("scroll", () => requestAnimationFrame(syncActiveSlide));
  syncActiveSlide();
}

function downloadCsv() {
  const item = state.data[state.activeTicker];
  const rows = getTableRows(item, state.interval);
  const header = "Date,Open,High,Low,Close,Change,ChangePct,Volume,SMA20,SMA50,SMA100,SMA150,SMA200,RSI14,RSI_MA14";
  const csv = [header]
    .concat(rows.map((row) => [row.date, row.open, row.high, row.low, row.close, row.change, row.changePct, row.volume, row.sma?.["20"], row.sma?.["50"], row.sma?.["100"], row.sma?.["150"], row.sma?.["200"], row.rsi14, row.rsiMa14].join(",")))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.activeTicker}-${state.interval}-data.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

els.fetchBtn.onclick = fetchData;
els.tickers.addEventListener("input", syncActiveListFromInput);
els.groupSelect.addEventListener("change", () => switchTickerList(els.groupSelect.value));
els.addListBtn.onclick = addTickerList;
els.renameListBtn.onclick = renameTickerList;
els.moveListLeftBtn.onclick = () => moveActiveTickerList(-1);
els.moveListRightBtn.onclick = () => moveActiveTickerList(1);
els.deleteListBtn.onclick = deleteTickerList;
els.csvFile.onchange = importCsvFiles;
async function setIntervalView(interval) {
  state.interval = interval;
  resetChartView();
  setIntervalButtons();
  if (["hourly", "fourHour"].includes(interval)) await ensureIntradayLoaded();
  render();
  saveChartSession();
}

function setIntervalButtons() {
  [
    [els.dailyBtn, "daily"],
    [els.weeklyBtn, "weekly"],
    [els.hourlyBtn, "hourly"],
    [els.fourHourBtn, "fourHour"],
  ].forEach(([button, value]) => button.classList.toggle("active", value === state.interval));
}
els.dailyBtn.onclick = () => setIntervalView("daily");
els.weeklyBtn.onclick = () => setIntervalView("weekly");
els.hourlyBtn.onclick = () => setIntervalView("hourly");
els.fourHourBtn.onclick = () => setIntervalView("fourHour");
els.copyChartBtn.onclick = copyChart;
els.copyBundleBtn.onclick = copyFullPage;
els.downloadCsvBtn.onclick = downloadCsv;
document.querySelectorAll("[data-output-indicator]").forEach((input) => {
  input.addEventListener("change", () => {
    render();
    saveChartSession();
  });
});
window.addEventListener("resize", render);
window.addEventListener("beforeunload", saveChartSession);

els.chart.addEventListener("mousedown", (event) => {
  const rect = els.chart.getBoundingClientRect();
  const rows = getRows();
  if (!rows.length) return;
  state.chartPointerDown = { x: event.clientX, y: event.clientY };
  state.chartPointerDragged = false;
  if (event.clientX - rect.left >= rect.width - 86) {
    state.axisDrag = { y: event.clientY, scale: state.yScale };
    els.chart.classList.add("axis-dragging");
  } else {
    const visibleCount = Math.min(state.xVisible, rows.length);
    const barWidth = Math.max(1, (rect.width - 132) / visibleCount);
    state.panDrag = { x: event.clientX, offset: state.xOffset, barWidth };
    els.chart.classList.add("chart-panning");
  }
  event.preventDefault();
});

window.addEventListener("mousemove", (event) => {
  if (state.chartPointerDown && Math.hypot(event.clientX - state.chartPointerDown.x, event.clientY - state.chartPointerDown.y) > 4) {
    state.chartPointerDragged = true;
  }
  if (state.axisDrag) {
    const delta = state.axisDrag.y - event.clientY;
    state.yScale = clamp(state.axisDrag.scale * Math.exp(delta * 0.01), 0.45, 8);
    render();
  }
  if (state.panDrag) {
    const rows = getRows();
    const delta = event.clientX - state.panDrag.x;
    const bars = Math.round(delta / state.panDrag.barWidth);
    state.xOffset = clamp(state.panDrag.offset + bars, 0, Math.max(0, rows.length - state.xVisible));
    render();
    return;
  }
  if (!state.crosshairLocked && event.target === els.chart) {
    updateCrosshairFromPoint(event.clientX, event.clientY);
  }
});

window.addEventListener("mouseup", () => {
  state.axisDrag = null;
  state.panDrag = null;
  els.chart.classList.remove("axis-dragging");
  els.chart.classList.remove("chart-panning");
  state.chartPointerDown = null;
  saveChartSession();
});

els.chart.addEventListener("dblclick", (event) => {
  if (state.crosshairLocked) {
    state.crosshairLocked = false;
    state.crosshair = null;
    render();
    return;
  }
  const rect = els.chart.getBoundingClientRect();
  if (event.clientX - rect.left >= rect.width - 86) {
    state.yScale = 1;
  } else {
    state.xVisible = 180;
    state.xOffset = 0;
  }
  render();
});

els.chart.addEventListener("click", (event) => {
  const rect = els.chart.getBoundingClientRect();
  if (state.chartPointerDragged || event.clientX - rect.left >= rect.width - 86) return;
  state.crosshairLocked = false;
  updateCrosshairFromPoint(event.clientX, event.clientY, true);
});

els.chart.addEventListener("mouseleave", () => {
  if (state.crosshairLocked) return;
  state.crosshair = null;
  render();
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !state.crosshair) return;
  state.crosshair = null;
  state.crosshairLocked = false;
  render();
});

els.chart.addEventListener(
  "wheel",
  (event) => {
    const rows = getRows();
    if (!rows.length) return;
    const rect = els.chart.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x >= rect.width - 86) return;
    event.preventDefault();
    const oldCount = clamp(Math.round(state.xVisible), 20, rows.length);
    const nextCount = clamp(Math.round(oldCount * (event.deltaY < 0 ? 0.84 : 1.19)), 20, rows.length);
    const plotLeft = 56;
    const plotW = Math.max(1, rect.width - 132);
    const cursorRatio = clamp((x - plotLeft) / plotW, 0, 1);
    const oldStart = rows.length - state.xOffset - oldCount;
    const anchorIndex = oldStart + cursorRatio * oldCount;
    const nextStart = clamp(Math.round(anchorIndex - cursorRatio * nextCount), 0, Math.max(0, rows.length - nextCount));
    state.xVisible = nextCount;
    state.xOffset = rows.length - nextStart - nextCount;
    render();
  },
  { passive: false }
);

function touchPoint(event, index = 0) {
  const touch = event.touches[index];
  return { x: touch.clientX, y: touch.clientY };
}

function touchDistance(event) {
  const first = touchPoint(event, 0);
  const second = touchPoint(event, 1);
  return Math.hypot(second.x - first.x, second.y - first.y);
}

els.chart.addEventListener(
  "touchstart",
  (event) => {
    const rows = getRows();
    if (!rows.length) return;
    const rect = els.chart.getBoundingClientRect();
    if (event.touches.length === 1) {
      const point = touchPoint(event);
      const localX = point.x - rect.left;
      if (localX >= rect.width - 86) {
        state.touchDrag = { type: "axis", y: point.y, scale: state.yScale };
      } else {
        const visibleCount = Math.min(state.xVisible, rows.length);
        const barWidth = Math.max(1, (rect.width - 132) / visibleCount);
        state.touchDrag = { type: "pan", x: point.x, offset: state.xOffset, barWidth };
      }
    } else if (event.touches.length === 2) {
      const first = touchPoint(event, 0);
      const second = touchPoint(event, 1);
      const centerX = (first.x + second.x) / 2 - rect.left;
      const plotLeft = 56;
      const plotW = Math.max(1, rect.width - 132);
      state.touchPinch = {
        distance: touchDistance(event),
        visible: clamp(Math.round(state.xVisible), 20, rows.length),
        offset: state.xOffset,
        centerRatio: clamp((centerX - plotLeft) / plotW, 0, 1),
      };
      state.touchDrag = null;
    }
    event.preventDefault();
  },
  { passive: false }
);

els.chart.addEventListener(
  "touchmove",
  (event) => {
    const rows = getRows();
    if (!rows.length) return;
    if (event.touches.length === 1 && state.touchDrag) {
      const point = touchPoint(event);
      if (state.touchDrag.type === "axis") {
        const delta = state.touchDrag.y - point.y;
        state.yScale = clamp(state.touchDrag.scale * Math.exp(delta * 0.01), 0.45, 8);
      } else {
        const delta = point.x - state.touchDrag.x;
        const bars = Math.round(delta / state.touchDrag.barWidth);
        state.xOffset = clamp(state.touchDrag.offset + bars, 0, Math.max(0, rows.length - state.xVisible));
      }
      render();
      event.preventDefault();
      return;
    }
    if (event.touches.length === 2 && state.touchPinch) {
      const oldCount = state.touchPinch.visible;
      const ratio = state.touchPinch.distance / Math.max(1, touchDistance(event));
      const nextCount = clamp(Math.round(oldCount * ratio), 20, rows.length);
      const oldStart = rows.length - state.touchPinch.offset - oldCount;
      const anchorIndex = oldStart + state.touchPinch.centerRatio * oldCount;
      const nextStart = clamp(Math.round(anchorIndex - state.touchPinch.centerRatio * nextCount), 0, Math.max(0, rows.length - nextCount));
      state.xVisible = nextCount;
      state.xOffset = rows.length - nextStart - nextCount;
      render();
      event.preventDefault();
    }
  },
  { passive: false }
);

els.chart.addEventListener("touchend", (event) => {
  if (event.touches.length === 0) {
    state.touchDrag = null;
    state.touchPinch = null;
    saveChartSession();
  }
});

(async function init() {
  setDefaultDates();
  await loadTickerLists();
  restoreChartSession();
})();
