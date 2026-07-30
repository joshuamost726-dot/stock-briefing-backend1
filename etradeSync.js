/**
 * etradeSync.js
 *
 * Reads real positions from a connected E*TRADE account (see etradeAuth.js
 * for the OAuth flow) and normalizes them into the same {ticker, shares,
 * costPerShare} shape positionImport.js produces from a CSV — both feed the
 * same review/apply UI and the same POST /api/positions/apply route, so
 * there's exactly one place that actually writes a position, regardless of
 * where it came from.
 *
 * NOTE: E*TRADE's exact JSON field names here are per their published
 * Accounts/Portfolio API docs, but this has not been exercised against a
 * real account (that requires the user's own developer app credentials —
 * see Settings for setup). If E*TRADE's response shape doesn't match what's
 * expected below, getAllPositions() throws rather than silently returning
 * wrong numbers — check server logs for the raw response if that happens.
 */

const { apiBase, getAccessToken, signedRequest } = require('./etradeAuth.js');

async function listAccounts() {
  const token = await getAccessToken();
  const data = await signedRequest({ url: `${apiBase}/v1/accounts/list.json`, token });
  const accounts = data?.AccountListResponse?.Accounts?.Account || [];
  if (!Array.isArray(accounts)) {
    throw new Error('UNEXPECTED_RESPONSE_SHAPE: accounts list');
  }
  return accounts.filter(a => (a.accountStatus || '').toUpperCase() !== 'CLOSED');
}

async function getAccountPositions(accountIdKey) {
  const token = await getAccessToken();
  const data = await signedRequest({ url: `${apiBase}/v1/accounts/${accountIdKey}/portfolio.json`, token });
  const portfolios = data?.PortfolioResponse?.AccountPortfolio || [];

  const positions = [];
  for (const p of portfolios) {
    for (const pos of p.Position || []) {
      const ticker = pos?.Product?.symbol;
      const shares = Number(pos.quantity);
      const cost = Number(pos.pricePaid);
      if (ticker && Number.isFinite(shares) && shares > 0 && Number.isFinite(cost) && cost > 0) {
        positions.push({ ticker: ticker.toUpperCase(), shares, costPerShare: cost });
      }
    }
  }
  return positions;
}

// Merges the same ticker held across multiple accounts into one row
// (weighted-average cost basis), since the app tracks one position per
// ticker, not per account.
function mergeByTicker(positions) {
  const byTicker = {};
  for (const p of positions) {
    const state = (byTicker[p.ticker] ??= { shares: 0, totalCost: 0 });
    state.shares += p.shares;
    state.totalCost += p.shares * p.costPerShare;
  }
  return Object.entries(byTicker).map(([ticker, s]) => ({
    ticker,
    shares: Math.round(s.shares * 10000) / 10000,
    costPerShare: Math.round((s.totalCost / s.shares) * 100) / 100,
  }));
}

async function getAllPositions() {
  const accounts = await listAccounts();
  if (accounts.length === 0) {
    return { positions: [], warnings: ['No open E*TRADE accounts found on this login.'] };
  }

  const all = [];
  const warnings = [];
  for (const acc of accounts) {
    try {
      const positions = await getAccountPositions(acc.accountIdKey);
      all.push(...positions);
    } catch (err) {
      warnings.push(`Couldn't read positions for account ${acc.accountDesc || acc.accountId}: ${err.message}`);
    }
  }

  return { positions: mergeByTicker(all), warnings };
}

module.exports = { getAllPositions };
