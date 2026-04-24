# TACO Trader

TACO Trader is a lightweight local web app that scores "buy the dip" opportunities around Trump-driven market shocks and reversals under a "Trump Always Chickens Out" thesis.

## What it does

- Loads stock price series and political/news events from JSON.
- Identifies policy shock dips tied to tariffs, war rhetoric, sanctions, and similar market-moving statements.
- Scores rebound setups based on drop severity, volatility, sentiment reversal, and evidence of walk-backs or softened policy.
- Ranks tickers by attractiveness and explains the thesis behind each signal.

## Run locally

```bash
npm start
```

Then open [http://localhost:3000](http://localhost:3000).

## Data shape

Market data lives in `public/data/market-data.json`:

```json
{
  "tickers": [
    {
      "symbol": "SPY",
      "prices": [
        { "date": "2026-04-13", "close": 508.2 }
      ]
    }
  ]
}
```

News data lives in `public/data/news-data.json`:

```json
{
  "events": [
    {
      "id": "evt-1",
      "date": "2026-04-16",
      "category": "tariffs",
      "stance": "escalation",
      "title": "Trump floats a new tariff threat",
      "impact": 0.8,
      "tickers": ["SPY", "QQQ", "AAPL"],
      "summary": "Markets sell off on fears of a renewed trade fight."
    }
  ]
}
```

## Notes

- This is a research toy, not financial advice.
- The included data is illustrative sample data so the app works immediately.
- The scoring model is intentionally transparent and easy to modify in `public/app.js`.
