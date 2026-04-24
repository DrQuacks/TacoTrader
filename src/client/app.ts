import * as THREE from "three";
import type {
  BootstrapResponse,
  EventCategory,
  EventStance,
  IngestResponse,
  MarketData,
  NewsData,
  NewsEvent,
  PricePoint,
  ProviderStatus,
  TickerData,
} from "../shared/types";

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
  provider: ProviderStatus | null;
  threshold: number;
  requireReversal: boolean;
  selectedSymbol: string | null;
}

interface DomElements {
  threshold: HTMLInputElement;
  thresholdValue: HTMLElement;
  requireReversal: HTMLInputElement;
  reloadDatabase: HTMLButtonElement;
  syncButton: HTMLButtonElement;
  symbolInput: HTMLInputElement;
  tickerSelect: HTMLSelectElement;
  providerStatus: HTMLElement;
  ingestStatus: HTMLElement;
  summaryCards: HTMLElement;
  signals: HTMLElement;
  eventFeed: HTMLElement;
  visualizationMount: HTMLElement;
  visualizationMeta: HTMLElement;
}

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

const state: AppState = {
  marketData: null,
  newsData: null,
  provider: null,
  threshold: 58,
  requireReversal: true,
  selectedSymbol: null,
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
  reloadDatabase: getElementByIdOrThrow<HTMLButtonElement>("reload-database"),
  syncButton: getElementByIdOrThrow<HTMLButtonElement>("sync-live-data"),
  symbolInput: getElementByIdOrThrow<HTMLInputElement>("symbol-input"),
  tickerSelect: getElementByIdOrThrow<HTMLSelectElement>("ticker-select"),
  providerStatus: getElementByIdOrThrow<HTMLElement>("provider-status"),
  ingestStatus: getElementByIdOrThrow<HTMLElement>("ingest-status"),
  summaryCards: getElementByIdOrThrow<HTMLElement>("summary-cards"),
  signals: getElementByIdOrThrow<HTMLElement>("signals"),
  eventFeed: getElementByIdOrThrow<HTMLElement>("event-feed"),
  visualizationMount: getElementByIdOrThrow<HTMLElement>("visualization-mount"),
  visualizationMeta: getElementByIdOrThrow<HTMLElement>("visualization-meta"),
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

async function loadJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json()) as T | { error?: string };

  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload ? payload.error : "Request failed";
    throw new Error(message || "Request failed");
  }

  return payload as T;
}

function getRequestedSymbols(): string[] {
  return dom.symbolInput.value
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
}

async function loadBootstrap(): Promise<void> {
  const symbols = getRequestedSymbols();
  const params = new URLSearchParams();
  if (symbols.length > 0) {
    params.set("symbols", symbols.join(","));
  }

  const query = params.toString();
  const payload = await loadJson<BootstrapResponse>(`/api/bootstrap${query ? `?${query}` : ""}`);
  applyBootstrap(payload);
  dom.ingestStatus.textContent = "Loaded from the local SQLite database.";
}

async function syncLiveData(): Promise<void> {
  const symbols = getRequestedSymbols();
  if (symbols.length === 0) {
    dom.ingestStatus.textContent = "Enter at least one symbol before syncing live data.";
    return;
  }

  dom.ingestStatus.textContent = "Syncing live Alpha Vantage data into SQLite...";

  try {
    const payload = await loadJson<IngestResponse>("/api/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ symbols }),
    });

    applyBootstrap(payload);
    dom.ingestStatus.textContent =
      payload.warnings.length > 0
        ? `Sync finished with warnings: ${payload.warnings.join(" | ")}`
        : `Live sync finished for ${payload.ingestedSymbols.join(", ")}.`;
  } catch (error: unknown) {
    dom.ingestStatus.textContent = getErrorMessage(error);
  }
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

      const baseScore =
        drawdown * 7.5 +
        bounce * 3.8 +
        eventWeight * 22 +
        (baselineMove < 0 ? 8 : 2) +
        (stanceWeight < 0 ? 10 : 0) +
        (laterReversal ? 16 : -12);

      const score = Math.max(0, Math.min(100, Math.round(baseScore)));
      const thesis = laterReversal
        ? `${event.title} created a ${drawdown.toFixed(1)}% dip, and later coverage suggests a walk back or softened stance.`
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

