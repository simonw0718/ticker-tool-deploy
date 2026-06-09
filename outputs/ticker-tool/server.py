from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import re
from datetime import date, datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from http.cookiejar import CookieJar
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
CACHE = ROOT / "cache"
CACHE.mkdir(exist_ok=True)
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
STORE_KEYS = {"records", "tickerLists"}

STOOQ_URL = "https://stooq.com/q/d/l/"
STOOQ_ORIGIN = "https://stooq.com"
DEFAULT_TICKERS = ["AAPL", "MSFT", "NVDA", "TSLA", "SPY", "QQQ"]
DISPLAY_TIMEZONE = ZoneInfo("Asia/Taipei")
EXCHANGE_TIMEZONE = ZoneInfo("America/New_York")


def ymd(value: str) -> str:
    return datetime.strptime(value, "%Y-%m-%d").strftime("%Y%m%d")


def today_iso() -> str:
    return date.today().isoformat()


def days_ago_iso(days: int) -> str:
    return (date.today() - timedelta(days=days)).isoformat()


def normalize_ticker(ticker: str) -> str:
    return ticker.strip().upper().replace(".", "-")


def stooq_symbol(ticker: str) -> str:
    return f"{normalize_ticker(ticker).lower()}.us"


def cache_key(symbol: str, start: str, end: str) -> Path:
    raw = f"{symbol}|{start}|{end}"
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]
    return CACHE / f"{digest}.csv"


def read_cache(path: Path) -> str | None:
    if not path.exists():
        return None
    age = datetime.now().timestamp() - path.stat().st_mtime
    if age > 60 * 60 * 12:
        return None
    return path.read_text(encoding="utf-8")


def fetch_stooq_csv(ticker: str, start: str, end: str) -> tuple[str, str]:
    symbol = stooq_symbol(ticker)
    key = cache_key(symbol, start, end)
    cached = read_cache(key)
    if cached:
        return cached, "stooq-cache"

    params_dict = {"s": symbol, "d1": ymd(start), "d2": ymd(end), "i": "d"}
    if os.environ.get("STOOQ_APIKEY"):
        params_dict["apikey"] = os.environ["STOOQ_APIKEY"]
    params = urlencode(params_dict)
    body = stooq_get(f"{STOOQ_URL}?{params}")
    if body.lstrip().startswith("<") or "Get your apikey" in body:
        raise ValueError("Stooq requires browser verification or API key")
    key.write_text(body, encoding="utf-8")
    return body, "stooq"


def date_to_unix(value: str) -> int:
    return int(datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=EXCHANGE_TIMEZONE).timestamp())


