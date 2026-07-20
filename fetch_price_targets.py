"""
fetch_price_targets.py

Pulls analyst price target consensus (high/low/mean/median) from Yahoo
Finance via yfinance for tracked tickers and inserts a daily snapshot.

Usage:
  python fetch_price_targets.py

Notes:
- SKHY (Korean listing) and CWBHF (thinly-traded OTC) are excluded — thin
  or nonexistent US analyst coverage.
"""

import os
import sys
from datetime import date

import yfinance as yf
import psycopg2

TRACKED_TICKERS = ["RILY", "ASTS", "LRCX", "QCOM"]

DATABASE_URL = os.environ.get("DATABASE_URL")


def fetch_targets(ticker):
    tk = yf.Ticker(ticker)
    targets = tk.analyst_price_targets

    if not targets:
        return None

    return {
        "ticker": ticker,
        "snapshot_date": date.today(),
        "current_price": targets.get("current"),
        "target_high": targets.get("high"),
        "target_low": targets.get("low"),
        "target_mean": targets.get("mean"),
        "target_median": targets.get("median"),
        "num_analysts": tk.info.get("numberOfAnalystOpinions"),
    }


def insert_row(conn, row):
    query = """
        INSERT INTO price_targets
            (ticker, snapshot_date, current_price, target_high, target_low,
             target_mean, target_median, num_analysts)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (ticker, snapshot_date) DO UPDATE SET
            current_price = EXCLUDED.current_price,
            target_high = EXCLUDED.target_high,
            target_low = EXCLUDED.target_low,
            target_mean = EXCLUDED.target_mean,
            target_median = EXCLUDED.target_median,
            num_analysts = EXCLUDED.num_analysts,
            fetched_at = NOW()
    """
    with conn.cursor() as cur:
        cur.execute(query, (
            row["ticker"], row["snapshot_date"], row["current_price"],
            row["target_high"], row["target_low"], row["target_mean"],
            row["target_median"], row["num_analysts"],
        ))
    conn.commit()


def main():
    if not DATABASE_URL:
        print("ERROR: DATABASE_URL environment variable not set.")
        sys.exit(1)

    conn = psycopg2.connect(DATABASE_URL)
    success_count = 0

    for ticker in TRACKED_TICKERS:
        print(f"\n--- {ticker} ---")
        try:
            row = fetch_targets(ticker)
        except Exception as e:
            print(f"  Failed to fetch: {e}")
            continue

        if row is None:
            print(f"  No analyst price target data available for {ticker}")
            continue

        print(f"  Mean: ${row['target_mean']}, High: ${row['target_high']}, "
              f"Low: ${row['target_low']}, Analysts: {row['num_analysts']}")

        try:
            insert_row(conn, row)
            success_count += 1
            print(f"  Row inserted/updated")
        except Exception as e:
            print(f"  Failed to insert: {e}")
            conn.rollback()

    conn.close()
    print(f"\nDone. {success_count}/{len(TRACKED_TICKERS)} tickers succeeded.")


if __name__ == "__main__":
    main()
