import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFile, readFileSync } from "node:fs";
import http, { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  BootstrapResponse,
  IngestRequest,
  IngestResponse,
  MarketData,
  NewsData,
  ProviderStatus,
  TickerData,
} from "./shared/types";
import {
  createMarketDataProvider,
  StoredNewsEvent,
  StoredPricePoint,
} from "./server/marketDataProvider";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const ROOT_DIR = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const CLIENT_DIST_DIR = path.join(ROOT_DIR, "dist", "client");
const DATA_DIR = path.join(ROOT_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "taco-trader.db");
const SAMPLE_MARKET_PATH = path.join(PUBLIC_DIR, "data", "market-data.json");
const SAMPLE_NEWS_PATH = path.join(PUBLIC_DIR, "data", "news-data.json");
const DEFAULT_SYMBOLS = ["SPY", "QQQ", "AAPL", "XLI", "XLE"];

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

interface NewsRow {
  id: string;
  published_at: string;
  category: string;
  stance: string;
  title: string;
  summary: string;
  source: string;
  url: string;
  impact: number;
  symbols_json: string;
}

mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_PATH);
const marketDataProvider = createMarketDataProvider(ROOT_DIR);

initializeDatabase();
seedDatabaseFromSamples();

function initializeDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickers (
      symbol TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_history (
      symbol TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      PRIMARY KEY (symbol, trade_date),
      FOREIGN KEY (symbol) REFERENCES tickers(symbol)
    );

    CREATE TABLE IF NOT EXISTS news_articles (
      id TEXT PRIMARY KEY,
      published_at TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      source TEXT NOT NULL,
      url TEXT NOT NULL,
      category TEXT NOT NULL,
      stance TEXT NOT NULL,
      impact REAL NOT NULL,
      symbols_json TEXT NOT NULL,
      article_source TEXT NOT NULL DEFAULT 'sample'
    );

    CREATE TABLE IF NOT EXISTS ingest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      symbols_json TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT ''
    );
  `);
}

function seedDatabaseFromSamples(): void {
  const priceCount = db.prepare("SELECT COUNT(*) AS count FROM price_history").get() as { count: number };
  const newsCount = db.prepare("SELECT COUNT(*) AS count FROM news_articles").get() as { count: number };

  if (priceCount.count === 0) {
    const marketData = JSON.parse(readFileSync(SAMPLE_MARKET_PATH, "utf8")) as MarketData;
    for (const ticker of marketData.tickers) {
      upsertTicker(ticker.symbol, ticker.name);
      const rows = ticker.prices.map((price) => ({
        date: price.date,
        close: price.close,
        open: price.open ?? price.close,
        high: price.high ?? price.close,
        low: price.low ?? price.close,
        volume: price.volume ?? 0,
      }));
      upsertPriceHistory(ticker.symbol, rows, "sample");
    }
  }

  if (newsCount.count === 0) {
    const newsData = JSON.parse(readFileSync(SAMPLE_NEWS_PATH, "utf8")) as NewsData;
    const sampleEvents: StoredNewsEvent[] = newsData.events.map((event) => ({
      ...event,
      source: event.source ?? "Sample Tape",
      url: event.url ?? `https://example.com/${event.id}`,
    }));
    upsertNewsEvents(sampleEvents, "sample");
  }
}

function upsertTicker(symbol: string, name: string): void {
  db.prepare(
    `
      INSERT INTO tickers (symbol, name)
      VALUES (?, ?)
      ON CONFLICT(symbol) DO UPDATE SET name = excluded.name
    `,
  ).run(symbol, name);
}

function upsertPriceHistory(symbol: string, rows: StoredPricePoint[], source: string): void {
  const statement = db.prepare(
    `
      INSERT INTO price_history (symbol, trade_date, open, high, low, close, volume, source)
      VALUES (@symbol, @trade_date, @open, @high, @low, @close, @volume, @source)
      ON CONFLICT(symbol, trade_date) DO UPDATE SET
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        source = excluded.source
    `,
  );

  const insertMany = db.transaction((items: StoredPricePoint[]) => {
    for (const row of items) {
      statement.run({
        symbol,
        trade_date: row.date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        source,
      });
    }
  });

  insertMany(rows);
}