function buildSummary(signals: Signal[], events: NewsEvent[], provider: ProviderStatus): SummaryCard[] {
  const qualified = signals.filter((signal) => signal.score >= state.threshold);
  const reversalBacked = qualified.filter((signal) => signal.laterReversal).length;
  const averageDrawdown =
    qualified.reduce((sum, signal) => sum + signal.drawdown, 0) / (qualified.length || 1);

  return [
    {
      label: "Qualified setups",
      value: qualified.length,
      note: "Tickers above your signal threshold",
    },
    {
      label: "Reversal-backed",
      value: reversalBacked,
      note: "Setups backed by softer follow-on coverage",
    },
    {
      label: "SQLite rows",
      value: provider.totalPricePoints,
      note: "Stored daily price points",
    },
    {
      label: "Tape regime",
      value: classifyEnvironment(events),
      note: "Recent Trump headline balance",
    },
    {
      label: "Average dip",
      value: `${averageDrawdown.toFixed(1)}%`,
      note: "Typical drawdown among qualified setups",
    },
    {
      label: "News articles",
      value: provider.totalNewsArticles,
      note: "Political market articles stored locally",
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
      const sourceMarkup = event.url
        ? `<a href="${event.url}" target="_blank" rel="noreferrer">${event.source ?? "source"}</a>`
        : (event.source ?? "source");

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
          <div class="meta meta--link">${sourceMarkup}</div>
        </article>
      `;
    })
    .join("");
}

class MarketScene {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(46, 1, 0.1, 1000);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  private readonly root = new THREE.Group();
  private frameId = 0;

  constructor(private readonly mount: HTMLElement) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.mount.appendChild(this.renderer.domElement);

    this.camera.position.set(0, 8, 20);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.2));

    const directional = new THREE.DirectionalLight(0xfff0d7, 1.6);
    directional.position.set(6, 12, 8);
    this.scene.add(directional);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(10, 64),
      new THREE.MeshStandardMaterial({ color: 0xf0dfca, transparent: true, opacity: 0.45 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.2;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(18, 18, 0xcf5c36, 0xd9bba2);
    grid.position.y = -2.18;
    this.scene.add(grid);

    this.scene.add(this.root);
    window.addEventListener("resize", () => this.resize());
    this.resize();
    this.animate();
  }

  renderTicker(ticker: TickerData | null): void {
    this.root.clear();

    if (!ticker || ticker.prices.length === 0) {
      return;
    }

    const closes = ticker.prices.map((price) => price.close);
    const minClose = Math.min(...closes);
    const maxClose = Math.max(...closes);
    const spread = Math.max(1, maxClose - minClose);
    const barGeometry = new THREE.BoxGeometry(0.34, 1, 0.34);
    const linePoints: THREE.Vector3[] = [];

    ticker.prices.forEach((price, index) => {
      const normalized = (price.close - minClose) / spread;
      const height = 1.2 + normalized * 7.4;
      const previous = ticker.prices[index - 1]?.close ?? price.close;
      const positive = price.close >= previous;
      const material = new THREE.MeshStandardMaterial({
        color: positive ? 0x356859 : 0xcf5c36,
        emissive: positive ? 0x123127 : 0x552012,
        roughness: 0.3,
        metalness: 0.1,
      });

      const bar = new THREE.Mesh(barGeometry, material);
      bar.scale.y = height;
      bar.position.set(index * 0.52 - ticker.prices.length * 0.26, height / 2 - 2, 0);
      this.root.add(bar);
      linePoints.push(new THREE.Vector3(bar.position.x, height - 2, 0.42));
    });

    if (linePoints.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(linePoints);
      const curveGeometry = new THREE.TubeGeometry(curve, 80, 0.06, 10, false);
      const curveMaterial = new THREE.MeshStandardMaterial({ color: 0x1f7a8c, emissive: 0x0a2d33 });
      this.root.add(new THREE.Mesh(curveGeometry, curveMaterial));
    }
  }

  private resize(): void {
    const width = Math.max(this.mount.clientWidth, 280);
    const height = Math.max(this.mount.clientHeight, 320);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private animate = (): void => {
    this.frameId = window.requestAnimationFrame(this.animate);
    this.root.rotation.y += 0.004;
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    window.cancelAnimationFrame(this.frameId);
    this.renderer.dispose();
  }
}

const marketScene = new MarketScene(dom.visualizationMount);

function populateTickerSelect(): void {
  const tickers = state.marketData?.tickers ?? [];
  dom.tickerSelect.innerHTML = tickers
    .map((ticker) => `<option value="${ticker.symbol}">${ticker.symbol} · ${ticker.name}</option>`)
    .join("");

  if (!state.selectedSymbol && tickers.length > 0) {
    state.selectedSymbol = tickers[0].symbol;
  }

  if (state.selectedSymbol) {
    dom.tickerSelect.value = state.selectedSymbol;
  }
}

function renderVisualization(): void {
  const ticker = state.marketData?.tickers.find((item) => item.symbol === state.selectedSymbol) ?? null;
  marketScene.renderTicker(ticker);

  if (!ticker || ticker.prices.length === 0) {
    dom.visualizationMeta.innerHTML = `<p class="meta">No database price history is available for the selected symbol.</p>`;
    return;
  }

  const first = ticker.prices[0];
  const last = ticker.prices[ticker.prices.length - 1];
  const move = pctMove(first.close, last.close);

  dom.visualizationMeta.innerHTML = `
    <div class="visualization-stats">
      <span class="pill">${ticker.symbol}</span>
      <span class="pill">${ticker.prices.length} sessions</span>
      <span class="pill">${first.date} to ${last.date}</span>
      <span class="pill ${move >= 0 ? "pill--good" : "pill--warn"}">${move >= 0 ? "+" : ""}${move.toFixed(1)}%</span>
    </div>
    <p class="meta">Three.js renders each session as a 3D bar while the teal ribbon follows the close through time.</p>
  `;
}

function renderProviderStatus(provider: ProviderStatus): void {
  const sourceLabel = provider.hasAlphaVantage ? "Alpha Vantage ready" : "Sample-only mode";
  const seedLabel = provider.seededFromSample
    ? "Seeded from bundled sample data"
    : "Contains live ingested market data";
  const lastIngested = provider.lastIngestedAt ? new Date(provider.lastIngestedAt).toLocaleString() : "No live ingest yet";

  dom.providerStatus.innerHTML = `
    <div class="signal-card provider-card">
      <div class="signal-card__facts">
        <span class="pill pill--cool">${sourceLabel}</span>
        <span class="pill">${seedLabel}</span>
      </div>
      <p class="meta">Database: ${provider.dbPath}</p>
      <p class="meta">Last ingest: ${lastIngested}</p>
    </div>
  `;
}

function render(): void {
  if (!state.marketData || !state.newsData || !state.provider) {
    return;
  }

  const events = sortByDate(state.newsData.events);
  const signals = buildSignals(state.marketData, state.newsData);
  const summary = buildSummary(signals, events, state.provider);

  populateTickerSelect();
  renderProviderStatus(state.provider);
  renderSummary(summary);
  renderSignals(signals);
  renderEvents(events);
  renderVisualization();
}

function applyBootstrap(payload: BootstrapResponse): void {
  state.marketData = payload.marketData;
  state.newsData = payload.newsData;
  state.provider = payload.provider;

  const availableSymbols = payload.marketData.tickers.map((ticker) => ticker.symbol);
  if (!state.selectedSymbol || !availableSymbols.includes(state.selectedSymbol)) {
    state.selectedSymbol = availableSymbols[0] ?? null;
  }

  render();
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

dom.reloadDatabase.addEventListener("click", () => {
  void loadBootstrap().catch((error: unknown) => {
    dom.ingestStatus.textContent = getErrorMessage(error);
  });
});

dom.syncButton.addEventListener("click", () => {
  void syncLiveData();
});

dom.tickerSelect.addEventListener("change", (event) => {
  state.selectedSymbol = (event.target as HTMLSelectElement).value;
  renderVisualization();
});

void loadBootstrap().catch((error: unknown) => {
  dom.ingestStatus.textContent = getErrorMessage(error);
});
