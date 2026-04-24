export type EventCategory = "tariffs" | "war" | "sanctions" | "regulation" | "diplomacy";

export type EventStance =
  | "escalation"
  | "pressure"
  | "uncertainty"
  | "reversal"
  | "delay"
  | "carveout"
  | "denial";

export interface PricePoint {
  date: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
}

export interface TickerData {
  symbol: string;
  name: string;
  prices: PricePoint[];
}

export interface MarketData {
  tickers: TickerData[];
}

export interface NewsEvent {
  id: string;
  date: string;
  category: EventCategory;
  stance: EventStance;
  title: string;
  impact: number;
  tickers: string[];
  summary: string;
  source?: string;
  url?: string;
}

export interface NewsData {
  events: NewsEvent[];
}

export interface ProviderStatus {
  hasAlphaVantage: boolean;
  dbPath: string;
  lastIngestedAt: string | null;
  totalPricePoints: number;
  totalNewsArticles: number;
  seededFromSample: boolean;
}

export interface BootstrapResponse {
  marketData: MarketData;
  newsData: NewsData;
  provider: ProviderStatus;
}

export interface IngestRequest {
  symbols: string[];
}

export interface IngestResponse extends BootstrapResponse {
  ingestedSymbols: string[];
  warnings: string[];
}