def fetch_yahoo(ticker: str, start: str, end: str, interval: str = "1d") -> tuple[list[dict], str]:
    start_dt = datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=EXCHANGE_TIMEZONE)
    if interval != "1d":
        start_dt = max(start_dt, datetime.now(EXCHANGE_TIMEZONE) - timedelta(days=180))
    period1 = int(start_dt.timestamp())
    period2 = date_to_unix(end) + 24 * 60 * 60
    params = urlencode(
        {
            "period1": period1,
            "period2": period2,
            "interval": interval,
            "events": "history",
            "includeAdjustedClose": "true",
        }
    )
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{normalize_ticker(ticker)}?{params}"
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 ticker-k-tool/1.0",
            "Accept": "application/json",
        },
    )
    with urlopen(request, timeout=20) as response:
        body = response.read().decode("utf-8")
    payload = json.loads(body)
    result = payload.get("chart", {}).get("result", [])
    if not result:
        error = payload.get("chart", {}).get("error")
        raise ValueError(error.get("description") if error else "Yahoo returned no rows")
    chart = result[0]
    timestamps = chart.get("timestamp") or []
    quote = (chart.get("indicators", {}).get("quote") or [{}])[0]
    adjclose = (chart.get("indicators", {}).get("adjclose") or [{}])[0].get("adjclose") or []
    rows = []
    for index, ts in enumerate(timestamps):
        try:
            utc_dt = datetime.fromtimestamp(ts, ZoneInfo("UTC"))
            exchange_dt = utc_dt.astimezone(EXCHANGE_TIMEZONE)
            display_dt = utc_dt.astimezone(DISPLAY_TIMEZONE)
            values = {
                "date": exchange_dt.date().isoformat() if interval == "1d" else display_dt.strftime("%Y-%m-%d %H:%M"),
                "open": quote["open"][index],
                "high": quote["high"][index],
                "low": quote["low"][index],
                "close": quote["close"][index],
                "volume": quote["volume"][index],
            }
            if any(values[key] is None for key in ["open", "high", "low", "close"]):
                continue
            values["open"] = float(values["open"])
            values["high"] = float(values["high"])
            values["low"] = float(values["low"])
            values["close"] = float(values["close"])
            values["volume"] = int(values["volume"] or 0)
            if interval != "1d":
                if values["volume"] <= 0:
                    continue
                values["sessionDate"] = exchange_dt.date().isoformat()
                values["exchangeTime"] = exchange_dt.strftime("%H:%M")
            if index < len(adjclose) and adjclose[index] is not None:
                values["adjClose"] = float(adjclose[index])
            rows.append(values)
        except (KeyError, IndexError, TypeError, ValueError):
            continue
    if not rows:
        raise ValueError("Yahoo returned no usable OHLCV rows")
    rows.sort(key=lambda item: item["date"])
    return rows, "yahoo"


def four_hour_from_hourly(rows: list[dict]) -> list[dict]:
    by_day: dict[str, list[dict]] = {}
    for row in rows:
        by_day.setdefault(row.get("sessionDate") or row["date"].split(" ")[0], []).append(row)

    result: list[dict] = []
    for day_rows in by_day.values():
        day_rows.sort(key=lambda item: item["date"])
        for index in range(0, len(day_rows), 4):
            bucket = day_rows[index : index + 4]
            if not bucket:
                continue
            result.append(
                {
                    "date": bucket[0]["date"],
                    "sessionDate": bucket[0].get("sessionDate"),
                    "exchangeTime": bucket[0].get("exchangeTime"),
                    "open": bucket[0]["open"],
                    "high": max(item["high"] for item in bucket),
                    "low": min(item["low"] for item in bucket),
                    "close": bucket[-1]["close"],
                    "volume": sum(item["volume"] for item in bucket),
                }
            )
    result.sort(key=lambda item: item["date"])
    return result


def stooq_get(url: str) -> str:
    opener = build_opener(HTTPCookieProcessor(CookieJar()))
    headers = {"User-Agent": "Mozilla/5.0 ticker-k-tool/1.0"}
    request = Request(url, headers=headers)
    with opener.open(request, timeout=20) as response:
        body = response.read().decode("utf-8")

    if "__verify" not in body:
        return body

    challenge = re.search(r'const c="([^"]+)",d=(\d+)', body)
    if not challenge:
        return body
    token = challenge.group(1)
    difficulty = int(challenge.group(2))
    prefix = "0" * difficulty
    nonce = 0
    while True:
        digest = hashlib.sha256(f"{token}{nonce}".encode("utf-8")).hexdigest()
        if digest.startswith(prefix):
            break
        nonce += 1

    verify_body = urlencode({"c": token, "n": str(nonce)}).encode("utf-8")
    verify = Request(
        f"{STOOQ_ORIGIN}/__verify",
        data=verify_body,
        headers={
            **headers,
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": STOOQ_ORIGIN,
            "Referer": url,
        },
        method="POST",
    )
    with opener.open(verify, timeout=20) as response:
        response.read()
    with opener.open(Request(url, headers=headers), timeout=20) as response:
        return response.read().decode("utf-8")


