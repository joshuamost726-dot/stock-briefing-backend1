/**
 * shortInterestScore.js
 *
 * Short Interest signal, scored against Nasdaq-sourced FINRA settlement data.
 *
 * DESIGN NOTE: short interest alone is ambiguous — rising short interest can
 * mean growing bearish conviction OR a building short-squeeze setup,
 * depending on days-to-cover. This function scores the SIGNAL STRENGTH
 * (how meaningful the recent move is) and separately reports DIRECTION,
 * rather than collapsing both into one number that hides which way it's
 * pointing. The plain-English explanation always states direction explicitly.
 */

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function getShortInterestSignal(ticker) {
  const { rows } = await pool.query(
    `SELECT settlement_date, short_interest_shares, avg_daily_share_volume, days_to_cover
       FROM short_interest
      WHERE ticker = $1
      ORDER BY settlement_date DESC
      LIMIT 6`,
    [ticker]
  );

  if (rows.length === 0) {
    return {
      ticker,
      confidenceScore: 0,
      hasSignal: false,
      label: 'No Data',
      explanation: `No short interest data on file for ${ticker}.`,
      detail: {},
    };
  }

  if (rows.length < 2) {
    return {
      ticker,
      confidenceScore: 0,
      hasSignal: false,
      label: 'Insufficient History',
      explanation: `Only one settlement period on file for ${ticker} — need at least two to measure direction.`,
      detail: { periodsAvailable: rows.length },
    };
  }

  const latest = rows[0];
  const prior = rows[1];

  const latestShares = Number(latest.short_interest_shares);
  const priorShares = Number(prior.short_interest_shares);
  const pctChange = ((latestShares - priorShares) / priorShares) * 100;
  const direction = pctChange > 0 ? 'increasing' : pctChange < 0 ? 'decreasing' : 'flat';

  const daysToCover = Number(latest.days_to_cover) || 0;

  // --- Magnitude: how large is the period-over-period move? ---
  const absChange = Math.abs(pctChange);
  let magnitudeScore;
  if (absChange >= 20) magnitudeScore = 90;
  else if (absChange >= 10) magnitudeScore = 70;
  else if (absChange >= 5) magnitudeScore = 50;
  else magnitudeScore = 25;

  // --- Days to cover: higher = more friction for shorts to exit, raises stakes either direction ---
  let coverScore;
  if (daysToCover >= 10) coverScore = 90;
  else if (daysToCover >= 5) coverScore = 70;
  else if (daysToCover >= 2) coverScore = 50;
  else coverScore = 25;

  // --- Trend consistency: is this move part of a multi-period trend, or a one-off blip? ---
  let trendScore = 40;
  let trendNote = 'single-period move, no confirmed trend yet';
  if (rows.length >= 4) {
    const changes = [];
    for (let i = 0; i < 3; i++) {
      const a = Number(rows[i].short_interest_shares);
      const b = Number(rows[i + 1].short_interest_shares);
      changes.push(a - b);
    }
    const sameDirection = changes.every(c => (c > 0) === (changes[0] > 0));
    if (sameDirection) {
      trendScore = 80;
      trendNote = `consistent ${direction} trend across last ${changes.length + 1} periods`;
    } else {
      trendNote = 'direction has reversed recently — not a clean trend';
    }
  }

  const confidenceScore = Math.round(
    magnitudeScore * 0.40 + coverScore * 0.30 + trendScore * 0.30
  );

  let label;
  if (confidenceScore >= 75) label = 'Strong Signal';
  else if (confidenceScore >= 50) label = 'Moderate Signal';
  else label = 'Weak / Likely Noise';

  const explanation =
    `Short interest ${direction} ${absChange.toFixed(1)}% period-over-period ` +
    `(${Math.round(priorShares).toLocaleString()} → ${Math.round(latestShares).toLocaleString()} shares as of ${latest.settlement_date}). ` +
    `Days to cover: ${daysToCover.toFixed(1)}. Trend: ${trendNote}. ` +
    (direction === 'increasing'
      ? 'Rising short interest can reflect growing bearish conviction, or set up a squeeze if the stock rallies against crowded shorts.'
      : 'Falling short interest suggests shorts are covering — reducing bearish pressure, though this alone doesn\'t confirm bullish conviction.');

  return {
    ticker,
    confidenceScore,
    hasSignal: true,
    label,
    direction,
    explanation,
    detail: {
      latestShares,
      priorShares,
      pctChange,
      daysToCover,
      magnitudeScore,
      coverScore,
      trendScore,
      settlementDate: latest.settlement_date,
    },
  };
}

module.exports = { getShortInterestSignal };
