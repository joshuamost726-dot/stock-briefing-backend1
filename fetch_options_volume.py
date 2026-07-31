"""
fetch_options_volume.py

Pulls options call/put volume and open interest from Yahoo Finance (via the
yfinance library) for tracked tickers and inserts a daily snapshot into the
options_volume table.

Data source note: Yahoo Finance's options endpoint is unofficial and
undocumented. yfinance handles Yahoo's session/crumb requirements internally,
but this is inherently more fragile than an official API — it can break
without notice if Yahoo changes something. Treat failures here as expected
occasionally, not necessarily a bug in this script.

Usage:
  python fetch_options_volume.py

Notes:
- SKHY (Korean listing) and CWBHF (thinly-traded OTC) are excluded — no
  meaningful US options market exists for either.
- Uses the NEAREST expiration date's full chain (all strikes) as the
  day's snapshot. Nearest-term options carry the most current sentiment.
"""

import argparse
import os
import sys
from datetime import date

import yfinance as yf
import psycopg2

# --- Config ---------------------------------------------------------------

# Used only if tracked_companies can't be reached.
FALLBACK_TICKERS = ["RILY", "ASTS", "LRCX", "QCOM"]
EXCLUDED_TICKERS = {"SKHY", "CWBHF"}  # no meaningful US options market

DATABASE_URL = os.environ.get("DATABASE_URL")


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


# --- Fetch -------------------------------------------------------------

def fetch_options_snapshot(ticker):
    tk = yf.Ticker(ticker)
    expirations = tk.options  # tuple of date strings, e.g. ('2026-08-15', ...)

    if not expirations:
        print(f"  No option expirations available for {ticker}")
        return None

    nearest_exp = expirations[0]
    chain = tk.option_chain(nearest_exp)

    calls = chain.calls
    puts = chain.puts

    call_volume = float(calls["volume"].fillna(0).sum())
    put_volume = float(puts["volume"].fillna(0).sum())
    call_oi = float(calls["openInterest"].fillna(0).sum())
    put_oi = float(puts["openInterest"].fillna(0).sum())

    return {
        "ticker": ticker,
        "snapshot_date": date.today(),
        "expiration_date": nearest_exp,
        "call_volume": call_volume,
        "put_volume": put_volume,
        "call_open_interest": call_oi,
        "put_open_interest": put_oi,
    }


# --- Database --------------------------------------------------------------

def insert_snapshot(conn, row):
    query = """
        INSERT INTO options_volume
            (ticker, snapshot_date, expiration_date, call_volume, put_volume,
             call_open_interest, put_open_interest)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (ticker, snapshot_date) DO UPDATE SET
            expiration_date = EXCLUDED.expiration_date,
            call_volume = EXCLUDED.call_volume,
            put_volume = EXCLUDED.put_volume,
            call_open_interest = EXCLUDED.call_open_interest,
            put_open_interest = EXCLUDED.put_open_interest,
            fetched_at = NOW()
    """
    with conn.cursor() as cur:
        cur.execute(query, (
            row["ticker"], row["snapshot_date"], row["expiration_date"],
            row["call_volume"], row["put_volume"],
            row["call_open_interest"], row["put_open_interest"],
        ))
    conn.commit()


# --- Main --------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ticker", help="Scope this run to a single ticker (on-demand backfill for a newly tracked stock) instead of the full tracked list.")
    args = parser.parse_args()

    if not DATABASE_URL:
        print("ERROR: DATABASE_URL environment variable not set.")
        sys.exit(1)

    conn = psycopg2.connect(DATABASE_URL)
    success_count = 0
    tickers = get_tracked_tickers(conn)
    if args.ticker:
        tickers = [t for t in tickers if t.upper() == args.ticker.upper()]

    for ticker in tickers:
        print(f"\n--- {ticker} ---")
        try:
            snapshot = fetch_options_snapshot(ticker)
        except Exception as e:
            print(f"  Failed to fetch options data: {e}")
            continue

        if snapshot is None:
            continue

        print(f"  Nearest expiration: {snapshot['expiration_date']}")
        print(f"  Call volume: {snapshot['call_volume']:.0f}, "
              f"Put volume: {snapshot['put_volume']:.0f}")

        try:
            insert_snapshot(conn, snapshot)
            success_count += 1
            print(f"  Row inserted/updated")
        except Exception as e:
            print(f"  Failed to insert: {e}")
            conn.rollback()

    conn.close()
    print(f"\nDone. {success_count}/{len(tickers)} tickers succeeded.")


if __name__ == "__main__":
    main()
