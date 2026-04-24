type EventCategory = "tariffs" | "war" | "sanctions" | "regulation" | "diplomacy";
type EventStance =
  | "escalation"
  | "pressure"
  | "uncertainty"
  | "reversal"
  | "delay"
  | "carveout"
  | "denial";

interface PricePoint {
  date: string;
  close: number;
}

interface TickerData {
  symbol: string;
  name: string;
  prices: PricePoint[];
}

interface MarketData {
  tickers: TickerData[];
}

interface NewsEvent {
  id: string;
  date: string;
  category: EventCategory;
  stance: EventStance;
  title: string;
  impact: number;
  tickers: string[];
  summary: string;
}

interface NewsData {
  events: NewsEvent[];
}

interface Signal {
  symbol: string;
  company: string;
  score: number;
  drawdown: number;
  bounce: number;
  baselineMove: number;
  event: NewsEvent;
  laterReversal?: NewsEvent;
  latestPrice: number;
  thesis: string;
  direction: "rebound setup" | "watchlist only";
}

interface SummaryCard {
  label: string;
  value: number | string;
  note: string;
}

interface AppState {
  marketData: MarketData | null;
  newsData: NewsData | null;
  threshold: number;
  requireReversal: boolean;
}

interface DomElements {
  threshold: HTMLInputElement;
  thresholdValue: HTMLElement;
  requireReversal: HTMLInputElement;
  reloadSample: HTMLButtonElement;
  marketUpload: HTMLInputElement;
  newsUpload: HTMLInputElement;
  summaryCards: HTMLElement;
  signals: HTMLElement;
  eventFeed: HTMLElement;
}

const state: AppState = {
  marketData: null,
  newsData: null,
  threshold: 58,
  requireReversal: true,
};

function getElementByIdOrThrow<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Expected #${id} to exist`);
  }

  return element as T;
}

const dom: DomElements = {
  threshold: getElementByIdOrThrow<HTMLInputElement>("score-threshold"),
  thresholdValue: getElementByIdOrThrow<HTMLElement>("score-threshold-value"),
  requireReversal: getElementByIdOrThrow<HTMLInputElement>("require-reversal"),
  reloadSample: getElementByIdOrThrow<HTMLButtonElement>("reload-sample"),
  marketUpload: getElementByIdOrThrow<HTMLInputElement>("market-upload"),
  newsUpload: getElementByIdOrThrow<HTMLInputElement>("news-upload"),
  summaryCards: getElementByIdOrThrow<HTMLElement>("summary-cards"),
  signals: getElementByIdOrThrow<HTMLElement>("signals"),
  eventFeed: getElementByIdOrThrow<HTMLElement>("event-feed"),
};

const CATEGORY_WEIGHTS: Record<EventCategory, number> = {
  tariffs: 1.05,
  war: 1.08,
  sanctions: 0.96,
  regulation: 0.88,
  diplomacy: 0.82,
};

const STANCE_WEIGHTS: Record<EventStance, number> = {
  escalation: -1,
  pressure: -0.7,
  uncertainty: -0.35,
  reversal: 1,
  delay: 0.88,
  carveout: 0.72,
  denial: 0.58,
};

function pctMove(previous: number, current: number): number {
  if (!previous) {
    return 0;
  }

  return ((current - previous) / previous) * 100;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}

function parseJsonFile<T>(file: File): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      try {
        const text = typeof reader.result === "string" ? reader.result : "";
        resolve(JSON.parse(text) as T);
      } catch (error: unknown) {
        reject(new Error(`Could not parse ${file.name}: ${getErrorMessage(error)}`));
      }
    };

    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}

async function loadJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }

  return (await response.json()) as T;
}

async function loadSampleData(): Promise<void> {
  const [marketData, newsData] = await Promise.all([
    loadJson<MarketData>("/data/market-data.json"),
    loadJson<NewsData>("/data/news-data.json"),
  ]);

  state.marketData = marketData;
  state.newsData = newsData;
  render();
}