function upsertNewsEvents(events: StoredNewsEvent[], articleSource: string): void {
  const statement = db.prepare(
    `
      INSERT INTO news_articles (
        id,
        published_at,
        title,
        summary,
        source,
        url,
        category,
        stance,
        impact,
        symbols_json,
        article_source
      )
      VALUES (@id, @published_at, @title, @summary, @source, @url, @category, @stance, @impact, @symbols_json, @article_source)
      ON CONFLICT(id) DO UPDATE SET
        published_at = excluded.published_at,
        title = excluded.title,
        summary = excluded.summary,
        source = excluded.source,
        url = excluded.url,
        category = excluded.category,
        stance = excluded.stance,
        impact = excluded.impact,
        symbols_json = excluded.symbols_json,
        article_source = excluded.article_source
    `,
  );

  const insertMany = db.transaction((items: StoredNewsEvent[]) => {
    for (const event of items) {
      statement.run({
        id: event.id,
        published_at: event.date,
        title: event.title,
        summary: event.summary,
        source: event.source,
        url: event.url,
        category: event.category,
        stance: event.stance,
        impact: event.impact,
        symbols_json: JSON.stringify(event.tickers),
        article_source: articleSource,
      });
    }
  });

  insertMany(events);
}

function getRequestedSymbols(url: URL): string[] {
  const raw = url.searchParams.get("symbols");
  if (!raw) {
    return DEFAULT_SYMBOLS;
  }

  return raw
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
}

