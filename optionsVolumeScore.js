/**
 * optionsVolumeScore.js
 *
 * Options Call Volume signal, scored against daily Yahoo Finance snapshots
 * of the nearest-expiration options chain.
 *
 * DESIGN NOTE: a single day's call volume tells you nothing on its own —
 * you need a baseline to know if today is "unusual." This function requires
 * at least 5 trading days of history before it will score anything, and
 * says so plainly rather than guessing from one data point. The call/put
 * ratio is reported alongside the volume trend, since a volume spike paired
 * with heavy call skew is a stronger signal than either alone.
 */

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const MIN_HISTORY_DAYS = 5;

async function getOptionsVolumeSignal(ticker) {
  const { rows } = await pool.query(
    `SELECT snapshot_date, call_volume, put_volume, call_open_interest, put_open_interest
       FROM options_volume
      WHERE ticker = $1
      ORDER BY snapshot_date DESC
      LIMIT 20`,
    [ticker]
  );

  if (rows.length === 0) {
    return {
      ticker,
      confidenceScore: 0,
      hasSignal: false,
      label: 'No Data',
      explanation: `No options volume data on file for ${ticker}.`,
      detail: {},
    };
  }

  if (rows.length < MIN_HISTORY_DAYS) {
    return {
      ticker,
      confidenceScore: 0,
      hasSignal: false,
      label: 'Building History',
      explanation:
        `Only ${rows.length} trading day(s) of options data on file for ${ticker} — ` +
        `need at least ${MIN_HISTORY_DAYS} to judge whether today's volume is unusual. ` +
        `This signal will activate automatically as daily snapshots accumulate.`,
      detail: { daysAvailable: rows.length, daysNeeded: MIN_HISTORY_DAYS },
    };
  }

  const today = rows[0];
  const history = rows.slice(1); // everything except today, used as baseline

  const avgCallVolume = average(history.map(r => Number(r.call_volume)));
  const todayCallVolume = Number(today.call_volume);
  const volumeRatio = avgCallVolume > 0 ? todayCallVolume / avgCallVolume : 0;

  const todayPutVolume = Number(today.put_volume) || 0;
  const callPutRatio = todayPutVolume > 0 ? todayCallVolume / todayPutVolume : todayCallVolume;

  // --- Magnitude: how far above/below normal is today's call volume? ---
  let volumeScore;
  if (volumeRatio >= 3) volumeScore = 90;
  else if (volumeRatio >= 2) volumeScore = 70;
  else if (volumeRatio >= 1.5) volumeScore = 50;
  else volumeScore = 25;

  // --- Skew: how call-heavy is today vs a "normal" balanced ~1:1 ratio? ---
  let skewScore;
  if (callPutRatio >= 3) skewScore = 90;
  else if (callPutRatio >= 2) skewScore = 70;
  else if (callPutRatio >= 1.3) skewScore = 50;
  else skewScore = 25;

  const confidenceScore = Math.round(volumeScore * 0.6 + skewScore * 0.4);

  let label;
  if (confidenceScore >= 75) label = 'Unusual Activity';
  else if (confidenceScore >= 50) label = 'Moderate Activity';
  else label = 'Normal / Baseline Activity';

  const explanation =
    `Call volume today: ${Math.round(todayCallVolume).toLocaleString()} ` +
    `(${volumeRatio.toFixed(1)}x the ${history.length}-day average of ${Math.round(avgCallVolume).toLocaleString()}). ` +
    `Call/put ratio: ${callPutRatio.toFixed(1)}:1. ` +
    (volumeRatio >= 2 && callPutRatio >= 2
      ? 'Both volume and call skew are elevated — worth a closer look.'
      : volumeRatio >= 2
      ? 'Volume is elevated, but call/put skew is not unusually one-sided.'
      : callPutRatio >= 2
      ? 'Call/put skew is elevated, but overall volume is within normal range.'
      : 'Both volume and skew are within normal range for this ticker.');

  return {
    ticker,
    confidenceScore,
    hasSignal: true,
    label,
    explanation,
    detail: {
      todayCallVolume,
      todayPutVolume,
      avgCallVolume,
      volumeRatio,
      callPutRatio,
      volumeScore,
      skewScore,
      daysOfHistory: history.length,
      lastChecked: today.snapshot_date,
    },
  };
}

function average(nums) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

module.exports = { getOptionsVolumeSignal };
