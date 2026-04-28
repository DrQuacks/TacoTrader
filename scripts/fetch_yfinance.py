#!/usr/bin/env python3
import json
import sys
from datetime import UTC, datetime
from typing import Any

import yfinance as yf


def normalize_value(value: Any, fallback: float = 0.0) -> float:
    if value is None:
        return fallback
    try:
        if value != value:
            return fallback
    except Exception:
        return fallback
    return float(value)


def extract_prices(symbol: str) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    ticker = yf.Ticker(symbol)
    history = ticker.history(period="6mo", interval="1d", auto_adjust=False, actions=False)
    info = {}

    try:
        info = ticker.fast_info or {}
    except Exception as error:
        warnings.append(f"{symbol}: fast_info unavailable ({error})")

    if history is None or history.empty:
      warnings.append(f"{symbol}: no historical rows returned")
      return {"symbol": symbol, "name": symbol, "prices": []}, warnings

    prices: list[dict[str, Any]] = []
    for index, row in history.iterrows():
        date = index.strftime("%Y-%m-%d")
        close = normalize_value(row.get("Close"))
        prices.append(
            {
                "date": date,
                "open": normalize_value(row.get("Open"), close),
                "high": normalize_value(row.get("High"), close),
                "low": normalize_value(row.get("Low"), close),
                "close": close,
                "volume": normalize_value(row.get("Volume"), 0.0),
            }
        )

    name = symbol
    for key in ("shortName", "longName"):
        value = info.get(key)
        if value:
            name = str(value)
            break

    return {"symbol": symbol, "name": name, "prices": prices}, warnings


def extract_news(symbol: str) -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    ticker = yf.Ticker(symbol)

    try:
        raw_news = ticker.news or []
    except Exception as error:
        warnings.append(f"{symbol}: news unavailable ({error})")
        return [], warnings

    items: list[dict[str, Any]] = []
    for article in raw_news[:12]:
        link = article.get("link") or article.get("url")
        title = article.get("title") or ""
        summary = article.get("summary") or article.get("publisher") or ""
        provider_publish_time = article.get("providerPublishTime")
        publish_date = ""
        if provider_publish_time:
            try:
                publish_date = datetime.fromtimestamp(provider_publish_time, UTC).strftime("%Y-%m-%d")
            except Exception:
                publish_date = ""
        if not publish_date:
            publish_date = datetime.now(UTC).strftime("%Y-%m-%d")

        related = article.get("relatedTickers") or []
        tickers = [str(value).upper() for value in related if value]
        if symbol not in tickers:
            tickers.insert(0, symbol)

        items.append(
            {
                "id": str(article.get("uuid") or link or f"{symbol}-{title}"),
                "date": publish_date,
                "title": str(title),
                "summary": str(summary),
                "source": str(article.get("publisher") or "Yahoo Finance"),
                "url": str(link or ""),
                "tickers": tickers,
            }
        )

    return items, warnings


def main() -> int:
    symbols = [value.strip().upper() for value in sys.argv[1:] if value.strip()]
    if not symbols:
        print(json.dumps({"tickers": [], "news": [], "warnings": ["No symbols provided"]}))
        return 0

    unique_news: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    tickers: list[dict[str, Any]] = []

    for symbol in symbols:
        ticker_payload, ticker_warnings = extract_prices(symbol)
        tickers.append(ticker_payload)
        warnings.extend(ticker_warnings)

        news_items, news_warnings = extract_news(symbol)
        warnings.extend(news_warnings)
        for item in news_items:
            unique_news[item["id"]] = item

    print(
        json.dumps(
            {
                "tickers": tickers,
                "news": list(unique_news.values()),
                "warnings": warnings,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
