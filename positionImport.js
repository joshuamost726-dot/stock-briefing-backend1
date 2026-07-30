/**
 * positionImport.js
 *
 * Parses a CSV a user exports from a brokerage (Robinhood has no official
 * API — this is the safe, credential-free alternative: the user downloads
 * their own export and uploads it here, nothing is shared with the brokerage
 * or logged in). Hand-rolled CSV parsing, matching this codebase's existing
 * preference for no external library over a small utility (see PriceChart.js,
 * CategoryIcon.jsx) — RFC4180-ish, handles quoted fields with embedded
 * commas/escaped quotes, which a naive split(',') would break on.
 *
 * Two CSV shapes are supported, auto-detected from the header row:
 *   - "positions": one row per current holding — ticker, share count, and a
 *     cost-per-share column directly. (E*TRADE's own positions export looks
 *     like this, and it's the simplest case.)
 *   - "transactions": one row per historical trade (Robinhood's real account
 *     statement export — Instrument/Trans Code/Quantity/Price/date columns,
 *     no direct "current position" line at all). Current shares and cost
 *     basis are derived by replaying every Buy/Sell in chronological order
 *     using the average-cost method — the same method Robinhood itself uses
 *     by default, so the result should match what the app shows.
 *
 * Never writes anything — callers get back a reviewable list the user
 * confirms before any of it touches tracked_companies (see
 * POST /api/positions/apply in stock-briefing-backend.js).
 */

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

function normalizeHeader(h) {
  return h.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').trim();
}

function findColumn(headers, aliases) {
  for (let i = 0; i < headers.length; i++) {
    if (aliases.includes(headers[i])) return i;
  }
  return -1;
}

const TICKER_ALIASES = ['symbol', 'ticker'];
const SHARES_ALIASES = ['quantity', 'shares', 'qty', 'shares owned'];
const COST_ALIASES = ['average cost basis', 'avg cost', 'average cost', 'cost basis', 'price paid', 'avg price', 'cost per share', 'average price'];
const INSTRUMENT_ALIASES = ['instrument', 'symbol', 'ticker'];
const TRANS_CODE_ALIASES = ['trans code', 'transaction type', 'type', 'action'];
const PRICE_ALIASES = ['price', 'price per share'];
const DATE_ALIASES = ['activity date', 'process date', 'settle date', 'date'];

// Only these count as position-affecting trades. Everything else (dividends,
// fees, interest, ACH transfers, name changes, etc.) is silently ignored —
// present in a real statement export, but not relevant to current position.
function classifyTransCode(raw) {
  const v = raw.toLowerCase().trim();
  if (v === 'buy' || v.includes('buy')) return 'buy';
  if (v === 'sell' || v.includes('sell')) return 'sell';
  return null;
}

function isPlausibleTicker(raw) {
  return /^[A-Z]{1,6}(\.[A-Z])?$/.test(raw.trim().toUpperCase());
}

function parseNumber(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[$,]/g, '').replace(/^\((.*)\)$/, '-$1').trim();
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parsePositionsFormat(rows, headers) {
  const tickerCol = findColumn(headers, TICKER_ALIASES);
  const sharesCol = findColumn(headers, SHARES_ALIASES);
  const costCol = findColumn(headers, COST_ALIASES);

  const positions = [];
  const warnings = [];

  for (const row of rows) {
    const ticker = (row[tickerCol] || '').trim().toUpperCase();
    const shares = parseNumber(row[sharesCol]);
    const cost = parseNumber(row[costCol]);

    if (!ticker || !isPlausibleTicker(ticker)) {
      if (ticker) warnings.push(`Skipped row with unrecognized ticker "${ticker}".`);
      continue;
    }
    if (shares == null || shares <= 0 || cost == null || cost <= 0) {
      warnings.push(`Skipped ${ticker}: couldn't read a valid share count and cost from this row.`);
      continue;
    }
    positions.push({ ticker, shares, costPerShare: Math.round(cost * 100) / 100 });
  }

  return { positions, warnings };
}

