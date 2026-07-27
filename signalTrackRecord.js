/**
 * signalTrackRecord.js
 *
 * Backtests whether past buy/increase events for a signal type actually
 * preceded a positive subsequent stock return, using this app's own
 * accumulated daily_prices history. Answers the "No data available —
 * requires accumulated history of past X vs subsequent price moves"
 * placeholder several signal cards' Track Record field used to show
 * verbatim, now that real history has actually accumulated (daily_prices
 * has been collecting since the Technical Momentum signal was built).
 *
 * Deliberately measures against the STOCK'S OWN subsequent price move (via
 * daily_prices), not each signal's own reported transaction price, so the
 * methodology is identical and comparable across insider buying,
 * congressional trading, and Korea ownership changes — three signal types
 * with real per-event dates but very different (or no) price fields of
 * their own.
 *
 * Coverage caveat: daily_prices only goes back to when this app started
 * collecting it (~1 year). Older events (e.g. congressional trades from
 * 2015) are silently skipped as not computable, not counted as misses —
 * only events with BOTH an entry price and a price ~holdingDays later are
 * included in the sample.
 */

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const MIN_SAMPLE_SIZE = 3;
const HOLDING_DAYS = 30;

function toIsoDate(v) {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

// Finds the first daily_prices row on/after isoDate — but only if it's
// actually close by (within maxLagDays). Without this cap, an event dated
// years before daily_prices' coverage window began (e.g. a 2014
// congressional trade) would silently match the EARLIEST row in the whole
// table as if that were the price right after the event, quietly
// collapsing dozens of unrelated old events onto one shared, meaningless
// outcome instead of being correctly excluded as not computable.
function priceOnOrAfter(prices, isoDate, maxLagDays = 7) {
  const match = prices.find(p => p.date >= isoDate);
  if (!match) return null;
  const lagDays = (new Date(match.date) - new Date(isoDate)) / 86400000;
  return lagDays <= maxLagDays ? match : null;
}

function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function getDailyPrices(ticker) {
  const { rows } = await pool.query(
    `SELECT trade_date, close FROM daily_prices WHERE ticker = $1 ORDER BY trade_date ASC`,
    [ticker]
  );
  return rows.map(r => ({ date: toIsoDate(r.trade_date), close: Number(r.close) }));
}

function backtest(eventDates, prices) {
  const outcomes = [];
  for (const eventDate of eventDates) {
    const entry = priceOnOrAfter(prices, eventDate);
    if (!entry) continue;
    const exit = priceOnOrAfter(prices, addDays(entry.date, HOLDING_DAYS));
    if (!exit || exit.date === entry.date) continue;
    outcomes.push((exit.close - entry.close) / entry.close);
  }

  if (outcomes.length < MIN_SAMPLE_SIZE) return null;

  const hits = outcomes.filter(r => r > 0).length;
  const avgReturn = outcomes.reduce((a, b) => a + b, 0) / outcomes.length;

  return {
    sampleSize: outcomes.length,
    hitRate: Math.round((hits / outcomes.length) * 100),
    avgReturnPct: Number((avgReturn * 100).toFixed(1)),
    holdingDays: HOLDING_DAYS,
  };
}

async function getInsiderBuyingTrackRecord(ticker) {
  try {
    const [{ rows }, prices] = await Promise.all([
      pool.query(
        `SELECT transaction_date FROM insider_transactions
          WHERE ticker = $1 AND transaction_type = 'P'
          ORDER BY transaction_date ASC`,
        [ticker]
      ),
      getDailyPrices(ticker),
    ]);
    return backtest(rows.map(r => toIsoDate(r.transaction_date)), prices);
  } catch (err) {
    console.error(`Insider buying track record failed for ${ticker}:`, err);
    return null;
  }
}

async function getCongressTradingTrackRecord(ticker) {
  try {
    const [{ rows }, prices] = await Promise.all([
      pool.query(
        `SELECT transaction_date FROM congress_trades
          WHERE ticker = $1 AND transaction_type = 'Purchase'
          ORDER BY transaction_date ASC`,
        [ticker]
      ),
      getDailyPrices(ticker),
    ]);
    return backtest(rows.map(r => toIsoDate(r.transaction_date)), prices);
  } catch (err) {
    console.error(`Congressional trading track record failed for ${ticker}:`, err);
    return null;
  }
}

async function getKoreaOwnershipTrackRecord(ticker) {
  try {
    const [{ rows }, prices] = await Promise.all([
      pool.query(
        `SELECT filing_date FROM korea_ownership_changes
          WHERE ticker = $1 AND shares_change > 0
          ORDER BY filing_date ASC`,
        [ticker]
      ),
      getDailyPrices(ticker),
    ]);
    return backtest(rows.map(r => toIsoDate(r.filing_date)), prices);
  } catch (err) {
    console.error(`Korea ownership track record failed for ${ticker}:`, err);
    return null;
  }
}

module.exports = { getInsiderBuyingTrackRecord, getCongressTradingTrackRecord, getKoreaOwnershipTrackRecord };
