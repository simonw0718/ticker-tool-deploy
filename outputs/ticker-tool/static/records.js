const STORAGE_KEY = "ticker-k-tool-records-v1";
const WATCH_TEMPLATE = `[Ticker]
1. Best add: close >OOO, + vol > OOO -->  add OO %, SL: OOO, core change to OOO
2. Pull back add: Retrace & hold > OOO + bullish reversal candle --> add OO %, SL: OOO
3. Strong add: close > OOO + vol > OOO --> add OO%, SL: OOO, core change to OOO`;

const defaultRecords = {
  pageTitle: "Trading Records",
  pageNote: "Position plan, trade records, and add timing.",
  dailyWatch: "",
  accounts: [
    {
      id: crypto.randomUUID(),
      title: "Account A",
      rows: [
        ["AMD", "(refresh shares)", "(refresh cost)", "401", "520 → 550+", "Only after reclaim/hold 500"],
        ["NVDA", "50", "208.10", "192", "230 → 250 → 280", "Add only after reclaiming 220+"],
        ["CRWV", "100", "99.20", "93", "115 → 130 → 142", "Add only above 115"],
        ["IREN", "100", "55.29", "46.5", "63.6 → 68 → 74", "Add only after reclaiming 63.6"],
        ["HIMS", "400", "26.55", "24.5", "28.5 → 32 → 38", "Add after stable close above 28.5"],
        ["ZETA", "1000", "19.94", "18.4", "24 → 26", "No add yet"],
        ["MU", "(core)", "(refresh)", "815", "950 → 1000+", "No add after vertical run"],
        ["DRAM", "(core)", "(refresh)", "54", "65 → 70", "No add after vertical run"],
      ],
    },
    {
      id: crypto.randomUUID(),
      title: "Account B",
      rows: [
        ["IOT", "300", "34.99", "32.00", "38 → 42 → 48", "Add only after reclaiming 38"],
        ["MSFT", "50", "415.26", "399", "435 → 455 → 480", "Add after reclaiming 435"],
        ["IONQ", "150", "49.32", "51", "65 → 72 → 80", "No add until trend repairs"],
        ["QCOM", "50", "236.77", "200", "248 → 260", "No add currently"],
      ],
    },
  ],
  trades: [
    {
      id: crypto.randomUUID(),
      title: "Trade Record",
      rows: [
        ["Buy", "2026-06-08", "NVDA", "50", "208.10", "", "Starter position after reclaim"],
        ["Sell", "2026-06-08", "AMD", "25", "160.20", "+4.8%", "Trim into resistance"],
      ],
    },
  ],
};

let records = normalizeRecords(loadRecords());

const root = document.querySelector("#recordsRoot");
const dailyWatchText = document.querySelector("#dailyWatchText");
const accountTemplate = document.querySelector("#accountTemplate");
const tradeTemplate = document.querySelector("#tradeTemplate");
const quoteState = {
  prices: {},
  loading: false,
};

function normalizeRecords(value) {
  const next = value || structuredClone(defaultRecords);
  next.pageTitle = next.pageTitle || defaultRecords.pageTitle;
  next.pageNote = next.pageNote || defaultRecords.pageNote;
  next.dailyWatch = typeof next.dailyWatch === "string" ? next.dailyWatch : "";
  if (next.pageNote.includes("chart notes")) next.pageNote = defaultRecords.pageNote;
  next.accounts = Array.isArray(next.accounts) ? next.accounts : structuredClone(defaultRecords.accounts);
  next.trades = Array.isArray(next.trades) ? next.trades : structuredClone(defaultRecords.trades);
  next.accounts.forEach((account) => {
    account.id ||= crypto.randomUUID();
    account.title ||= "Account";
    account.rows = Array.isArray(account.rows) ? account.rows : [];
    account.rows = account.rows.map(normalizeAccountRow);
  });
  next.trades.forEach((section) => {
    section.id ||= crypto.randomUUID();
    section.title ||= "Trade Record";
    section.rows = Array.isArray(section.rows) ? section.rows : [];
  });
  return next;
}

function normalizeAccountRow(row) {
  const values = Array.isArray(row) ? row : [];
  if (values.length >= 8) {
    return [values[0], values[1], values[3], values[5], values[6], values[7]].map((value) => value || "");
  }
  return [values[0], values[1], values[2], values[3], values[4], values[5]].map((value) => value || "");
}

function loadRecords() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return saved || structuredClone(defaultRecords);
  } catch {
    return structuredClone(defaultRecords);
  }
}

