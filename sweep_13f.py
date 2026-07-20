"""
sweep_13f.py — full 13F-HR sweep for a quarter.

Scans every 13F-HR filed in a quarter and records any holding
matching a tracked ticker or CUSIP. Roughly 20-25 minutes.
"""

import os
import time
import psycopg2
from psycopg2.extras import execute_values
from edgar import set_identity, get_filings

SEC_IDENTITY = "joshuamost726@gmail.com"
set_identity(SEC_IDENTITY)

DATABASE_URL = os.environ["DATABASE_URL"]

YEAR = 2026
QUARTER = 2

# CUSIP fallback for when the Ticker column is missing or blank.
CUSIP_TO_TICKER = {
    "00217D100": "ASTS",
    "512807306": "LRCX",
    "747525103": "QCOM",
}

PROGRESS_EVERY = 500


def get_db_connection():
    return psycopg2.connect(DATABASE_URL)


def get_tracked_tickers(conn):
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT ticker FROM tracked_companies")
            tickers = [r[0] for r in cur.fetchall()]
        if tickers:
            return set(tickers)
    except Exception as e:
        print(f"Could not read tracked_companies: {e}. Using fallback.")
        conn.rollback()
    return {"RILY", "SKHY", "ASTS", "LRCX", "QCOM", "CWBHF"}


def to_number(val):
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return val
    try:
        return float(str(val).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def get_col(row, *names):
    for name in names:
        try:
            if name in row and row[name] is not None:
                return row[name]
        except Exception:
            continue
    return None


def load_prior_shares(conn, period):
    """
    Map of (fund_cik, ticker) -> shares_held from the most recent
    earlier filing period, so we can compute quarter-over-quarter change.
    """
    prior = {}
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT fund_cik, ticker, shares_held
                FROM institutional_holdings
                WHERE filing_period = (
                    SELECT MAX(filing_period)
                    FROM institutional_holdings
                    WHERE filing_period < %s
                )
            """, (period,))
            for cik, ticker, shares in cur.fetchall():
                prior[(cik, ticker)] = shares
    except Exception as e:
        print(f"Could not load prior quarter: {e}")
        conn.rollback()
    return prior


def main():
    conn = get_db_connection()
    tracked = get_tracked_tickers(conn)

    print("=" * 55)
    print(f"13F sweep — {YEAR} Q{QUARTER}")
    print(f"Tracked: {sorted(tracked)}")
    print("=" * 55)

    t0 = time.time()
    filings = get_filings(year=YEAR, quarter=QUARTER, form="13F-HR")
    total = len(filings)
    print(f"Found {total} filings in {time.time() - t0:.1f}s\n")

    rows = []
    period = None
    parsed = 0
    skipped = 0
    errors = 0

    t1 = time.time()

    for i, f in enumerate(filings, 1):
        if i % PROGRESS_EVERY == 0:
            pct = i / total * 100
            mins = (time.time() - t1) / 60
            print(f"  {i}/{total} ({pct:.0f}%) — {len(rows)} holdings found — {mins:.1f} min elapsed")

        try:
            obj = f.obj()
            if obj is None or not getattr(obj, "has_infotable", False):
                skipped += 1
                continue

            df = obj.infotable
            parsed += 1

            if period is None:
                period = getattr(obj, "report_period", None)

            fund_cik = str(f.cik)
            fund_name = f.company

            for _, h in df.iterrows():
                ticker = get_col(h, "Ticker")
                cusip = get_col(h, "Cusip")

                if not ticker or ticker not in tracked:
                    ticker = CUSIP_TO_TICKER.get(cusip)
                if not ticker or ticker not in tracked:
                    continue

                rows.append((
                    fund_cik,
                    fund_name,
                    ticker,
                    to_number(get_col(h, "SharesPrnAmount", "Shares")),
                    to_number(get_col(h, "Value")),
                ))

        except Exception:
            errors += 1
            continue

    elapsed = (time.time() - t1) / 60
    print(f"\nScan complete in {elapsed:.1f} min")
    print(f"  parsed:  {parsed}")
    print(f"  skipped: {skipped}")
    print(f"  errors:  {errors}")
    print(f"  holdings found: {len(rows)}")

    if not rows:
        print("\nNothing to write. Exiting.")
        conn.close()
        return

    if period is None:
        print("\nNo report_period found — cannot write safely. Exiting.")
        conn.close()
        return

    print(f"\nFiling period: {period}")

    prior = load_prior_shares(conn, period)
    print(f"Prior-quarter rows available: {len(prior)}")

   agg = {}
    for fund_cik, fund_name, ticker, shares, value in rows:
        key = (fund_cik, ticker)
        if key not in agg:
            agg[key] = {"name": fund_name, "shares": 0.0, "value": 0.0}
        agg[key]["shares"] += shares or 0
        agg[key]["value"] += value or 0

    print(f"Aggregated {len(rows)} lines into {len(agg)} fund-ticker positions")

    final = []
    for (fund_cik, ticker), d in agg.items():
        prior_shares = prior.get((fund_cik, ticker))
        pct_change = None
        if d["shares"] and prior_shares:
            pct_change = (d["shares"] - float(prior_shares)) / float(prior_shares) * 100

        final.append((
            fund_cik, d["name"], ticker, d["shares"], d["value"],
            period, prior_shares, pct_change,
        ))

    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM institutional_holdings WHERE filing_period = %s",
            (period,),
        )
        execute_values(cur, """
            INSERT INTO institutional_holdings
                (fund_cik, fund_name, ticker, shares_held, value_usd,
                 filing_period, prior_shares_held, pct_change)
            VALUES %s
        """, final, page_size=500)
    conn.commit()

    print(f"Wrote {len(final)} rows.")

    with conn.cursor() as cur:
        cur.execute("""
            SELECT ticker, COUNT(*) AS holders
            FROM institutional_holdings
            WHERE filing_period = %s
            GROUP BY ticker
            ORDER BY holders DESC
        """, (period,))
        print("\nHolders per ticker:")
        for ticker, count in cur.fetchall():
            print(f"  {ticker}: {count}")

    conn.close()
    print("\nDone.")


if __name__ == "__main__":
    main()