def parse_ohlcv(body: str) -> list[dict]:
    if body.lstrip().startswith("<"):
        return []
    rows: list[dict] = []
    for row in csv.DictReader(body.splitlines()):
        if not row or row.get("Date") == "No data":
            continue
        try:
            rows.append(
                {
                    "date": row["Date"],
                    "open": float(row["Open"]),
                    "high": float(row["High"]),
                    "low": float(row["Low"]),
                    "close": float(row["Close"]),
                    "volume": int(float(row["Volume"])),
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    rows.sort(key=lambda item: item["date"])
    return rows


def sma(rows: list[dict], period: int, field: str = "close") -> list[dict]:
    values: list[dict] = []
    total = 0.0
    closes: list[float] = []
    for row in rows:
        close = row.get(field) or row["close"]
        closes.append(close)
        total += close
        if len(closes) > period:
            total -= closes.pop(0)
        values.append({"date": row["date"], "value": round(total / period, 4) if len(closes) == period else None})
    return values


def rsi(rows: list[dict], period: int = 14) -> list[dict]:
    if not rows:
        return []
    values = [{"date": rows[0]["date"], "value": None}]
    gains: list[float] = []
    losses: list[float] = []
    avg_gain = None
    avg_loss = None

    for index in range(1, len(rows)):
        change = rows[index]["close"] - rows[index - 1]["close"]
        gain = max(change, 0.0)
        loss = max(-change, 0.0)
        gains.append(gain)
        losses.append(loss)
        value = None
        if index == period:
            avg_gain = sum(gains[-period:]) / period
            avg_loss = sum(losses[-period:]) / period
        elif index > period and avg_gain is not None and avg_loss is not None:
            avg_gain = (avg_gain * (period - 1) + gain) / period
            avg_loss = (avg_loss * (period - 1) + loss) / period
        if avg_gain is not None and avg_loss is not None:
            value = 100.0 if avg_loss == 0 else 100 - (100 / (1 + avg_gain / avg_loss))
        values.append({"date": rows[index]["date"], "value": round(value, 4) if value is not None else None})
    return values


def weekly_from_daily(rows: list[dict]) -> list[dict]:
    buckets: dict[str, list[dict]] = {}
    for row in rows:
        dt = datetime.strptime(row["date"], "%Y-%m-%d").date()
        year, week, _ = dt.isocalendar()
        buckets.setdefault(f"{year}-{week:02d}", []).append(row)

    weekly: list[dict] = []
    for bucket in buckets.values():
        bucket.sort(key=lambda item: item["date"])
        weekly.append(
            {
                "date": bucket[-1]["date"],
                "open": bucket[0]["open"],
                "high": max(item["high"] for item in bucket),
                "low": min(item["low"] for item in bucket),
                "close": bucket[-1]["close"],
                "volume": sum(item["volume"] for item in bucket),
            }
        )
    weekly.sort(key=lambda item: item["date"])
    return weekly


def enrich(rows: list[dict]) -> list[dict]:
    sma_field = "adjClose" if any("adjClose" in row for row in rows) else "close"
    sma_sets = {period: sma(rows, period, sma_field) for period in [20, 50, 100, 150, 200]}
    rsi_rows = rsi(rows, 14)
    rsi_ma = sma([{"date": item["date"], "close": item["value"] or 0} for item in rsi_rows], 14)
    enriched = []
    for index, row in enumerate(rows):
        previous = rows[index - 1]["close"] if index else row["open"]
        change = row["close"] - previous
        change_pct = change / previous * 100 if previous else 0
        item = dict(row)
        item["change"] = round(change, 4)
        item["changePct"] = round(change_pct, 4)
        item["rsi14"] = rsi_rows[index]["value"]
        item["rsiMa14"] = rsi_ma[index]["value"] if rsi_rows[index]["value"] is not None else None
        item["sma"] = {str(period): sma_sets[period][index]["value"] for period in sma_sets}
        enriched.append(item)
    return enriched


def finite_or_none(value):
    if value is None:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def fetch_payload(tickers: list[str], start: str, end: str, raw_days: int) -> dict:
    result = {}
    for ticker in tickers:
        clean = normalize_ticker(ticker)
        if not clean:
            continue
        try:
            try:
                daily, source = fetch_yahoo(clean, start, end)
            except Exception:
                body, source = fetch_stooq_csv(clean, start, end)
                daily = parse_ohlcv(body)
                if not daily:
                    raise ValueError("No rows returned")
            weekly = weekly_from_daily(daily)
            try:
                hourly, hourly_source = fetch_yahoo(clean, start, end, "1h")
            except Exception:
                hourly, hourly_source = [], source
            four_hour = four_hour_from_hourly(hourly) if hourly else []
            result[clean] = {
                "ticker": clean,
                "source": source,
                "intradaySource": hourly_source,
                "daily": enrich(daily),
                "weekly": enrich(weekly),
                "hourly": enrich(hourly) if hourly else [],
                "fourHour": enrich(four_hour) if four_hour else [],
                "raw": enrich(daily)[-raw_days:],
            }
        except (HTTPError, URLError, TimeoutError, ValueError) as exc:
            result[clean] = {"ticker": clean, "error": str(exc), "daily": [], "weekly": [], "raw": []}
    return result


def fetch_quotes(tickers: list[str]) -> dict:
    end = today_iso()
    start = days_ago_iso(14)
    quotes = {}
    for ticker in tickers:
        clean = normalize_ticker(ticker)
        if not clean:
            continue
        try:
            rows, source = fetch_yahoo(clean, start, end, "1d")
            last = rows[-1]
            previous = rows[-2]["close"] if len(rows) > 1 else last["open"]
            change = last["close"] - previous
            change_pct = change / previous * 100 if previous else 0
            quotes[clean] = {
                "ticker": clean,
                "price": round(last["close"], 4),
                "date": last["date"],
                "change": round(change, 4),
                "changePct": round(change_pct, 4),
                "source": source,
            }
        except Exception as exc:
            quotes[clean] = {"ticker": clean, "error": str(exc)}
    return quotes


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/fetch":
            self.handle_fetch(parsed.query)
            return
        if parsed.path == "/api/quotes":
            self.handle_quotes(parsed.query)
            return
        if parsed.path.startswith("/api/store/"):
            self.handle_store_get(parsed.path)
            return
        if self.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/store/"):
            self.handle_store_post(parsed.path)
            return
        self.send_error(404)

    def handle_fetch(self, query: str):
        params = parse_qs(query)
        tickers = ",".join(params.get("tickers", [",".join(DEFAULT_TICKERS)])).replace("\n", ",").split(",")
        start = params.get("start", [days_ago_iso(365 * 3)])[0]
        end = params.get("end", [today_iso()])[0]
        raw_days = int(params.get("rawDays", ["30"])[0])
        payload = fetch_payload(tickers, start, end, raw_days)
        body = json.dumps({"start": start, "end": end, "data": payload}, allow_nan=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_quotes(self, query: str):
        params = parse_qs(query)
        tickers = ",".join(params.get("tickers", [""])).replace("\n", ",").split(",")
        payload = fetch_quotes(tickers)
        body = json.dumps({"data": payload}, allow_nan=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def store_path(self, path: str) -> Path | None:
        key = path.rsplit("/", 1)[-1]
        if key not in STORE_KEYS:
            return None
        return DATA / f"{key}.json"

    def handle_store_get(self, path: str):
        store = self.store_path(path)
        if store is None:
            self.send_error(404)
            return
        if store.exists():
            body = store.read_bytes()
        else:
            body = b"null"
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_store_post(self, path: str):
        store = self.store_path(path)
        if store is None:
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
            return
        tmp = store.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(store)
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    os.chdir(STATIC)
    port = int(os.environ.get("PORT", "8765"))
    host = os.environ.get("HOST", "0.0.0.0")
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Ticker K tool running at http://127.0.0.1:{port}")
    print(f"On the same Wi-Fi, open http://<your-mac-ip>:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