function saveRecords() {
  records = normalizeRecords(records);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  saveServerRecords();
}

async function hydrateRecordsFromServer() {
  try {
    const response = await fetch("/api/store/records");
    if (!response.ok) return;
    const saved = await response.json();
    if (!saved) return;
    records = normalizeRecords(saved);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    render();
    refreshPrices();
  } catch {
  }
}

function saveServerRecords() {
  fetch("/api/store/records", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(records),
  }).catch(() => {});
}

function render() {
  document.querySelector('[data-field="pageTitle"]').textContent = records.pageTitle;
  document.querySelector('[data-field="pageNote"]').textContent = records.pageNote;
  dailyWatchText.value = records.dailyWatch || "";
  root.innerHTML = "";
  records.accounts.forEach((account) => root.appendChild(renderAccount(account)));
  records.trades.forEach((section) => root.appendChild(renderTradeSection(section)));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.style.position = "fixed";
    fallback.style.left = "-9999px";
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
}

async function copyWatchTemplate() {
  await copyText(WATCH_TEMPLATE);
}

function renderAccount(account) {
  const node = accountTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.accountId = account.id;
  node.querySelector('[data-role="account-title"]').textContent = account.title;
  const tbody = node.querySelector("tbody");
  account.rows.forEach((row, rowIndex) => tbody.appendChild(renderAccountRow(account.id, row, rowIndex)));
  return node;
}

function renderTradeSection(section) {
  const node = tradeTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.tradeSectionId = section.id;
  node.querySelector('[data-role="trade-title"]').textContent = section.title;
  const tbody = node.querySelector("tbody");
  section.rows.forEach((row, rowIndex) => tbody.appendChild(renderEditableRow("trade", section.id, row, rowIndex, 7)));
  return node;
}

function renderEditableRow(kind, sectionId, row, rowIndex, columnCount) {
  const tr = document.createElement("tr");
  for (let colIndex = 0; colIndex < columnCount; colIndex += 1) {
    const td = document.createElement("td");
    td.contentEditable = "true";
    td.dataset.kind = kind;
    td.dataset.sectionId = sectionId;
    td.dataset.rowIndex = rowIndex;
    td.dataset.colIndex = colIndex;
    td.textContent = row[colIndex] || "";
    tr.appendChild(td);
  }
  const action = document.createElement("td");
  const button = document.createElement("button");
  button.className = "delete-row";
  button.dataset.action = kind === "trade" ? "delete-trade-row" : "delete-row";
  button.dataset.sectionId = sectionId;
  button.dataset.rowIndex = rowIndex;
  button.textContent = "Delete";
  action.appendChild(button);
  tr.appendChild(action);
  return tr;
}

function renderAccountRow(accountId, row, rowIndex) {
  const tr = document.createElement("tr");
  tr.dataset.kind = "account";
  tr.dataset.sectionId = accountId;
  tr.dataset.rowIndex = rowIndex;
  const editableCols = [
    [0, "name"],
    [1, "shares"],
    [2, "cost"],
    [3, "stop"],
    [4, "target"],
    [5, "timing"],
  ];
  const layout = [
    { type: "editable", source: editableCols[0] },
    { type: "editable", source: editableCols[1] },
    { type: "price" },
    { type: "editable", source: editableCols[2] },
    { type: "gain" },
    { type: "editable", source: editableCols[3] },
    { type: "editable", source: editableCols[4] },
    { type: "editable", source: editableCols[5] },
  ];
  layout.forEach((cell) => {
    const td = document.createElement("td");
    if (cell.type === "editable") {
      const [colIndex] = cell.source;
      td.contentEditable = "true";
      td.dataset.kind = "account";
      td.dataset.sectionId = accountId;
      td.dataset.rowIndex = rowIndex;
      td.dataset.colIndex = colIndex;
      td.textContent = row[colIndex] || "";
    } else {
      td.dataset.auto = cell.type;
      td.className = "auto-cell";
    }
    tr.appendChild(td);
  });
  const action = document.createElement("td");
  const button = document.createElement("button");
  button.className = "delete-row";
  button.dataset.action = "delete-row";
  button.dataset.sectionId = accountId;
  button.dataset.rowIndex = rowIndex;
  button.textContent = "Delete";
  action.appendChild(button);
  tr.appendChild(action);
  updateComputedAccountRow(tr);
  return tr;
}

