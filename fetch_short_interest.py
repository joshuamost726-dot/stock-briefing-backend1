"""
fetch_short_interest.py

Pulls short interest data from Nasdaq's public quote API for tracked tickers
and inserts it into the short_interest table.

Data source: https://api.nasdaq.com/api/quote/{TICKER}/short-interest?assetclass=stocks
- Free, no API key required
- Covers ALL US-listed equities regardless of primary exchange (confirmed
  working for both NYSE-listed RILY and Nasdaq-listed QCOM)
- Each call returns ~1 year of settlement periods already, so no complex
  backfill logic is needed like Form 4 required

Usage:
  python fetch_short_interest.py

Notes:
- SKHY (Korean listing) and CWBHF (Toronto listing) are excluded — no US
  short interest reporting applies to foreign-listed securities.
- Requires a browser-like User-Agent header or Nasdaq's API blocks the request.
"""

import os
import sys
from datetime import datetime

import requests
import psycopg2
from psycopg2.extras import execute_values

# --- Config ---------------------------------------------------------------

TRACKED_TICKERS = ["RILY", "ASTS", "LRCX", "QCOM"]
# SKHY and CWBHF intentionally excluded — foreign filers, no US short interest

DATABASE_URL = os.environ.get("DATABASE_URL")

HEADERS = {
    "accept": "application/json",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
}


# --- Fetch -------------------------------------------------------------

def fetch_short_interest(ticker):
    url = f"https://api.nasdaq.com/api/quote/{ticker}/short-interest?assetclass=stocks"
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    table = data.get("data", {}).get("shortInterestTable", {})
    rows = table.get("rows", [])
    return rows


def parse_rows(ticker, raw_rows):
    parsed = []
    for row in raw_rows:
        try:
            settlement_date = datetime.strptime(row["settlementDate"], "%m/%d/%Y").date()
            interest = float(str(row["interest"]).replace(",", ""))
            avg_volume_raw = str(row.get("avgDailyShareVolume", "")).replace(",", "")
            avg_volume = float(avg_volume_raw) if avg_volume_raw else None
            days_to_cover_raw = row.get("daysToCover")
            days_to_cover = float(days_to_cover_raw) if days_to_cover_raw not in (None, "N/A") else None

            parsed.append({
                "ticker": ticker,
                "settlement_date": settlement_date,
                "short_interest_shares": interest,
                "avg_daily_share_volume": avg_volume,
                "days_to_cover": days_to_cover,
            })
        except (KeyError, ValueError) as e:
            print(f"  [DEBUG] Skipping malformed row for {ticker}: {row} ({e})")
            continue
    return parsed


# --- Database --------------------------------------------------------------

def insert_rows(conn, rows):
    if not rows:
        return 0

    values = [
        (
            r["ticker"], r["settlement_date"], r["short_interest_shares"],
            r["avg_daily_share_volume"], r["days_to_cover"],
        )
        for r in rows
    ]

    query = """
        INSERT INTO short_interest
            (ticker, settlement_date, short_interest_shares,
             avg_daily_share_volume, days_to_cover)
        VALUES %s
        ON CONFLICT (ticker, settlement_date) DO UPDATE SET
            short_interest_shares = EXCLUDED.short_interest_shares,
            avg_daily_share_volume = EXCLUDED.avg_daily_share_volume,
            days_to_cover = EXCLUDED.days_to_cover,
            fetched_at = NOW()
    """

    with conn.cursor() as cur:
        execute_values(cur, query, values)
        affected = cur.rowcount
    conn.commit()
    return affected


# --- Main --------------------------------------------------------------

def main():
    if not DATABASE_URL:
        print("ERROR: DATABASE_URL environment variable not set.")
        sys.exit(1)

    conn = psycopg2.connect(DATABASE_URL)
    total = 0

    for ticker in TRACKED_TICKERS:
        print(f"\n--- {ticker} ---")
        try:
            raw_rows = fetch_short_interest(ticker)
        except requests.RequestException as e:
            print(f"  Failed to fetch: {e}")
            continue

        print(f"  Found {len(raw_rows)} settlement periods")
        parsed = parse_rows(ticker, raw_rows)
        affected = insert_rows(conn, parsed)
        total += affected
        print(f"  {affected} rows inserted/updated")

    conn.close()
    print(f"\nDone. Total rows affected: {total}")


if __name__ == "__main__":
    main()
