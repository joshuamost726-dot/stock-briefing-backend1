"""
fetch_gov_contracts.py

Pulls historical federal government contract award data from Quiver
Quantitative for tracked tickers and stores it in the gov_contracts table.

Data source: https://api.quiverquant.com/beta/historical/govcontracts/{TICKER}
- Requires QUIVER_API_KEY (same Hobbyist-tier key already used for congress trades)
- Returns each ticker's full contract history (by year/quarter) in one call, so
  this script replaces (delete + re-insert) each ticker's rows on every run,
  same approach as fetch_congress_trades.py.

Usage:
  python fetch_gov_contracts.py

Notes:
- SKHY (Korean listing) and CWBHF (Toronto listing) are excluded — federal
  contract data only applies to US-domiciled entities in Quiver's coverage.
"""

import argparse
import os
import sys

import requests
import psycopg2
from psycopg2.extras import execute_values

# --- Config ---------------------------------------------------------------

# Used only if tracked_companies can't be reached.
FALLBACK_TICKERS = ["RILY", "ASTS", "LRCX", "QCOM"]
EXCLUDED_TICKERS = {"SKHY", "CWBHF"}  # federal contract data only applies to US-domiciled entities

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
    CREATE TABLE IF NOT EXISTS gov_contracts (
        id SERIAL PRIMARY KEY,
        ticker TEXT NOT NULL,
        contract_year INTEGER NOT NULL,
        contract_qtr INTEGER NOT NULL,
        amount NUMERIC,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_gov_contracts_ticker ON gov_contracts(ticker);
"""


# --- Fetch -------------------------------------------------------------

def fetch_gov_contracts(ticker):
    url = f"https://api.quiverquant.com/beta/historical/govcontracts/{ticker}"
    headers = {**HEADERS, "Authorization": f"Token {QUIVER_API_KEY}"}
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


def parse_rows(ticker, raw_rows):
    parsed = []
    for row in raw_rows:
        try:
            amount_raw = row.get("Amount")
            amount = float(amount_raw) if amount_raw not in (None, "") else None

            parsed.append({
                "ticker": ticker,
                "contract_year": int(row["Year"]),
                "contract_qtr": int(row["Qtr"]),
                "amount": amount,
            })
        except (KeyError, ValueError, TypeError) as e:
            print(f"  [DEBUG] Skipping malformed row for {ticker}: {row} ({e})")
            continue
    return parsed


# --- Database --------------------------------------------------------------

def replace_ticker_rows(conn, ticker, rows):
    with conn.cursor() as cur:
        cur.execute("DELETE FROM gov_contracts WHERE ticker = %s", (ticker,))

        if rows:
            values = [
                (r["ticker"], r["contract_year"], r["contract_qtr"], r["amount"])
                for r in rows
            ]
            query = """
                INSERT INTO gov_contracts (ticker, contract_year, contract_qtr, amount)
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
            raw_rows = fetch_gov_contracts(ticker)
        except requests.RequestException as e:
            print(f"  Failed to fetch: {e}")
            continue

        print(f"  Found {len(raw_rows)} contract record(s)")
        parsed = parse_rows(ticker, raw_rows)
        affected = replace_ticker_rows(conn, ticker, parsed)
        total += affected
        print(f"  {affected} rows stored")

    conn.close()
    print(f"\nDone. Total rows stored: {total}")


if __name__ == "__main__":
    main()
