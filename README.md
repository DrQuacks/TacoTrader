# TACO Trader

TACO Trader is a local TypeScript web app that scores buy-the-dip opportunities around Trump-driven market shocks and reversals under a Trump Always Chickens Out thesis.

## What it does

- Loads and stores stock price series in SQLite.
- Seeds the database from bundled sample market and news data so the app works immediately.
- Syncs live prices and political market articles from Alpha Vantage when `ALPHA_VANTAGE_API_KEY` is set.
- Scores rebound setups based on drop severity, volatility, sentiment reversal, and evidence of walk backs or softened policy.
- Renders a Three.js visualization where each session becomes a 3D bar and the close path becomes a ribbon.

## Run locally

```bash
npm install
npm start
```

Then open [http://127.0.0.1:3000](http://127.0.0.1:3000).

## Live ingest

Set an Alpha Vantage key before using the `Sync live data` button:

```bash
export ALPHA_VANTAGE_API_KEY='your-key-here'
npm start
```

The app will keep data in `data/taco-trader.db`.

## TypeScript layout

- Server source: `src/server.ts`
- Client source: `src/client/app.ts`
- Shared types: `src/shared/types.ts`
- Build output: `dist/server.js` and `public/client/app.js`

## Notes

- This is a research toy, not financial advice.
- The bundled sample data still powers the app even before a live API key is configured.
- Three.js is used for the visualization layer, while SQLite is the local system of record.