function parseTransactionsFormat(rows, headers) {
  const instrumentCol = findColumn(headers, INSTRUMENT_ALIASES);
  const transCodeCol = findColumn(headers, TRANS_CODE_ALIASES);
  const quantityCol = findColumn(headers, SHARES_ALIASES);
  const priceCol = findColumn(headers, PRICE_ALIASES);
  const dateCol = findColumn(headers, DATE_ALIASES);

  const warnings = [];

  const trades = rows.map(row => ({
    ticker: (row[instrumentCol] || '').trim().toUpperCase(),
    code: classifyTransCode(row[transCodeCol] || ''),
    quantity: parseNumber(row[quantityCol]),
    price: parseNumber(row[priceCol]),
    date: dateCol >= 0 ? new Date(row[dateCol]) : null,
  })).filter(t => t.code && t.ticker && isPlausibleTicker(t.ticker) && t.quantity > 0 && t.price > 0);

  const datesValid = dateCol >= 0 && trades.length > 0 && trades.every(t => !isNaN(t.date));
  if (datesValid) {
    trades.sort((a, b) => a.date - b.date);
  } else {
    // Statement exports are almost always newest-first with no usable date
    // column for our purposes — reverse as a best-effort guess at
    // chronological order rather than silently trusting file order.
    trades.reverse();
    warnings.push('Could not confirm chronological order from the date column — assumed the file is newest-first (the normal export order) and reversed it. Double-check the resulting cost basis below.');
  }

  const byTicker = {};
  for (const t of trades) {
    const state = (byTicker[t.ticker] ??= { shares: 0, totalCost: 0 });
    if (t.code === 'buy') {
      state.shares += t.quantity;
      state.totalCost += t.quantity * t.price;
    } else {
      if (t.quantity > state.shares + 0.0001) {
        warnings.push(`${t.ticker}: a sell in this file is larger than the shares bought before it — cost basis for this ticker may be incomplete (the file might not cover your full history).`);
      }
      const avgCostBeforeSell = state.shares > 0 ? state.totalCost / state.shares : 0;
      state.shares = Math.max(0, state.shares - t.quantity);
      state.totalCost = Math.max(0, state.totalCost - t.quantity * avgCostBeforeSell);
    }
  }

  const positions = Object.entries(byTicker)
    .filter(([, s]) => s.shares > 0.0001)
    .map(([ticker, s]) => ({
      ticker,
      shares: Math.round(s.shares * 10000) / 10000,
      costPerShare: Math.round((s.totalCost / s.shares) * 100) / 100,
    }));

  return { positions, warnings };
}

function parsePositionsCsv(csvText) {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) {
    return { format: 'unknown', positions: [], warnings: ['File has no data rows.'] };
  }

  const headers = rows[0].map(normalizeHeader);
  const dataRows = rows.slice(1);

  const hasPositionCols = findColumn(headers, TICKER_ALIASES) >= 0
    && findColumn(headers, SHARES_ALIASES) >= 0
    && findColumn(headers, COST_ALIASES) >= 0;

  const hasTransactionCols = findColumn(headers, INSTRUMENT_ALIASES) >= 0
    && findColumn(headers, TRANS_CODE_ALIASES) >= 0
    && findColumn(headers, SHARES_ALIASES) >= 0
    && findColumn(headers, PRICE_ALIASES) >= 0;

  // A direct cost-per-share column is the more reliable read when a file
  // happens to have both shapes of column present — prefer it.
  if (hasPositionCols) {
    return { format: 'positions', ...parsePositionsFormat(dataRows, headers) };
  }
  if (hasTransactionCols) {
    return { format: 'transactions', ...parseTransactionsFormat(dataRows, headers) };
  }
  return {
    format: 'unknown',
    positions: [],
    warnings: [`Couldn't recognize these columns: ${rows[0].join(', ')}. Expected either a ticker/shares/cost-basis export, or a Robinhood-style transaction history (Instrument/Trans Code/Quantity/Price).`],
  };
}

module.exports = { parsePositionsCsv };