function tickerFromName(value) {
  const match = String(value || "").toUpperCase().match(/[A-Z][A-Z0-9.-]{0,9}/);
  return match ? match[0].replace(".", "-") : "";
}

function parseMoney(value) {
  const numeric = String(value || "").replace(/[$,%\s,]/g, "");
  const parsed = Number(numeric);
  return Number.isFinite(parsed) ? parsed : null;
}

function fmtPrice(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  return Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  return `${value >= 0 ? "+" : ""}${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function accountTickers() {
  return [...new Set(records.accounts.flatMap((account) => account.rows.map((row) => tickerFromName(row[0]))).filter(Boolean))];
}

function computedAccountValues(row) {
  const ticker = tickerFromName(row[0]);
  const quote = quoteState.prices[ticker];
  const price = quote?.price;
  const cost = parseMoney(row[2]);
  const gainPct = price !== undefined && cost ? ((price - cost) / cost) * 100 : null;
  return { ticker, price, gainPct };
}

function updateComputedAccountRow(tr) {
  const section = findAccount(tr.dataset.sectionId);
  const row = section?.rows[Number(tr.dataset.rowIndex)];
  if (!row) return;
  const { ticker, price, gainPct } = computedAccountValues(row);
  const priceCell = tr.querySelector('[data-auto="price"]');
  const gainCell = tr.querySelector('[data-auto="gain"]');
  if (priceCell) {
    const quote = quoteState.prices[ticker];
    priceCell.textContent = quote?.error ? "n/a" : price !== undefined ? fmtPrice(price) : quoteState.loading ? "..." : "";
    priceCell.title = quote?.date ? `${ticker} ${quote.date}` : ticker;
  }
  if (gainCell) {
    gainCell.textContent = fmtPct(gainPct);
    gainCell.classList.toggle("up", gainPct !== null && gainPct >= 0);
    gainCell.classList.toggle("down", gainPct !== null && gainPct < 0);
  }
}

function updateAllComputedRows() {
  document.querySelectorAll('tr[data-kind="account"]').forEach(updateComputedAccountRow);
}

async function refreshPrices() {
  const tickers = accountTickers();
  if (!tickers.length) {
    updateAllComputedRows();
    return;
  }
  quoteState.loading = true;
  updateAllComputedRows();
  try {
    const response = await fetch(`/api/quotes?tickers=${encodeURIComponent(tickers.join(","))}`);
    const payload = await response.json();
    quoteState.prices = payload.data || {};
  } catch {
    quoteState.prices = {};
  } finally {
    quoteState.loading = false;
    updateAllComputedRows();
  }
}

function findAccount(id) {
  return records.accounts.find((account) => account.id === id);
}

function findTradeSection(id) {
  return records.trades.find((section) => section.id === id);
}

function addAccount() {
  records.accounts.push({
    id: crypto.randomUUID(),
    title: "New Account",
    rows: [["Ticker", "", "", "", "", ""]],
  });
  saveRecords();
  render();
  refreshPrices();
}

function addAccountRow(accountId) {
  findAccount(accountId).rows.push(["", "", "", "", "", ""]);
  saveRecords();
  render();
  refreshPrices();
}

function addTradeSection() {
  if (!records.trades.length) {
    records.trades.push({ id: crypto.randomUUID(), title: "Trade Record", rows: [] });
  }
  records.trades[0].rows.push(["Buy", new Date().toISOString().slice(0, 10), "", "", "", "", ""]);
  saveRecords();
  render();
}

function addTradeRow(sectionId) {
  findTradeSection(sectionId).rows.push(["Buy", new Date().toISOString().slice(0, 10), "", "", "", "", ""]);
  saveRecords();
  render();
}

function exportJson() {
  saveRecords();
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "trading-records.json";
  link.click();
  URL.revokeObjectURL(url);
}

function insertPlainText(text) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;
  selection.deleteFromDocument();
  selection.getRangeAt(0).insertNode(document.createTextNode(text));
  selection.collapseToEnd();
}

function sanitizeEditableContent(element) {
  if (![...element.childNodes].some((node) => node.nodeType === Node.ELEMENT_NODE)) return;
  element.textContent = element.textContent;
}

function reportText(ctx, text, x, y, size = 22, weight = "500", color = "#e8edf2", align = "left") {
  ctx.font = `${weight} ${size}px system-ui`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(text || "", x, y);
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  String(text || "").split(/\n/).forEach((paragraph) => {
    const words = paragraph.split(/\s+/);
    let line = "";
    words.forEach((word) => {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width <= maxWidth || !line) {
        line = test;
      } else {
        lines.push(line);
        line = word;
      }
    });
    lines.push(line);
  });
  return lines;
}

function drawTextBlockToCanvas(ctx, title, text, y, width, margin) {
  reportText(ctx, title, margin, y, 22, "800");
  y += 34;
  const lines = wrapText(ctx, text || "", width - margin * 2 - 28);
  const lineH = 22;
  const boxH = Math.max(68, lines.length * lineH + 28);
  ctx.fillStyle = "#080a0d";
  ctx.fillRect(margin, y, width - margin * 2, boxH);
  ctx.strokeStyle = "#252a31";
  ctx.strokeRect(margin, y, width - margin * 2, boxH);
  lines.forEach((line, index) => {
    reportText(ctx, line, margin + 14, y + 22 + index * lineH, 17);
  });
  return y + boxH + 44;
}

function drawTableToCanvas(ctx, title, headers, rows, columns, y, width, margin, rowH) {
  reportText(ctx, title, margin, y, 22, "800");
  y += 42;
  ctx.strokeStyle = "#252a31";
  ctx.lineWidth = 1;
  headers.forEach((label, index) => reportText(ctx, label, columns[index][0], y, 16, "800", "#8c949f"));
  y += 22;
  ctx.beginPath();
  ctx.moveTo(margin, y);
  ctx.lineTo(width - margin, y);
  ctx.stroke();
  rows.forEach((row) => {
    y += rowH;
    ctx.fillStyle = "#080a0d";
    ctx.fillRect(margin, y - rowH + 1, width - margin * 2, rowH - 1);
    ctx.beginPath();
    ctx.moveTo(margin, y);
    ctx.lineTo(width - margin, y);
    ctx.stroke();
    columns.forEach(([x, maxWidth], index) => {
      const value = row[index] || "";
      const lines = wrapText(ctx, value, maxWidth);
      lines.slice(0, 2).forEach((line, lineIndex) => reportText(ctx, line, x, y - 26 + 18 + lineIndex * 17, 17));
    });
  });
  return y + 44;
}

async function createRecordsCanvas() {
  saveRecords();
  const width = 1500;
  const margin = 42;
  const rowH = 52;
  let height = 110;
  if (records.dailyWatch) {
    height += 56 + Math.max(68, wrapText({ measureText: (value) => ({ width: String(value).length * 9 }) }, records.dailyWatch, width - margin * 2 - 28).length * 22 + 28) + 44;
  }
  records.accounts.forEach((account) => {
    height += 56 + rowH * (account.rows.length + 1) + 44;
  });
  records.trades.forEach((section) => {
    height += 56 + rowH * (section.rows.length + 1) + 44;
  });
  height += 42;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#070809";
  ctx.fillRect(0, 0, width, height);

  reportText(ctx, records.pageTitle, margin, 42, 30, "800");
  reportText(ctx, records.pageNote, margin, 75, 17, "500", "#8c949f");

  let y = 128;
  if (records.dailyWatch) {
    y = drawTextBlockToCanvas(ctx, "Daily Watch Add / S/L", records.dailyWatch, y, width, margin);
  }
  const accountHeaders = ["Name", "Shares", "Price Today", "Cost", "G/L %", "Stop Loss", "Target", "Add Timing"];
  const accountColumns = [
    [margin, 120],
    [170, 120],
    [300, 120],
    [430, 110],
    [550, 100],
    [670, 120],
    [820, 170],
    [1035, 390],
  ];
  records.accounts.forEach((account) => {
    const rows = account.rows.map((row) => {
      const computed = computedAccountValues(row);
      return [row[0], row[1], fmtPrice(computed.price), row[2], fmtPct(computed.gainPct), row[3], row[4], row[5]];
    });
    y = drawTableToCanvas(ctx, account.title, accountHeaders, rows, accountColumns, y, width, margin, rowH);
  });

  const tradeHeaders = ["Buy or Sell", "Date", "Name", "Shares", "Cost", "G/L", "Reason"];
  const tradeColumns = [
    [margin, 120],
    [178, 130],
    [326, 120],
    [468, 110],
    [606, 120],
    [748, 120],
    [894, 520],
  ];
  records.trades.forEach((section) => {
    y = drawTableToCanvas(ctx, section.title, tradeHeaders, section.rows, tradeColumns, y, width, margin, rowH);
  });

  return canvas;
}

async function copyRecords() {
  const canvas = await createRecordsCanvas();
  canvas.toBlob(async (blob) => {
    if (!blob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    } catch {
      await showImageFallback(blob, "trading-records.png");
    }
  }, "image/png");
}

async function showImageFallback(blob, filename) {
  const file = new File([blob], filename, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch {
    }
  }
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
      <p>Mobile browser blocked direct copy. Long-press the image to copy/save, or open/download it.</p>
      <img alt="Generated records image" src="${url}" />
      <div class="image-fallback__actions">
        <a href="${url}" target="_blank" rel="noopener">Open Image</a>
        <a href="${url}" download="${filename}">Download</a>
      </div>
    </div>
  `;
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay || event.target.dataset.closePreview !== undefined) {
      overlay.remove();
      URL.revokeObjectURL(url);
    }
  });
  document.body.appendChild(overlay);
}

