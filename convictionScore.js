/**
 * convictionScore.js
 *
 * Institutional Buying signal, scored against full 13F sweep data.
 *
 * DESIGN NOTE: a single quarter of 13F data shows who OWNS a stock,
 * not who is BUYING it. Ownership is not conviction. Until two sweeps
 * exist and pct_change is populated, this function caps its score at
 * MAX_SCORE_WITHOUT_MOMENTUM and never returns a high-conviction label.
 * That is deliberate: the tool should say "I cannot tell yet" rather
 * than dress up an ownership snapshot as a buy signal.
 *
 * POSITION CONTEXT: 13F filings don't report a transaction price — only
 * total dollar value and share count at quarter-end. Dividing the two
 * gives an IMPLIED average price across all reporting holders, which is
 * a real approximation (blends old and new positions, and is stale by up
 * to 45 days), not an actual trade price the way Form 4 is. Always
 * labeled `approximate: true` downstream so it's never presented with
 * false precision.
 */

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { buildPositionContext } = require('./signalPriceContext.js');

const TOP_TIER_FUNDS = [
  'BERKSHIRE HATHAWAY',
  'RENAISSANCE TECHNOLOGIES',
  'BAUPOST',
  'THIRD POINT',
  'TIGER GLOBAL',
  'LONE PINE',
  'VIKING GLOBAL',
  'COATUE',
  'APPALOOSA',
  'PERSHING SQUARE',
];

// Below this many holders, concentration is a liquidity artifact,
// not evidence of deliberate positioning.
const MIN_HOLDERS_FOR_CONCENTRATION = 20;

// Ceiling applied when quarter-over-quarter change is unavailable.
const MAX_SCORE_WITHOUT_MOMENTUM = 60;

function labelFor(score, momentumAvailable) {
  if (!momentumAvailable) {
    return { multiplier: 0.8, label: 'Ownership Only — Conviction Unmeasured' };
  }
  if (score >= 80) return { multiplier: 1.3, label: 'High Conviction' };
  if (score >= 50) return { multiplier: 1.0, label: 'Moderate Conviction' };
  if (score >= 20) return { multiplier: 0.7, label: 'Low Conviction / Possible Noise' };
  return { multiplier: 0.4, label: 'Likely Noise' };
}

