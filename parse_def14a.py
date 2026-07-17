import os
import psycopg2
import requests
from bs4 import BeautifulSoup
from datetime import datetime
import re

DATABASE_URL = os.environ['DATABASE_URL']

def get_latest_def14a_url(cik):
    """Fetch the latest DEF 14A filing URL for a company"""
    try:
        # SEC EDGAR API endpoint
        url = f"https://data.sec.gov/submissions/CIK{cik.zfill(10)}.json"
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        data = response.json()
        
        # Find latest DEF 14A filing
        filings = data.get('filings', {}).get('recent', {})
        forms = filings.get('form', [])
        accession_numbers = filings.get('accessionNumber', [])
        filing_dates = filings.get('filingDate', [])
        
        for i, form in enumerate(forms):
            if form == 'DEF 14A':
                accession = accession_numbers[i].replace('-', '')
                return f"https://www.sec.gov/Archives/edgar/{cik.zfill(10)}/{accession}/{accession_numbers[i]}-index.html", filing_dates[i]
        
        return None, None
    except Exception as e:
        print(f"Error fetching DEF 14A URL for CIK {cik}: {e}")
        return None, None

def extract_exec_comp_from_def14a(url, cik, ticker):
    """Parse DEF 14A HTML and extract executive compensation"""
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        soup = BeautifulSoup(response.content, 'html.parser')
        
        # Find all tables
        tables = soup.find_all('table')
        executives = []
        
        for table in tables:
            rows = table.find_all('tr')
            if len(rows) < 2:
                continue
            
            # Look for compensation table headers
            headers = [th.get_text(strip=True).lower() for th in rows[0].find_all(['th', 'td'])]
            
            if not any(x in ' '.join(headers) for x in ['name', 'compensation', 'salary']):
                continue
            
            # Parse rows
            for row in rows[1:]:
                cells = [td.get_text(strip=True) for td in row.find_all(['td', 'th'])]
                if len(cells) < 3:
                    continue
                
                exec_name = cells[0] if cells else None
                position = cells[1] if len(cells) > 1 else None
                total_comp_str = cells[2] if len(cells) > 2 else None
                
                if exec_name and total_comp_str:
                    # Clean up total comp (remove $, commas)
                    total_comp = re.sub(r'[^\d.]', '', total_comp_str)
                    try:
                        total_comp = float(total_comp) if total_comp else 0
                        executives.append({
                            'name': exec_name,
                            'position': position or 'N/A',
                            'total_comp': total_comp
                        })
                    except:
                        pass
        
        return executives
    
    except Exception as e:
        print(f"Error parsing DEF 14A for {ticker}: {e}")
        return []

def fetch_and_store_exec_comp():
    """Fetch all executive compensation and store in DB"""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        cur = conn.cursor()
        
        # Get tracked companies
        cur.execute('SELECT ticker, cik FROM tracked_companies')
        companies = cur.fetchall()
        
        for ticker, cik in companies:
            print(f"\nFetching DEF 14A for {ticker} (CIK: {cik})...")
            
            def14a_url, filing_date = get_latest_def14a_url(cik)
            if not def14a_url:
                print(f"  No DEF 14A found for {ticker}")
                continue
            
            print(f"  Found: {def14a_url}")
            
            # Get document URL (strip index.html, add def14a.htm)
            base_url = def14a_url.rsplit('/', 1)[0]
            doc_url = f"{base_url}/def14a.htm"
            
            executives = extract_exec_comp_from_def14a(doc_url, cik, ticker)
            
            if executives:
                print(f"  Extracted {len(executives)} executives")
                
                for exec in executives:
                    try:
                        cur.execute('''
                            INSERT INTO executive_compensation 
                            (cik, ticker, executive_name, position, fiscal_year, total_comp, fetched_at)
                            VALUES (%s, %s, %s, %s, %s, %s, NOW())
                            ON CONFLICT (cik, ticker, executive_name, fiscal_year) 
                            DO UPDATE SET total_comp = %s, fetched_at = NOW()
                        ''', (
                            cik, ticker, exec['name'], exec['position'], 
                            datetime.now().year, exec['total_comp'], exec['total_comp']
                        ))
                    except Exception as e:
                        print(f"    Error inserting {exec['name']}: {e}")
                
                conn.commit()
                print(f"  Stored in DB")
            else:
                print(f"  No compensation data found")
        
        cur.close()
        conn.close()
        print("\n✅ DEF 14A fetch complete")
    
    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == '__main__':
    fetch_and_store_exec_comp()
