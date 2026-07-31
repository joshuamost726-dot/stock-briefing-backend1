"""
fetch_wsb_mentions.py

Pulls daily Reddit/WallStreetBets mention-volume data from ApeWisdom's free
public API (no key required) and stores a daily snapshot per tracked ticker
in the wsb_mentions table.

Data source: https://apewisdom.io/api/v1.0/filter/all-stocks/page/{n}
- Free, keyless, no documented rate limit. Returns ~100 ranked tickers per
  page across ~10 pages covering everything WSB-adjacent subreddits are
  currently discussing.
- ApeWisdom reports MENTION VOLUME only, not sentiment polarity — see
  wsbSentimentScore.js for how that's handled downstream.
- A ticker not present in any page means negligible/zero mentions that day.
  We still write a zero-mention row so the daily time series has no gaps
  (needed for wsbSentimentScore.js's rolling baseline to be accurate).

Usage:
  python fetch_wsb_mentions.py
"""

import argparse
import os
import sys
import time
from datetime import date

import requests
import psycopg2

# --- Config ---------------------------------------------------------------

# Used only if tracked_companies can't be reached.
FALLBACK_TICKERS = ["RILY", "SKHY", "ASTS", "LRCX", "QCOM", "CWBHF"]
# No exclusions here — unlike SEC/FINRA-sourced signals, Reddit chatter isn't
# restricted to US-listed securities, so foreign listings stay in scope.

MAX_PAGES = 10
REQUEST_DELAY_SECONDS = 1

DATABASE_URL = os.environ.get("DATABASE_URL")


def get_tracked_tickers(conn):
    """Reads the tracked ticker list from tracked_companies (same source the
    website's Settings page writes to) instead of a hardcoded list, so a
    stock added on the site picks up this signal automatically."""
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
    CREATE TABLE IF NOT EXISTS wsb_mentions (
        id SERIAL PRIMARY KEY,
        ticker TEXT NOT NULL,
        snapshot_date DATE NOT NULL,
        mentions INTEGER NOT NULL DEFAULT 0,
        rank INTEGER,
        upvotes INTEGER,
        mentions_24h_ago INTEGER,
        rank_24h_ago INTEGER,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (ticker, snapshot_date)
    );
    CREATE INDEX IF NOT EXISTS idx_wsb_mentions_ticker ON wsb_mentions(ticker);
"""


# --- Fetch -------------------------------------------------------------

def fetch_all_pages():
    """Fetches every page of the all-stocks filter and returns a ticker -> row map."""
    by_ticker = {}
    page = 1

    while page <= MAX_PAGES:
        url = f"https://apewisdom.io/api/v1.0/filter/all-stocks/page/{page}"
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        results = data.get("results", [])
        if not results:
            break

        for row in results:
            ticker = row.get("ticker")
            if ticker:
                by_ticker[ticker] = row

        total_pages = data.get("pages", 1)
        print(f"  fetched page {page}/{total_pages} ({len(results)} tickers)")

        if page >= total_pages:
            break

        page += 1
        time.sleep(REQUEST_DELAY_SECONDS)

    return by_ticker


def to_int(val):
    if val is None:
        return None
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None


# --- Database --------------------------------------------------------------

def upsert_row(conn, ticker, snapshot_date, row):
    query = """
        INSERT INTO wsb_mentions
            (ticker, snapshot_date, mentions, rank, upvotes, mentions_24h_ago, rank_24h_ago)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (ticker, snapshot_date) DO UPDATE SET
            mentions = EXCLUDED.mentions,
            rank = EXCLUDED.rank,
            upvotes = EXCLUDED.upvotes,
            mentions_24h_ago = EXCLUDED.mentions_24h_ago,
            rank_24h_ago = EXCLUDED.rank_24h_ago,
            fetched_at = NOW()
    """
    mentions = to_int(row.get("mentions")) if row else 0
    rank = to_int(row.get("rank")) if row else None
    upvotes = to_int(row.get("upvotes")) if row else None
    mentions_24h_ago = to_int(row.get("mentions_24h_ago")) if row else None
    rank_24h_ago = to_int(row.get("rank_24h_ago")) if row else None

    with conn.cursor() as cur:
        cur.execute(query, (
            ticker, snapshot_date, mentions or 0, rank, upvotes,
            mentions_24h_ago, rank_24h_ago,
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
    with conn.cursor() as cur:
        cur.execute(CREATE_TABLE_SQL)
    conn.commit()

    print("Fetching all pages from ApeWisdom...")
    by_ticker = fetch_all_pages()
    print(f"Found {len(by_ticker)} total tickers across all pages\n")

    today = date.today()
    success_count = 0
    tickers = get_tracked_tickers(conn)
    if args.ticker:
        tickers = [t for t in tickers if t.upper() == args.ticker.upper()]

    for ticker in tickers:
        row = by_ticker.get(ticker)
        try:
            upsert_row(conn, ticker, today, row)
            success_count += 1
            if row:
                print(f"  {ticker}: {row.get('mentions')} mentions, rank #{row.get('rank')}")
            else:
                print(f"  {ticker}: not found on any page — recorded 0 mentions")
        except Exception as e:
            print(f"  {ticker}: failed to upsert: {e}")
            conn.rollback()

    conn.close()
    print(f"\nDone. {success_count}/{len(tickers)} tickers recorded.")


if __name__ == "__main__":
    main()
