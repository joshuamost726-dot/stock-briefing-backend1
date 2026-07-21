/**
 * insiderScore.js
 *
 * Insider Buying signal, scored against Form 4 filings.
 *
 * DESIGN NOTE: most Form 4 activity is routine SELLING (10b5-1 scheduled
 * plans, tax withholding, option exercises) and carries no directional
 * signal. Only open-market BUYS ('P') represent genuine discretionary
 * conviction. Sells are stored and surfaced as context but are never
 * scored. If no buy exists, this function returns confidenceScore 0 and
 * says so plainly rather than inventing a number from sell-only data.
 */

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const BUY_CODE = 'P';
const SELL_CODE = 'S';

async function getInsiderBuyingSignal(ticker) {
  const { rows: transactions } = await pool.query(
    `SELECT insider_name, position, transaction_date, transaction_type,
            shares, price_per_share, value_usd, filed_at
       FROM insider_transactions
      WHERE ticker = $1
      ORDER BY transaction_date DESC`,
    [ticker]
  );

  const { rows: freshnessRows } = await pool.query(
    `SELECT MAX(fetched_at) AS last_checked FROM insider_transactions WHERE ticker = $1`,
    [ticker]
  );
  const lastChecked = freshnessRows[0]?.last_checked || null;

  if (transactions.length === 0) {
    return {
      ticker,
      confidenceScore: 0,
      hasSignal: false,
      label: 'No Data',
      explanation: `No Form 4 filings on file for ${ticker}.`,
      detail: { buyCount: 0, sellCount: 0, lastChecked },
    };
  }

  const buys = transactions.filter(t => t.transaction_type === BUY_CODE);
  const sells = transactions.filter(t => t.transaction_type === SELL_CODE);

  if (buys.length === 0) {
    return {
      ticker,
      confidenceScore: 0,
      hasSignal: false,
      label: 'No Buy Signal',
      explanation:
        `${sells.length} routine sell(s) on file, no buys. Sell activity alone ` +
        `is not scored — insiders sell for many routine reasons (10b5-1 plans, ` +
        `tax withholding, diversification) that carry no directional signal. ` +
        `This signal activates only when a genuine open-market buy appears.`,
      detail: { buyCount: 0, sellCount: sells.length, lastChecked },
    };
  }

  const { rows: compRows } = await pool.query(
    `SELECT executive_name, total_comp, salary
       FROM executive_compensation
      WHERE ticker = $1
      ORDER BY fiscal_year DESC`,
    [ticker]
  );
  const compByName = {};
  for (const row of compRows) {
    if (!(row.executive_name in compByName)) {
      compByName[row.executive_name] = row;
    }
  }

  const scoredBuys = buys.map(buy => scoreBuy(buy, compByName));
  const avgScale = average(scoredBuys.map(b => b.scaleScore));
  const timingScore = scoreTiming(buys);
  const corroborationScore = scoreCorroboration(buys);

  const confidenceScore = Math.round(
    clamp(avgScale * 0.50 + corroborationScore * 0.30 + timingScore * 0.20, 0, 100)
  );

  const distinctBuyers = new Set(buys.map(b => b.insider_name)).size;
  const totalBuyValue = buys.reduce((sum, b) => sum + (Number(b.value_usd) || 0), 0);

  let label;
  if (confidenceScore >= 80) label = 'High Conviction';
  else if (confidenceScore >= 50) label = 'Moderate Conviction';
  else label = 'Low Conviction / Possible Noise';

  let explanation = `${buys.length} insider buy(s) from ${distinctBuyers} insider(s), ` +
    `$${Math.round(totalBuyValue).toLocaleString()} total. ` +
    scoredBuys.map(b => b.note).join(' ');

  if (distinctBuyers >= 2) {
    explanation += ' Multiple insiders bought in the same window — corroborated.';
  } else {
    explanation += ' Only one insider bought — no corroboration from others yet.';
  }

  if (sells.length > 0) {
    explanation += ` (${sells.length} routine sell(s) also on file — not scored.)`;
  }

  return {
    ticker,
    confidenceScore,
    hasSignal: true,
    label,
    explanation,
    detail: {
      buyCount: buys.length,
      sellCount: sells.length,
      distinctBuyers,
      totalBuyValue,
      avgScale,
      timingScore,
      corroborationScore,
      lastChecked,
    },
  };
}

function scoreBuy(buy, compByName) {
  const comp = compByName[buy.insider_name];
  const value = Number(buy.value_usd) || 0;

  if (!comp || !comp.total_comp) {
    return {
      scaleScore: 40,
      note: `${buy.insider_name} bought $${Math.round(value).toLocaleString()} — ` +
            `no compensation data on file to gauge scale vs. salary.`,
    };
  }

  const pctOfComp = (value / Number(comp.total_comp)) * 100;

  let scaleScore;
  if (pctOfComp >= 100) scaleScore = 95;
  else if (pctOfComp >= 50) scaleScore = 85;
  else if (pctOfComp >= 20) scaleScore = 70;
  else if (pctOfComp >= 5) scaleScore = 55;
  else scaleScore = 35;

  return {
    scaleScore,
    note: `${buy.insider_name} bought $${Math.round(value).toLocaleString()} ` +
          `(~${pctOfComp.toFixed(0)}% of their reported total compensation).`,
  };
}

function scoreTiming(buys) {
  const mostRecent = buys.map(b => new Date(b.transaction_date)).sort((a, b) => b - a)[0];
  const daysAgo = (Date.now() - mostRecent.getTime()) / (1000 * 60 * 60 * 24);

  if (daysAgo <= 7) return 90;
  if (daysAgo <= 14) return 70;
  if (daysAgo <= 30) return 50;
  return 30;
}

function scoreCorroboration(buys) {
  const distinctBuyers = new Set(buys.map(b => b.insider_name)).size;
  if (distinctBuyers >= 3) return 90;
  if (distinctBuyers === 2) return 70;
  return 40;
}

function average(nums) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

module.exports = { getInsiderBuyingSignal };
