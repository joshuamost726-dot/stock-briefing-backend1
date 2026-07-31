"""
fetch_offexchange.py

Pulls daily off-exchange (FINRA ATS/dark pool) volume data from Quiver
Quantitative for tracked tickers and stores it in the off_exchange_volume
table.

Data source: https://api.quiverquant.com/beta/historical/offexchange/{TICKER}
- Requires QUIVER_API_KEY (same Hobbyist-tier key already used elsewhere)
- Returns a rolling window of recent daily rows per call. Upserts on
  (ticker, trade_date) rather than delete+reinsert, since this is a daily
  time series we want to keep accumulating history for (unlike
  congress_trades/gov_contracts, which are small, mostly-static tables where
  a full replace is cheap and simplest).

Usage:
  python fetch_offexchange.py

Notes:
- SKHY (Korean listing) and CWBHF (Toronto listing) are excluded — FINRA
  off-exchange data only covers US-listed securities.
"""

import argparse
import os
import sys
from datetime import datetime

import requests
import psycopg2

# --- Config ---------------------------------------------------------------

# Used only if tracked_companies can't be reached.
FALLBACK_TICKERS = ["RILY", "ASTS", "LRCX", "QCOM"]
EXCLUDED_TICKERS = {"SKHY", "CWBHF"}  # foreign listings, no FINRA coverage

DATABASE_URL = os.environ.get("DATABASE_URL")
QUIVER_API_KEY = os.environ.get("QUIVER_API_KEY")

HEADERS = {
    "accept": "application/json",
}


def get_tracked_tickers(conn):
    """Reads the tracked ticker list from tracked_companies (same source the
    website's Settings page writes to) instead of a hardcoded list, so a
    stock added on the site picks up this signal automatically."""
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT ticker FROM tracked_companies ORDER BY ticker")
            tickers = [row[0] for row in cur.fetchall()]
        if not tickers:
            tickers = FALLBACK_TICKERS
    except Exception as e:
        print(f"Could not read tracked_companies: {e}. Using fallback list.")
        tickers = FALLBACK_TICKERS
    return [t for t in tickers if t not in EXCLUDED_TICKERS]


# --- Schema ------------------------------------------------------------

CREATE_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS off_exchange_volume (
        id SERIAL PRIMARY KEY,
        ticker TEXT NOT NULL,
        trade_date DATE NOT NULL,
        otc_short NUMERIC,
        otc_total NUMERIC,
        dpi NUMERIC,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (ticker, trade_date)
    );
    CREATE INDEX IF NOT EXISTS idx_off_exchange_volume_ticker ON off_exchange_volume(ticker);
"""


# --- Fetch -------------------------------------------------------------

def fetch_offexchange(ticker):
    url = f"https://api.quiverquant.com/beta/historical/offexchange/{ticker}"
    headers = {**HEADERS, "Authorization": f"Token {QUIVER_API_KEY}"}
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


def parse_rows(ticker, raw_rows):
    parsed = []
    for row in raw_rows:
        try:
            trade_date = datetime.strptime(row["Date"], "%Y-%m-%d").date()
            parsed.append({
                "ticker": ticker,
                "trade_date": trade_date,
                "otc_short": row.get("OTC_Short"),
                "otc_total": row.get("OTC_Total"),
                "dpi": row.get("DPI"),
            })
        except (KeyError, ValueError) as e:
            print(f"  [DEBUG] Skipping malformed row for {ticker}: {row} ({e})")
            continue
    return parsed


# --- Database --------------------------------------------------------------

def upsert_rows(conn, rows):
    query = """
        INSERT INTO off_exchange_volume (ticker, trade_date, otc_short, otc_total, dpi)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (ticker, trade_date) DO UPDATE SET
            otc_short = EXCLUDED.otc_short,
            otc_total = EXCLUDED.otc_total,
            dpi = EXCLUDED.dpi,
            fetched_at = NOW()
    """
    with conn.cursor() as cur:
        for r in rows:
            cur.execute(query, (r["ticker"], r["trade_date"], r["otc_short"], r["otc_total"], r["dpi"]))
    conn.commit()
    return len(rows)


# --- Main --------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ticker", help="Scope this run to a single ticker (on-demand backfill for a newly tracked stock) instead of the full tracked list.")
    args = parser.parse_args()

    if not DATABASE_URL:
        print("ERROR: DATABASE_URL environment variable not set.")
        sys.exit(1)
    if not QUIVER_API_KEY:
        print("ERROR: QUIVER_API_KEY environment variable not set.")
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
            raw_rows = fetch_offexchange(ticker)
        except requests.RequestException as e:
            print(f"  Failed to fetch: {e}")
            continue

        print(f"  Found {len(raw_rows)} daily row(s)")
        parsed = parse_rows(ticker, raw_rows)
        try:
            affected = upsert_rows(conn, parsed)
            total += affected
            print(f"  {affected} rows upserted")
        except Exception as e:
            print(f"  Failed to upsert: {e}")
            conn.rollback()

    conn.close()
    print(f"\nDone. Total rows upserted: {total}")


if __name__ == "__main__":
    main()
