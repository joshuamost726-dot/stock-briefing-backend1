"""
fetch_sec_data.py
"""

import os
import re
import requests
import psycopg2
from psycopg2.extras import execute_values
from edgar import Company, set_identity

SEC_IDENTITY = "joshuamost726@gmail.com"
set_identity(SEC_IDENTITY)

TRACKED_TICKERS = ["RILY", "SKHY", "ASTS", "LRCX", "QCOM", "CWBHF"]

SMART_MONEY_WATCHLIST = [
    {"name": "Berkshire Hathaway", "cik": "1067983"},
    {"name": "Renaissance Technologies", "cik": None},
    {"name": "Baupost Group", "cik": None},
    {"name": "Third Point", "cik": None},
    {"name": "Tiger Global Management", "cik": None},
]

DATABASE_URL = os.environ["DATABASE_URL"]


def resolve_cik_by_name(fund_name):
    url = "https://www.sec.gov/cgi-bin/browse-edgar"
    params = {
        "action": "getcompany", "company": fund_name, "type": "13F-HR",
        "dateb": "", "owner": "include", "count": "10", "output": "atom",
    }
    resp = requests.get(url, params=params, headers={"User-Agent": SEC_IDENTITY})
    resp.raise_for_status()
    match = re.search(r"CIK=(\d+)", resp.text)
    return match.group(1) if match else None


def get_db_connection():
    return psycopg2.connect(DATABASE_URL)


def get_col(row, *names):
    for name in names:
        if name in row and row[name] is not None:
            return row[name]
    return None


def to_number(val):
    """Convert a value that might be a string like '1,234' into a real number."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return val
    try:
        return float(str(val).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


def fetch_executive_compensation(ticker, conn):
    try:
        company = Company(ticker)
        filings = company.get_filings(form="DEF 14A")
        if not filings:
            print(f"  no DEF 14A found for {ticker}")
            return

        proxy = filings.latest().obj()
        cik = str(company.cik)

        if proxy is None or not hasattr(proxy, "executive_compensation"):
            got_type = type(proxy).__name__ if proxy is not None else "None"
            print(f"  {ticker}: DEF 14A didn't parse as a proxy statement (got {got_type}) — skipping (known edgartools limitation)")
            return

        comp_df = proxy.executive_compensation
        if comp_df is None or len(comp_df) == 0:
            print(f"  {ticker}: proxy parsed but no compensation table found")
            return

        rows = []
        for _, row in comp_df.iterrows():
            rows.append((
                cik, ticker,
                get_col(row, "name", "Name"), get_col(row, "position", "Position", "title", "Title"),
                get_col(row, "year", "Year", "fiscal_year"),
                get_col(row, "total", "Total", "total_comp"),
                get_col(row, "salary", "Salary"), get_col(row, "bonus", "Bonus"),
                get_col(row, "stock_awards", "Stock Awards"), get_col(row, "option_awards", "Option Awards"),
            ))

        if rows:
            with conn.cursor() as cur:
                execute_values(cur, """
                    INSERT INTO executive_compensation
                        (cik, ticker, executive_name, position, fiscal_year,
                         total_comp, salary, bonus, stock_awards, option_awards)
                    VALUES %s
                    ON CONFLICT (cik, executive_name, fiscal_year)
                    DO UPDATE SET total_comp = EXCLUDED.total_comp, fetched_at = NOW()
                """, rows)
            conn.commit()
        print(f"  {ticker}: wrote {len(rows)} exec comp rows")

    except Exception as e:
        print(f"  ERROR fetching exec comp for {ticker}: {e}")
        conn.rollback()


def fetch_institutional_holdings(fund_name, cik, tracked_tickers, conn):
    try:
        fund = Company(cik)
        filings = fund.get_filings(form="13F-HR")
        if len(filings) == 0:
            print(f"  no 13F-HR found for {fund_name}")
            return

        sorted_filings = sorted(filings, key=lambda f: f.filing_date, reverse=True)
        latest_filing = sorted_filings[0]
        prior_filing = sorted_filings[1] if len(sorted_filings) > 1 else None

        latest = latest_filing.obj()
        if latest is None or not getattr(latest, "has_infotable", False):
            print(f"  {fund_name}: latest 13F-HR has no infotable data — skipping")
            return

        holdings_df = latest.infotable

        prior_df = None
        if prior_filing is not None:
            prior_obj = prior_filing.obj()
            if prior_obj is not None and getattr(prior_obj, "has_infotable", False):
                prior_df = prior_obj.infotable

        report_period = getattr(latest, "report_period", None)

        rows = []
        for _, h in holdings_df.iterrows():
            ticker = get_col(h, "Ticker")
            if not ticker or ticker not in tracked_tickers:
                continue

            cusip = get_col(h, "Cusip")
            shares = to_number(get_col(h, "SharesPrnAmount", "Shares"))
            value = to_number(get_col(h, "Value"))

            prior_shares = None
            if prior_df is not None and "Cusip" in prior_df.columns:
                match = prior_df[prior_df["Cusip"] == cusip]
                if not match.empty:
                    prior_shares = to_number(get_col(match.iloc[0], "SharesPrnAmount", "Shares"))

            pct_change = ((shares - prior_shares) / prior_shares * 100) if (shares is not None and prior_shares) else None

            rows.append((
                cik, fund_name, ticker, shares, value,
                report_period, prior_shares, pct_change,
            ))

        if rows:
            with conn.cursor() as cur:
                execute_values(cur, """