document.addEventListener("input", (event) => {
  const target = event.target;
  if (target.isContentEditable) sanitizeEditableContent(target);
  if (target.dataset.field === "pageTitle") records.pageTitle = target.textContent;
  if (target.dataset.field === "pageNote") records.pageNote = target.textContent;
  if (target.dataset.role === "account-title") {
    findAccount(target.closest(".account").dataset.accountId).title = target.textContent;
  }
  if (target.dataset.role === "trade-title") {
    findTradeSection(target.closest(".trade-record").dataset.tradeSectionId).title = target.textContent;
  }
  if (target.tagName === "TD" && target.dataset.sectionId) {
    const section = target.dataset.kind === "trade" ? findTradeSection(target.dataset.sectionId) : findAccount(target.dataset.sectionId);
    section.rows[Number(target.dataset.rowIndex)][Number(target.dataset.colIndex)] = target.textContent;
    if (target.dataset.kind === "account") {
      updateComputedAccountRow(target.closest("tr"));
      if (Number(target.dataset.colIndex) === 0) refreshPrices();
    }
  }
  saveRecords();
});

document.addEventListener("paste", (event) => {
  const target = event.target;
  if (target === dailyWatchText) {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain").replace(/\r\n/g, "\n");
    const start = target.selectionStart;
    const end = target.selectionEnd;
    target.value = `${target.value.slice(0, start)}${text}${target.value.slice(end)}`;
    target.selectionStart = target.selectionEnd = start + text.length;
    records.dailyWatch = target.value;
    saveRecords();
    return;
  }
  if (!target.isContentEditable) return;
  event.preventDefault();
  const text = event.clipboardData.getData("text/plain").replace(/\r\n/g, "\n");
  insertPlainText(text);
  target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
});

