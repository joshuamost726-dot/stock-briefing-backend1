"""
fetch_form4.py

Pulls Form 4 (insider transaction) filings from SEC EDGAR for tracked tickers
and inserts them into the insider_transactions table.

Usage:
  python fetch_form4.py                 # incremental — last 7 days
  python fetch_form4.py --backfill 365  # backfill N days (run once, first time)

Notes:
- SKHY (Korean listing) and CWBHF (Toronto listing) are foreign filers and
  will never have Form 4s, same limitation as DEF 14A / executive_compensation.
- SEC requires a descriptive User-Agent on all requests, or you get blocked.
"""

import argparse
import os
import sys
import time
from datetime import datetime, timedelta

import requests
import psycopg2
from psycopg2.extras import execute_values

# --- Config ---------------------------------------------------------------

USER_AGENT = "Josh Most joshuamost726@gmail.com"

TRACKED_CIKS = {
    "RILY": "0001464790",
    "ASTS": "0001780312",
    "LRCX": "0000707549",
    "QCOM": "0000804328",
    # SKHY and CWBHF intentionally excluded — foreign filers, no Form 4
}

DATABASE_URL = os.environ.get("DATABASE_URL")
HEADERS = {"User-Agent": USER_AGENT}


# --- SEC EDGAR fetch helpers ------------------------------------------------

def get_filing_index(cik, days_back):
    cik_padded = cik.lstrip("0").zfill(10)
    url = f"https://data.sec.gov/submissions/CIK{cik_padded}.json"
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    recent = data.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    accession_numbers = recent.get("accessionNumber", [])
    filing_dates = recent.get("filingDate", [])
    primary_docs = recent.get("primaryDocument", [])

    cutoff = datetime.now() - timedelta(days=days_back)

    results = []
    for form, accn, fdate, doc in zip(forms, accession_numbers, filing_dates, primary_docs):
        if form != "4":
            continue
        filed = datetime.strptime(fdate, "%Y-%m-%d")
        if filed < cutoff:
            continue
        results.append({"accession": accn, "filed_at": fdate, "primary_doc": doc})
    return results


def fetch_form4_xml(cik, accession, primary_doc):
    accn_nodashes = accession.replace("-", "")
    cik_nozeros = cik.lstrip("0")
    url = f"https://www.sec.gov/Archives/edgar/data/{cik_nozeros}/{accn_nodashes}/{primary_doc}"
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.text


# --- XML parsing -----------------------------------------------------------

def parse_form4_xml(xml_text, ticker, cik):
    import xml.etree.ElementTree as ET

    transactions = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return transactions

    owner_name = None
    owner_title = None
    owner_el = root.find(".//reportingOwner/reportingOwnerId/rptOwnerName")
    if owner_el is not None:
        owner_name = owner_el.text

    relationship_el = root.find(".//reportingOwner/reportingOwnerRelationship")
    if relationship_el is not None:
        title_el = relationship_el.find("officerTitle")
        if title_el is not None and title_el.text:
            owner_title = title_el.text.strip()
        elif relationship_el.find("isDirector") is not None and relationship_el.find("isDirector").text == "1":
            owner_title = "Director"
        elif relationship_el.find("isTenPercentOwner") is not None and relationship_el.find("isTenPercentOwner").text == "1":
            owner_title = "10% Owner"

    for txn in root.findall(".//nonDerivativeTable/nonDerivativeTransaction"):
        try:
            txn_date = txn.find(".//transactionDate/value").text
            txn_code = txn.find(".//transactionCoding/transactionCode").text
            shares = txn.find(".//transactionAmounts/transactionShares/value").text
            price_el = txn.find(".//transactionAmounts/transactionPricePerShare/value")
            price = price_el.text if price_el is not None else None
            shares_after_el = txn.find(".//postTransactionAmounts/sharesOwnedFollowingTransaction/value")
            shares_after = shares_after_el.text if shares_after_el is not None else None

            shares_f = float(shares) if shares else None
            price_f = float(price) if price else None
            value_usd = (shares_f * price_f) if (shares_f and price_f) else None

            transactions.append({
                "cik": cik,
                "ticker": ticker,
                "insider_name": owner_name,
                "position": owner_title,
                "transaction_date": txn_date,
                "transaction_type": txn_code,
                "shares": shares_f,
                "price_per_share": price_f,
                "value_usd": value_usd,
                "shares_owned_after": float(shares_after) if shares_after else None,
            })
        except (AttributeError, ValueError):
            continue

    return transactions


# --- Database --------------------------------------------------------------

def insert_transactions(conn, transactions, filed_at):
    if not transactions:
        return 0

    rows = [
        (
            t["cik"], t["ticker"], t["insider_name"], t["position"],
            t["transaction_date"], t["transaction_type"], t["shares"],
            t["price_per_share"], t["value_usd"], t["shares_owned_after"],
            filed_at,
        )
        for t in transactions
    ]

    query = """
        INSERT INTO insider_transactions
            (cik, ticker, insider_name, position, transaction_date,
             transaction_type, shares, price_per_share, value_usd,
             shares_owned_after, filed_at)
        VALUES %s
        ON CONFLICT (cik, ticker, transaction_date, insider_name, transaction_type, shares)
        DO NOTHING
    """

    with conn.cursor() as cur:
        execute_values(cur, query, rows)
        inserted = cur.rowcount
    conn.commit()
    return inserted


# --- Main --------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backfill", type=int, default=7)
    args = parser.parse_args()

    if not DATABASE_URL:
        print("ERROR: DATABASE_URL environment variable not set.")
        sys.exit(1)

    conn = psycopg2.connect(DATABASE_URL)
    total_inserted = 0

    for ticker, cik in TRACKED_CIKS.items():
        print(f"\n--- {ticker} (CIK {cik}) ---")
        try:
            filings = get_filing_index(cik, args.backfill)
        except requests.RequestException as e:
            print(f"  Failed to fetch filing index: {e}")
            continue

        print(f"  Found {len(filings)} Form 4 filings in the last {args.backfill} days")

        for f in filings:
            time.sleep(0.15)
            try:
                xml_text = fetch_form4_xml(cik, f["accession"], f["primary_doc"])
            except requests.RequestException as e:
                print(f"  Failed to fetch {f['accession']}: {e}")
                continue

            transactions = parse_form4_xml(xml_text, ticker, cik)
            inserted = insert_transactions(conn, transactions, f["filed_at"])
            total_inserted += inserted
            if transactions:
                print(f"  {f['accession']}: {len(transactions)} txns parsed, {inserted} new rows inserted")

    conn.close()
    print(f"\nDone. Total new rows inserted: {total_inserted}")


if __name__ == "__main__":
    main()