function getMarketData(symbols: string[]): MarketData {
  const tickers: TickerData[] = [];
  const tickerRows = db
    .prepare(
      `
        SELECT symbol, name
        FROM tickers
        WHERE symbol IN (${symbols.map(() => "?").join(",")})
        ORDER BY symbol ASC
      `,
    )
    .all(...symbols) as Array<{ symbol: string; name: string }>;

  const priceStatement = db.prepare(
    `
      SELECT trade_date, open, high, low, close, volume
      FROM price_history
      WHERE symbol = ?
      ORDER BY trade_date DESC
      LIMIT 90
    `,
  );

  for (const ticker of tickerRows) {
    const priceRows = priceStatement.all(ticker.symbol) as Array<{
      trade_date: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>;

    tickers.push({
      symbol: ticker.symbol,
      name: ticker.name,
      prices: priceRows.reverse().map((row) => ({
        date: row.trade_date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      })),
    });
  }

  return { tickers };
}

function getNewsData(symbols: string[]): NewsData {
  const rows = db
    .prepare(
      `
        SELECT id, published_at, category, stance, title, summary, source, url, impact, symbols_json
        FROM news_articles
        ORDER BY published_at ASC
      `,
    )
    .all() as NewsRow[];

  const events = rows
    .map((row) => ({
      id: row.id,
      date: row.published_at,
      category: row.category as StoredNewsEvent["category"],
      stance: row.stance as StoredNewsEvent["stance"],
      title: row.title,
      summary: row.summary,
      source: row.source,
      url: row.url,
      impact: row.impact,
      tickers: JSON.parse(row.symbols_json) as string[],
    }))
    .filter((event) => event.tickers.some((symbol) => symbols.includes(symbol)));

  return { events };
}

function getProviderStatus(): ProviderStatus {
  const totalPricePoints = (db.prepare("SELECT COUNT(*) AS count FROM price_history").get() as { count: number }).count;
  const totalNewsArticles = (db.prepare("SELECT COUNT(*) AS count FROM news_articles").get() as { count: number }).count;
  const lastRun = db
    .prepare("SELECT completed_at FROM ingest_runs ORDER BY completed_at DESC LIMIT 1")
    .get() as { completed_at?: string } | undefined;
  const liveRows = (
    db.prepare("SELECT COUNT(*) AS count FROM price_history WHERE source != 'sample'").get() as { count: number }
  ).count;

  return {
    providerId: marketDataProvider.id,
    providerLabel: marketDataProvider.label,
    providerConfigured: marketDataProvider.isConfigured(),
    dbPath: DB_PATH,
    lastIngestedAt: lastRun?.completed_at ?? null,
    totalPricePoints,
    totalNewsArticles,
    seededFromSample: liveRows === 0,
  };
}

function getBootstrapResponse(symbols: string[]): BootstrapResponse {
  return {
    marketData: getMarketData(symbols),
    newsData: getNewsData(symbols),
    provider: getProviderStatus(),
  };
}

function sendText(res: ServerResponse<IncomingMessage>, statusCode: number, message: string): void {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function sendJson(res: ServerResponse<IncomingMessage>, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendFile(filePath: string, res: ServerResponse<IncomingMessage>): void {
  readFile(filePath, (error, data) => {
    if (error) {
      const isMissing = error.code === "ENOENT";
      sendText(res, isMissing ? 404 : 500, isMissing ? "Not found" : "Server error");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] ?? "application/octet-stream",
    });
    res.end(data);
  });
}

function getSafeFilePath(baseDir: string, urlPath: string | undefined): string {
  const requestPath = urlPath === "/" || !urlPath ? "/index.html" : urlPath;
  const normalizedPath = path.normalize(requestPath).replace(/^[/\\]+/, "");
  const safePath = normalizedPath.replace(/^(\.\.[/\\])+/, "");
  return path.join(baseDir, safePath);
}

function recordIngestRun(provider: string, symbols: string[], status: string, notes: string): void {
  db.prepare(
    `
      INSERT INTO ingest_runs (provider, symbols_json, completed_at, status, notes)
      VALUES (?, ?, ?, ?, ?)
    `,
  ).run(provider, JSON.stringify(symbols), new Date().toISOString(), status, notes);
}

async function ingestFromProvider(symbols: string[]): Promise<IngestResponse> {
  const result = await marketDataProvider.fetch(symbols);

  for (const ticker of result.tickers) {
    upsertTicker(ticker.symbol, ticker.name);
    upsertPriceHistory(ticker.symbol, ticker.prices, result.providerId);
  }

  if (result.news.length > 0) {
    upsertNewsEvents(result.news, result.providerId);
  }

  recordIngestRun(
    result.providerId,
    symbols,
    result.warnings.length > 0 ? "partial" : "success",
    result.warnings.join(" | "),
  );

  return {
    ...getBootstrapResponse(symbols),
    ingestedSymbols: symbols,
    warnings: result.warnings,
  };
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

function routeApi(req: IncomingMessage, res: ServerResponse<IncomingMessage>, url: URL): Promise<void> | void {
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    sendJson(res, 200, getBootstrapResponse(getRequestedSymbols(url)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/market-data") {
    sendJson(res, 200, getMarketData(getRequestedSymbols(url)));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/news-data") {
    sendJson(res, 200, getNewsData(getRequestedSymbols(url)));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ingest") {
    return readJsonBody<IngestRequest>(req)
      .then((body) => ingestFromProvider((body.symbols ?? DEFAULT_SYMBOLS).map((symbol) => symbol.toUpperCase())))
      .then((payload) => sendJson(res, 200, payload))
      .catch((error: unknown) => {
        sendJson(res, 400, {
          error: error instanceof Error ? error.message : "Unknown ingest error",
        });
      });
  }

  sendJson(res, 404, { error: "API route not found" });
}

http
  .createServer((req: IncomingMessage, res: ServerResponse<IncomingMessage>) => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

    if (url.pathname.startsWith("/api/")) {
      void routeApi(req, res, url);
      return;
    }

    const filePath = getSafeFilePath(CLIENT_DIST_DIR, url.pathname);
    if (!filePath.startsWith(CLIENT_DIST_DIR)) {
      sendText(res, 403, "Forbidden");
      return;
    }

    if (existsSync(filePath) && !filePath.endsWith(path.sep)) {
      sendFile(filePath, res);
      return;
    }

    const indexFilePath = path.join(CLIENT_DIST_DIR, "index.html");
    if (existsSync(indexFilePath)) {
      sendFile(indexFilePath, res);
      return;
    }

    sendText(res, 404, "Frontend build not found. Run `npm run build` or `npm run dev`.");
  })
  .listen(PORT, HOST, () => {
    console.log(`TACO Trader is running at http://${HOST}:${PORT}`);
    console.log(`SQLite database: ${DB_PATH}`);
    console.log(`Market data provider: ${marketDataProvider.label}`);
  });
