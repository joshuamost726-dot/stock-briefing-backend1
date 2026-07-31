"""
fetch_congress_trades.py

Pulls US Congress stock trading disclosures (STOCK Act filings) from Quiver
Quantitative's API for tracked tickers and stores them in the
congress_trades table.

Data source: https://api.quiverquant.com/beta/historical/congresstrading/{TICKER}
- Requires QUIVER_API_KEY (paid Quiver API subscription, Hobbyist tier or above)
- Returns each ticker's full disclosed trading history in one call, so this
  script replaces (delete + re-insert) each ticker's rows on every run rather
  than doing incremental upserts — simplest way to also pick up Quiver's own
  occasional corrections to historical disclosure data.

Usage:
  python fetch_congress_trades.py

Notes:
- SKHY (Korean listing) and CWBHF (Toronto listing) are excluded — members of
  Congress only disclose trades in US-listed securities.
"""

import argparse
import os
import sys
from datetime import datetime

import requests
import psycopg2
from psycopg2.extras import execute_values

# --- Config ---------------------------------------------------------------

# Used only if tracked_companies can't be reached.
FALLBACK_TICKERS = ["RILY", "ASTS", "LRCX", "QCOM"]
EXCLUDED_TICKERS = {"SKHY", "CWBHF"}  # foreign listings, no STOCK Act coverage

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
    CREATE TABLE IF NOT EXISTS congress_trades (
        id SERIAL PRIMARY KEY,
        ticker TEXT NOT NULL,
        representative TEXT NOT NULL,
        party TEXT,
        chamber TEXT,
        transaction_date DATE NOT NULL,
        report_date DATE,
        transaction_type TEXT NOT NULL,
        amount NUMERIC,
        amount_range TEXT,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_congress_trades_ticker ON congress_trades(ticker);
"""


# --- Fetch -------------------------------------------------------------

def fetch_congress_trades(ticker):
    url = f"https://api.quiverquant.com/beta/historical/congresstrading/{ticker}"
    headers = {**HEADERS, "Authorization": f"Token {QUIVER_API_KEY}"}
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


def parse_rows(ticker, raw_rows):
    parsed = []
    for row in raw_rows:
        try:
            transaction_date = datetime.strptime(row["TransactionDate"], "%Y-%m-%d").date()
            report_date_raw = row.get("ReportDate")
            report_date = (
                datetime.strptime(report_date_raw, "%Y-%m-%d").date()
                if report_date_raw else None
            )
            amount_raw = row.get("Amount")
            amount = float(amount_raw) if amount_raw not in (None, "") else None

            parsed.append({
                "ticker": ticker,
                "representative": row["Representative"],
                "party": row.get("Party"),
                "chamber": row.get("House"),
                "transaction_date": transaction_date,
                "report_date": report_date,
                "transaction_type": row["Transaction"],
                "amount": amount,
                "amount_range": row.get("Range"),
            })
        except (KeyError, ValueError) as e:
            print(f"  [DEBUG] Skipping malformed row for {ticker}: {row} ({e})")
            continue
    return parsed


# --- Database --------------------------------------------------------------

def replace_ticker_rows(conn, ticker, rows):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM congress_trades WHERE ticker = %s", (ticker,))

        if rows:
            values = [
                (
                    r["ticker"], r["representative"], r["party"], r["chamber"],
                    r["transaction_date"], r["report_date"], r["transaction_type"],
                    r["amount"], r["amount_range"],
                )
                for r in rows
            ]
            query = """
                INSERT INTO congress_trades
                    (ticker, representative, party, chamber, transaction_date,
                     report_date, transaction_type, amount, amount_range)
                VALUES %s
            """
            execute_values(cur, query, values)

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
            raw_rows = fetch_congress_trades(ticker)
        except requests.RequestException as e:
            print(f"  Failed to fetch: {e}")
            continue

        print(f"  Found {len(raw_rows)} disclosed trades")
        parsed = parse_rows(ticker, raw_rows)
        affected = replace_ticker_rows(conn, ticker, parsed)
        total += affected
        print(f"  {affected} rows stored")

    conn.close()
    print(f"\nDone. Total rows stored: {total}")


if __name__ == "__main__":
    main()