function sortByDate<T extends { date: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

function getPriceOnOrBefore(prices: PricePoint[], targetDate: string): PricePoint | null {
  const target = new Date(targetDate).getTime();
  let candidate: PricePoint | null = null;

  for (const price of prices) {
    if (new Date(price.date).getTime() <= target) {
      candidate = price;
    }
  }

  return candidate;
}

function getWindowPrices(prices: PricePoint[], targetDate: string, lookaheadDays = 5): PricePoint[] {
  const start = new Date(targetDate).getTime();
  const end = start + lookaheadDays * 24 * 60 * 60 * 1000;

  return prices.filter((price) => {
    const time = new Date(price.date).getTime();
    return time >= start && time <= end;
  });
}

function classifyEnvironment(events: NewsEvent[]): string {
  const latest = events.slice(-8);
  const escalationCount = latest.filter((event) => STANCE_WEIGHTS[event.stance] < 0).length;
  const reversalCount = latest.filter((event) => STANCE_WEIGHTS[event.stance] > 0).length;

  if (reversalCount > escalationCount) {
    return "Reversal-friendly";
  }

  if (escalationCount > reversalCount + 1) {
    return "Headline-dangerous";
  }

  return "Choppy";
}

function buildSignals(marketData: MarketData, newsData: NewsData): Signal[] {
  const events = sortByDate(newsData.events);
  const tickerSignals: Signal[] = [];

  for (const ticker of marketData.tickers) {
    const prices = sortByDate(ticker.prices);
    if (prices.length < 3) {
      continue;
    }

    const relevantEvents = events.filter((event) => event.tickers.includes(ticker.symbol));
    if (relevantEvents.length === 0) {
      continue;
    }

    const latestPrice = prices[prices.length - 1];
    const startPrice = prices[0];
    const baselineMove = pctMove(startPrice.close, latestPrice.close);
    let bestSignal: Signal | null = null;

    for (const event of relevantEvents) {
      const anchorPrice = getPriceOnOrBefore(prices, event.date);
      if (!anchorPrice) {
        continue;
      }

      const windowPrices = getWindowPrices(prices, event.date);
      const lowPrice = windowPrices.reduce<PricePoint | null>((lowest, price) => {
        if (!lowest || price.close < lowest.close) {
          return price;
        }

        return lowest;
      }, null);
      const bouncePrice = windowPrices[windowPrices.length - 1] ?? latestPrice;

      if (!lowPrice) {
        continue;
      }

      const drawdown = Math.abs(Math.min(0, pctMove(anchorPrice.close, lowPrice.close)));
      const bounce = Math.max(0, pctMove(lowPrice.close, bouncePrice.close));
      const eventWeight = CATEGORY_WEIGHTS[event.category] * event.impact;
      const stanceWeight = STANCE_WEIGHTS[event.stance];

      const laterReversal = relevantEvents.find(
        (candidate) =>
          new Date(candidate.date).getTime() > new Date(event.date).getTime() &&
          STANCE_WEIGHTS[candidate.stance] > 0,
      );

      const reversalBoost = laterReversal ? 16 : 0;
      const ongoingEscalationPenalty = laterReversal ? 0 : 12;
      const baseScore =
        drawdown * 7.5 +
        bounce * 3.8 +
        eventWeight * 22 +
        (baselineMove < 0 ? 8 : 2) +
        (stanceWeight < 0 ? 10 : 0) +
        reversalBoost -
        ongoingEscalationPenalty;

      const score = Math.max(0, Math.min(100, Math.round(baseScore)));
      const thesis = laterReversal
        ? `${event.title} created a ${drawdown.toFixed(1)}% dip, and later coverage suggests a walk-back or softened stance.`
        : `${event.title} created a ${drawdown.toFixed(1)}% dip, but reversal evidence is still thin.`;

      const candidateSignal: Signal = {
        symbol: ticker.symbol,
        company: ticker.name,
        score,
        drawdown,
        bounce,
        baselineMove,
        event,
        laterReversal,
        latestPrice: latestPrice.close,
        thesis,
        direction: laterReversal ? "rebound setup" : "watchlist only",
      };

      if (!bestSignal || candidateSignal.score > bestSignal.score) {
        bestSignal = candidateSignal;
      }
    }

    if (bestSignal) {
      tickerSignals.push(bestSignal);
    }
  }

  return tickerSignals.sort((a, b) => b.score - a.score);
}

function buildSummary(signals: Signal[], events: NewsEvent[]): SummaryCard[] {
  const qualified = signals.filter((signal) => signal.score >= state.threshold);
  const reversalBacked = qualified.filter((signal) => signal.laterReversal).length;
  const averageDrawdown =
    qualified.reduce((sum, signal) => sum + signal.drawdown, 0) / (qualified.length || 1);
  const environment = classifyEnvironment(events);

  return [
    {
      label: "Qualified setups",
      value: qualified.length,
      note: "Tickers above your score threshold",
    },
    {
      label: "Reversal-backed",
      value: reversalBacked,
      note: "Signals with later softening headlines",
    },
    {
      label: "Average dip",
      value: `${averageDrawdown.toFixed(1)}%`,
      note: "Typical drawdown among qualified setups",
    },
    {
      label: "Tape regime",
      value: environment,
      note: "Recent Trump headline balance",
    },
  ];
}

function renderSummary(cards: SummaryCard[]): void {
  dom.summaryCards.innerHTML = cards
    .map(
      (card) => `
        <article class="summary-card">
          <strong>${card.label}</strong>
          <div class="summary-card__value">${card.value}</div>
          <div class="meta">${card.note}</div>
        </article>
      `,
    )
    .join("");
}

function renderSignals(signals: Signal[]): void {
  const visibleSignals = signals.filter((signal) => {
    if (signal.score < state.threshold) {
      return false;
    }

    if (state.requireReversal && !signal.laterReversal) {
      return false;
    }

    return true;
  });

  if (visibleSignals.length === 0) {
    dom.signals.innerHTML = `
      <article class="signal-card">
        <h3>No setups pass the current filters.</h3>
        <p>Try lowering the minimum score or allow unconfirmed reversal setups.</p>
      </article>
    `;
    return;
  }

  dom.signals.innerHTML = visibleSignals
    .map(
      (signal) => `
        <article class="signal-card">
          <div class="signal-card__top">
            <div>
              <h3>${signal.symbol} <span class="meta">${signal.company}</span></h3>
              <p>${signal.thesis}</p>
            </div>
            <div class="signal-card__score">
              <span>Signal</span>
              <strong>${signal.score}</strong>
            </div>
          </div>
          <div class="signal-card__facts">
            <span class="pill pill--warn">Dip ${signal.drawdown.toFixed(1)}%</span>
            <span class="pill pill--good">Bounce ${signal.bounce.toFixed(1)}%</span>
            <span class="pill pill--cool">Last ${signal.latestPrice.toFixed(2)}</span>
            <span class="pill">${signal.event.category}</span>
            <span class="pill">${signal.direction}</span>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderEvents(events: NewsEvent[]): void {
  dom.eventFeed.innerHTML = events
    .slice()
    .reverse()
    .map((event) => {
      const tone = STANCE_WEIGHTS[event.stance] > 0 ? "pill--good" : "pill--warn";
      return `
        <article class="event-card">
          <div class="event-card__top">
            <div>
              <h3>${event.title}</h3>
              <p>${event.summary}</p>
            </div>
            <span class="pill ${tone}">${event.stance}</span>
          </div>
          <div class="signal-card__facts">
            <span class="pill">${event.date}</span>
            <span class="pill">${event.category}</span>
            <span class="pill">Impact ${Math.round(event.impact * 100)}</span>
            <span class="pill">${event.tickers.join(", ")}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function render(): void {
  if (!state.marketData || !state.newsData) {
    return;
  }

  const events = sortByDate(state.newsData.events);
  const signals = buildSignals(state.marketData, state.newsData);
  const summary = buildSummary(signals, events);

  renderSummary(summary);
  renderSignals(signals);
  renderEvents(events);
}

dom.threshold.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement;
  state.threshold = Number(target.value);
  dom.thresholdValue.textContent = String(state.threshold);
  render();
});

dom.requireReversal.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement;
  state.requireReversal = target.checked;
  render();
});

dom.reloadSample.addEventListener("click", () => {
  void loadSampleData().catch(showError);
});

dom.marketUpload.addEventListener("change", async (event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) {
    return;
  }

  try {
    state.marketData = await parseJsonFile<MarketData>(file);
    render();
  } catch (error: unknown) {
    showError(error);
  }
});

dom.newsUpload.addEventListener("change", async (event) => {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) {
    return;
  }

  try {
    state.newsData = await parseJsonFile<NewsData>(file);
    render();
  } catch (error: unknown) {
    showError(error);
  }
});

function showError(error: unknown): void {
  dom.signals.innerHTML = `
    <article class="signal-card">
      <h3>Data error</h3>
      <p>${getErrorMessage(error)}</p>
    </article>
  `;
}

void loadSampleData().catch(showError);