document.addEventListener("click", (event) => {
  const action = event.target.dataset.action;
  if (!action) return;
  const accountNode = event.target.closest(".account");
  const tradeNode = event.target.closest(".trade-record");
  if (action === "add-row") addAccountRow(accountNode.dataset.accountId);
  if (action === "delete-row") {
    findAccount(event.target.dataset.sectionId).rows.splice(Number(event.target.dataset.rowIndex), 1);
    saveRecords();
    render();
    refreshPrices();
  }
  if (action === "delete-account") {
    records.accounts = records.accounts.filter((account) => account.id !== accountNode.dataset.accountId);
    saveRecords();
    render();
    refreshPrices();
  }
  if (action === "add-trade-row") addTradeRow(tradeNode.dataset.tradeSectionId);
  if (action === "delete-trade-row") {
    findTradeSection(event.target.dataset.sectionId).rows.splice(Number(event.target.dataset.rowIndex), 1);
    saveRecords();
    render();
  }
  if (action === "delete-trade-section") {
    records.trades = records.trades.filter((section) => section.id !== tradeNode.dataset.tradeSectionId);
    saveRecords();
    render();
  }
});

document.querySelector("#addAccountBtn").onclick = addAccount;
document.querySelector("#addTradeBtn").onclick = addTradeSection;
document.querySelector("#exportBtn").onclick = exportJson;
document.querySelector("#copyRecordsBtn").onclick = copyRecords;
document.querySelector("#refreshPricesBtn").onclick = refreshPrices;
document.querySelector("#copyWatchTemplateBtn").onclick = copyWatchTemplate;
dailyWatchText.addEventListener("input", () => {
  records.dailyWatch = dailyWatchText.value;
  saveRecords();
});
document.querySelector("#resetBtn").onclick = () => {
  records = structuredClone(defaultRecords);
  saveRecords();
  render();
  refreshPrices();
};

render();
refreshPrices();
hydrateRecordsFromServer();
