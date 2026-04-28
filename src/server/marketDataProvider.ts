import { spawn } from "node:child_process";
import { EventCategory, EventStance, NewsEvent, PricePoint } from "../shared/types";

export interface StoredPricePoint extends PricePoint {
  open: number;
  high: number;
  low: number;
  volume: number;
}

export interface StoredNewsEvent extends NewsEvent {
  source: string;
  url: string;
}

export interface ProviderTickerData {
  symbol: string;
  name: string;
  prices: StoredPricePoint[];
}

export interface ProviderFetchResult {
  providerId: string;
  providerLabel: string;
  tickers: ProviderTickerData[];
  news: StoredNewsEvent[];
  warnings: string[];
}

export interface MarketDataProvider {
  readonly id: string;
  readonly label: string;
  isConfigured(): boolean;
  fetch(symbols: string[]): Promise<ProviderFetchResult>;
}

interface YFinanceScriptResult {
  tickers: Array<{
    symbol: string;
    name: string;
    prices: StoredPricePoint[];
  }>;
  news: Array<{
    id: string;
    date: string;
    title: string;
    summary: string;
    source: string;
    url: string;
    tickers: string[];
  }>;
  warnings?: string[];
}

function isPoliticalMarketArticle(text: string): boolean {
  const lower = text.toLowerCase();
  const keywords = [
    "trump",
    "white house",
    "tariff",
    "trade",
    "iran",
    "sanction",
    "administration",
    "war",
    "military",
    "diplomacy",
    "export control",
  ];

  return keywords.some((keyword) => lower.includes(keyword));
}

function deriveCategory(text: string): EventCategory {
  const lower = text.toLowerCase();
  if (lower.includes("tariff") || lower.includes("trade") || lower.includes("import")) {
    return "tariffs";
  }
  if (lower.includes("iran") || lower.includes("war") || lower.includes("strike") || lower.includes("military")) {
    return "war";
  }
  if (lower.includes("sanction")) {
    return "sanctions";
  }
  if (lower.includes("rule") || lower.includes("regulation") || lower.includes("ban") || lower.includes("control")) {
    return "regulation";
  }
  return "diplomacy";
}

function deriveStance(text: string): EventStance {
  const lower = text.toLowerCase();
  if (lower.includes("delay") || lower.includes("postpone") || lower.includes("pause")) {
    return "delay";
  }
  if (lower.includes("exempt") || lower.includes("carve-out") || lower.includes("carve out")) {
    return "carveout";
  }
  if (lower.includes("deny") || lower.includes("no immediate") || lower.includes("not planning")) {
    return "denial";
  }
  if (lower.includes("reverse") || lower.includes("walk back") || lower.includes("soften")) {
    return "reversal";
  }
  if (lower.includes("threat") || lower.includes("strike") || lower.includes("retaliat") || lower.includes("tariff")) {
    return "escalation";
  }
  if (lower.includes("pressure") || lower.includes("urge")) {
    return "pressure";
  }
  return "uncertainty";
}

function deriveImpact(text: string): number {
  const lower = text.toLowerCase();
  let impact = 0.58;

  if (lower.includes("tariff") || lower.includes("iran") || lower.includes("war")) {
    impact += 0.14;
  }
  if (lower.includes("market") || lower.includes("stocks") || lower.includes("investor")) {
    impact += 0.08;
  }

  return Math.min(0.98, Number(impact.toFixed(2)));
}

class YFinanceProvider implements MarketDataProvider {
  readonly id = "yfinance";
  readonly label = "Yahoo Finance via yfinance";

  constructor(private readonly rootDir: string) {}

  isConfigured(): boolean {
    return true;
  }

  async fetch(symbols: string[]): Promise<ProviderFetchResult> {
    const scriptPath = "scripts/fetch_yfinance.py";
    const raw = await runUvPython(this.rootDir, scriptPath, symbols);
    const result = JSON.parse(raw) as YFinanceScriptResult;

    const filteredNews = result.news
      .map((item) => {
        const body = `${item.title} ${item.summary}`.trim();
        if (!item.url || !item.title || !isPoliticalMarketArticle(body)) {
          return null;
        }

        return {
          id: item.id || item.url,
          date: item.date,
          title: item.title,
          summary: item.summary || "Yahoo Finance article relevant to the current TACO thesis.",
          source: item.source || "Yahoo Finance",
          url: item.url,
          impact: deriveImpact(body),
          category: deriveCategory(body),
          stance: deriveStance(body),
          tickers: item.tickers.length > 0 ? item.tickers : symbols,
        } satisfies StoredNewsEvent;
      })
      .filter((item): item is StoredNewsEvent => item !== null);

    return {
      providerId: this.id,
      providerLabel: this.label,
      tickers: result.tickers,
      news: filteredNews,
      warnings: result.warnings ?? [],
    };
  }
}

function runUvPython(rootDir: string, scriptPath: string, symbols: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("uv", ["run", "python", scriptPath, ...symbols], {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yfinance provider exited with code ${code}`));
        return;
      }

      resolve(stdout);
    });
  });
}

export function createMarketDataProvider(rootDir: string): MarketDataProvider {
  const providerId = (process.env.MARKET_DATA_PROVIDER ?? "yfinance").toLowerCase();

  switch (providerId) {
    case "yfinance":
      return new YFinanceProvider(rootDir);
    default:
      throw new Error(`Unsupported market data provider: ${providerId}`);
  }
}
