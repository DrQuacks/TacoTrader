const state = {
  marketData: null,
  newsData: null,
  threshold: 58,
  requireReversal: true,
};

const dom = {
  threshold: document.getElementById("score-threshold"),
  thresholdValue: document.getElementById("score-threshold-value"),
  requireReversal: document.getElementById("require-reversal"),
  reloadSample: document.getElementById("reload-sample"),
  marketUpload: document.getElementById("market-upload"),
  newsUpload: document.getElementById("news-upload"),
  summaryCards: document.getElementById("summary-cards"),
  signals: document.getElementById("signals"),
  eventFeed: document.getElementById("event-feed"),
};

const CATEGORY_WEIGHTS = {
  tariffs: 1.05,
  war: 1.08,
  sanctions: 0.96,
  regulation: 0.88,
  diplomacy: 0.82,
};

const STANCE_WEIGHTS = {
  escalation: -1,
  pressure: -0.7,
  uncertainty: -0.35,
  reversal: 1,
  delay: 0.88,
  carveout: 0.72,
  denial: 0.58,
};

function pctMove(previous, current) {
  if (!previous || previous === 0) {
    return 0;
  }
  return ((current - previous) / previous) * 100;
}

function parseJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(reader.result));
      } catch (error) {
        reject(new Error(`Could not parse ${file.name}: ${error.message}`));
      }
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}

async function loadSampleData() {
  const [marketData, newsData] = await Promise.all([
    fetch("/data/market-data.json").then((res) => res.json()),
    fetch("/data/news-data.json").then((res) => res.json()),
  ]);

  state.marketData = marketData;
  state.newsData = newsData;
  render();
}

function sortByDate(items, key = "date") {
  return [...items].sort((a, b) => new Date(a[key]) - new Date(b[key]));
}

function getTickerMap(marketData) {
  return new Map((marketData?.tickers || []).map((ticker) => [ticker.symbol, ticker]));
}

function getPriceOnOrBefore(prices, targetDate) {
  const target = new Date(targetDate).getTime();
  let candidate = null;

  for (const price of prices) {
    if (new Date(price.date).getTime() <= target) {
      candidate = price;
    }
  }

  return candidate;
}

function getWindowPrices(prices, targetDate, lookaheadDays = 5) {
  const start = new Date(targetDate).getTime();
  const end = start + lookaheadDays * 24 * 60 * 60 * 1000;
  return prices.filter((price) => {
    const time = new Date(price.date).getTime();
    return time >= start && time <= end;
  });
}

function classifyEnvironment(events) {
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

function buildSignals(marketData, newsData) {
  const tickerMap = getTickerMap(marketData);
  const events = sortByDate(newsData?.events || []);
  const tickerSignals = [];

  for (const ticker of marketData?.tickers || []) {
    const prices = sortByDate(ticker.prices || []);
    if (prices.length < 3) {
      continue;
    }

    const relevantEvents = events.filter((event) => (event.tickers || []).includes(ticker.symbol));
    if (relevantEvents.length === 0) {
      continue;
    }

    const latestPrice = prices[prices.length - 1];
    const startPrice = prices[0];
    const baselineMove = pctMove(startPrice.close, latestPrice.close);
    let bestSignal = null;

    for (const event of relevantEvents) {
      const anchorPrice = getPriceOnOrBefore(prices, event.date);
      if (!anchorPrice) {
        continue;
      }

      const windowPrices = getWindowPrices(prices, event.date);
      const lowPrice = windowPrices.reduce((lowest, price) => {
        if (!lowest || price.close < lowest.close) {
          return price;
        }
        return lowest;
      }, null);
      const bouncePrice = windowPrices[windowPrices.length - 1] || latestPrice;

      if (!lowPrice) {
        continue;
      }

      const drawdown = Math.abs(Math.min(0, pctMove(anchorPrice.close, lowPrice.close)));
      const bounce = Math.max(0, pctMove(lowPrice.close, bouncePrice.close));
      const eventWeight = (CATEGORY_WEIGHTS[event.category] || 0.75) * (event.impact || 0.5);
      const stanceWeight = STANCE_WEIGHTS[event.stance] || 0;

      const laterReversal = relevantEvents.find((candidate) => {
        return (
          new Date(candidate.date) > new Date(event.date) &&
          STANCE_WEIGHTS[candidate.stance] > 0
        );
      });

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

      const candidateSignal = {
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

function buildSummary(signals, events) {
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

function renderSummary(cards) {
  dom.summaryCards.innerHTML = cards
    .map(
      (card) => `
        <article class="summary-card">
          <strong>${card.label}</strong>
          <div class="summary-card__value">${card.value}</div>
          <div class="meta">${card.note}</div>
        </article>
      `
    )
    .join("");
}

function renderSignals(signals) {
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
      `
    )
    .join("");
}

function renderEvents(events) {
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
            <span class="pill">Impact ${Math.round((event.impact || 0) * 100)}</span>
            <span class="pill">${(event.tickers || []).join(", ")}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function render() {
  if (!state.marketData || !state.newsData) {
    return;
  }

  const events = sortByDate(state.newsData.events || []);
  const signals = buildSignals(state.marketData, state.newsData);
  const summary = buildSummary(signals, events);

  renderSummary(summary);
  renderSignals(signals);
  renderEvents(events);
}

dom.threshold.addEventListener("input", (event) => {
  state.threshold = Number(event.target.value);
  dom.thresholdValue.textContent = String(state.threshold);
  render();
});

dom.requireReversal.addEventListener("change", (event) => {
  state.requireReversal = event.target.checked;
  render();
});

dom.reloadSample.addEventListener("click", () => {
  loadSampleData().catch(showError);
});

dom.marketUpload.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  try {
    state.marketData = await parseJsonFile(file);
    render();
  } catch (error) {
    showError(error);
  }
});

dom.newsUpload.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  try {
    state.newsData = await parseJsonFile(file);
    render();
  } catch (error) {
    showError(error);
  }
});

function showError(error) {
  dom.signals.innerHTML = `
    <article class="signal-card">
      <h3>Data error</h3>
      <p>${error.message}</p>
    </article>
  `;
}

loadSampleData().catch(showError);
