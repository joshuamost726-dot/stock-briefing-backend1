"""
fetch_technical_prices.py

Pulls ~1 year of daily close/volume history via yfinance for tracked
tickers and stores it in the daily_prices table, feeding technicalScore.js
— a moving-average / 52-week-range / volume-trend signal that doesn't
depend on any country's disclosure regime, unlike every other signal in
this app. Built specifically to help SKHY and CWBHF, which have very thin
coverage from every US/Korea-specific data source, but works for every
tracked ticker.

Data source: yfinance (same library fetch_options_volume.py already uses)
- Free, no API key required.
- SKHY needs special handling: yfinance's literal "SKHY" ticker is the
  thinly-traded US OTC ADR line (only ~11 trading days of history in a
  full year — nowhere near enough for a moving-average signal). The
  liquid, actually-traded security is SK Hynix's Korea Exchange listing,
  000660.KS — confirmed via yfinance directly to have a full ~250-day
  history. So this fetches 000660.KS's price data but stores it under the
  "SKHY" ticker key, matching how Finnhub's own quote/profile endpoints
  already resolve SKHY to 000660.KS internally (same reason
  getAnalystSignal's SKHY data already looks like a well-covered
  large-cap, not a thin OTC line).

Usage:
  python fetch_technical_prices.py
"""

import argparse
import os
import sys

import yfinance as yf
import psycopg2

# --- Config ---------------------------------------------------------------

# Used only if tracked_companies can't be reached.
FALLBACK_TICKERS = ["RILY", "SKHY", "ASTS", "LRCX", "QCOM", "CWBHF"]

# yfinance symbol to actually fetch price data from, when it differs from
# our own ticker key (see module docstring for why SKHY needs this).
YFINANCE_SYMBOL_OVERRIDE = {
    "SKHY": "000660.KS",
}

DATABASE_URL = os.environ.get("DATABASE_URL")


def get_tracked_tickers(conn):
    """Reads the tracked ticker list from tracked_companies (same source the
    website's Settings page writes to) instead of a hardcoded list, so a
    stock added on the site picks up this signal automatically. No
    exclusions — technical momentum works for every ticker."""
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT ticker FROM tracked_companies ORDER BY ticker")
            tickers = [row[0] for row in cur.fetchall()]
        return tickers if tickers else FALLBACK_TICKERS
    except Exception as e:
        print(f"Could not read tracked_companies: {e}. Using fallback list.")
        return FALLBACK_TICKERS


# --- Schema ------------------------------------------------------------

CREATE_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS daily_prices (
        id SERIAL PRIMARY KEY,
        ticker TEXT NOT NULL,
        trade_date DATE NOT NULL,
        close NUMERIC,
        volume BIGINT,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (ticker, trade_date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_prices_ticker ON daily_prices(ticker);
"""


# --- Fetch -------------------------------------------------------------

def fetch_history(ticker):
    yf_symbol = YFINANCE_SYMBOL_OVERRIDE.get(ticker, ticker)
    hist = yf.Ticker(yf_symbol).history(period="1y")
    return hist


# --- Database --------------------------------------------------------------

def upsert_rows(conn, ticker, hist):
    query = """
        INSERT INTO daily_prices (ticker, trade_date, close, volume)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (ticker, trade_date) DO UPDATE SET
            close = EXCLUDED.close,
            volume = EXCLUDED.volume,
            fetched_at = NOW()
    """
    count = 0
    with conn.cursor() as cur:
        for trade_date, row in hist.iterrows():
            close = row["Close"]
            volume = row["Volume"]
            # yfinance sometimes returns an incomplete trailing row (today's
            # session still in progress) with NaN close — skip those rather
            # than storing a broken data point.
            if close != close or volume != volume:  # NaN check without pandas import
                continue
            cur.execute(query, (ticker, trade_date.date(), float(close), int(volume)))
            count += 1
    conn.commit()
    return count


# --- Main --------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ticker", help="Scope this run to a single ticker (on-demand backfill for a newly tracked stock) instead of the full tracked list.")
    args = parser.parse_args()

    if not DATABASE_URL:
        print("ERROR: DATABASE_URL environment variable not set.")
        sys.exit(1)

    conn = psycopg2.connect(DATABASE_URL)
    with conn.cursor() as cur:
        cur.execute(CREATE_TABLE_SQL)
    conn.commit()

    total = 0

    tickers = get_tracked_tickers(conn)
    if args.ticker:
        tickers = [t for t in tickers if t.upper() == args.ticker.upper()]

    for ticker in tickers:
        print(f"\n--- {ticker} ---")
        try:
            hist = fetch_history(ticker)
        except Exception as e:
            print(f"  Failed to fetch: {e}")
            continue

        if hist.empty:
            print(f"  No price history returned")
            continue

        print(f"  Found {len(hist)} day(s) of history")
        try:
            affected = upsert_rows(conn, ticker, hist)
            total += affected
            print(f"  {affected} rows upserted")
        except Exception as e:
            print(f"  Failed to upsert: {e}")
            conn.rollback()

    conn.close()
    print(f"\nDone. Total rows upserted: {total}")


if __name__ == "__main__":
    main()