async function getInstitutionalBuyingSignal(ticker, position = null) {
  const { rows } = await pool.query(
    `SELECT fund_name, shares_held, value_usd, pct_change, filing_period
       FROM institutional_holdings
      WHERE ticker = $1
        AND filing_period = (
          SELECT MAX(filing_period) FROM institutional_holdings WHERE ticker = $1
        )
      ORDER BY value_usd DESC NULLS LAST`,
    [ticker]
  );

  if (rows.length === 0) {
    return {
      ticker,
      confidenceScore: 0,
      multiplier: 0,
      label: 'No Data',
      momentumAvailable: false,
      explanation: `No institutional holdings on file for ${ticker}.`,
      detail: { holderCount: 0 },
    };
  }

  const holderCount = rows.length;
  const rawPeriod = rows[0].filing_period;
  const period = rawPeriod instanceof Date
    ? rawPeriod.toISOString().slice(0, 10)
    : String(rawPeriod).slice(0, 10);

  // --- Breadth: log-scaled holder count. Context, not conviction. ---
  const breadthScore = Math.min(100, Math.round((Math.log10(holderCount) / 3) * 100));

  // --- Concentration: only meaningful above a minimum holder count ---
  const values = rows.map(r => Number(r.value_usd) || 0);
  const totalValue = values.reduce((a, b) => a + b, 0);
  const top10Value = values.slice(0, 10).reduce((a, b) => a + b, 0);
  const top10Pct = totalValue > 0 ? (top10Value / totalValue) * 100 : null;

  // Implied average price across all reporting holders — see the
  // POSITION CONTEXT note at the top of this file for why this is an
  // approximation, not a real transaction price.
  const totalShares = rows.reduce((sum, r) => sum + (Number(r.shares_held) || 0), 0);
  const impliedAvgPrice = totalShares > 0 ? totalValue / totalShares : null;
  const positionContext = buildPositionContext(impliedAvgPrice, position, { approximate: true });

  let concentrationScore = 50;
  let concentrationMeaningful = holderCount >= MIN_HOLDERS_FOR_CONCENTRATION;

  if (concentrationMeaningful && top10Pct !== null) {
    if (top10Pct > 70) concentrationScore = 90;
    else if (top10Pct > 50) concentrationScore = 75;
    else if (top10Pct > 30) concentrationScore = 55;
    else concentrationScore = 35;
  }

  // --- Top-tier presence: weak evidence at scale, kept for context ---
  const topTierHolders = rows
    .map(r => (r.fund_name || '').toUpperCase())
    .filter(name => TOP_TIER_FUNDS.some(f => name.includes(f)));
  const hasTopTier = topTierHolders.length > 0;
  const trackRecordScore = hasTopTier ? 80 : 50;

  // --- Momentum: the actual conviction signal ---
  const changes = rows
    .filter(r => r.pct_change !== null)
    .map(r => Number(r.pct_change));

  const momentumAvailable = changes.length > 0;
  let momentumScore = null;
  let increasing = 0;
  let decreasing = 0;

  if (momentumAvailable) {
    increasing = changes.filter(c => c > 0).length;
    decreasing = changes.filter(c => c < 0).length;
    const netPct = (increasing / changes.length) * 100;

    if (netPct > 65) momentumScore = 95;
    else if (netPct > 55) momentumScore = 75;
    else if (netPct > 45) momentumScore = 50;
    else if (netPct > 35) momentumScore = 30;
    else momentumScore = 15;
  }

  // --- Weighted score ---
  let confidenceScore;
  if (momentumAvailable) {
    confidenceScore = Math.round(
      momentumScore * 0.50 +
      concentrationScore * 0.25 +
      breadthScore * 0.15 +
      trackRecordScore * 0.10
    );
  } else {
    const raw = Math.round(
      concentrationScore * 0.40 +
      breadthScore * 0.40 +
      trackRecordScore * 0.20
    );
    confidenceScore = Math.min(raw, MAX_SCORE_WITHOUT_MOMENTUM);
  }

  const { multiplier, label } = labelFor(confidenceScore, momentumAvailable);

  // --- Plain English ---
  let explanation = `${holderCount.toLocaleString()} institutional holder(s) as of ${period}.`;

  if (top10Pct !== null && concentrationMeaningful) {
    explanation += ` Top 10 hold ${top10Pct.toFixed(0)}% of reported value.`;
  } else if (!concentrationMeaningful) {
    explanation += ` Too few holders to read concentration meaningfully.`;
  }

  if (hasTopTier) {
    const names = [...new Set(topTierHolders)].slice(0, 2).join(', ');
    explanation += ` Includes ${names}.`;
  }

  if (momentumAvailable) {
    explanation += ` ${increasing} increased, ${decreasing} decreased vs prior quarter.`;
  } else {
    explanation += ` This is an ownership snapshot, not a buying signal — quarter-over-quarter change requires a second sweep.`;
  }

  if (impliedAvgPrice != null) {
    explanation += ` Implied average price across holders (value ÷ shares, an approximation, not a reported trade price): $${impliedAvgPrice.toFixed(2)}.`;
  }
  if (positionContext) {
    explanation += ` Your cost basis is $${positionContext.userCostBasis.toFixed(2)} — that's ` +
      `${positionContext.direction === 'similar' ? 'a similar price to' : `${Math.abs(positionContext.pctDifference).toFixed(0)}% ${positionContext.direction} the`} implied institutional average.`;
  }

  return {
    ticker,
    confidenceScore,
    multiplier,
    label,
    momentumAvailable,
    explanation,
    detail: {
      holderCount,
      top10Pct,
      totalValue,
      impliedAvgPrice,
      positionContext,
      breadthScore,
      concentrationScore,
      concentrationMeaningful,
      trackRecordScore,
      momentumScore,
      increasing,
      decreasing,
      period,
    },
  };
}

module.exports = { getInstitutionalBuyingSignal };
