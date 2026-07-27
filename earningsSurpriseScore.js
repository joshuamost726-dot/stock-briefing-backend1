/**
 * earningsSurpriseScore.js
 *
 * Tracks whether a company has a consistent recent track record of beating
 * or missing analyst EPS estimates, using Finnhub's free historical
 * earnings-surprise endpoint (stock/earnings). Replaces the earnings_whisper
 * slot that sat unbuilt since the project's early days — a real "whisper
 * number" has no viable free data source (same dead-end as SEDAR+ for
 * CWBHF), but this is a different, legitimate signal: a transparent beat/
 * miss track record, not a prediction of the next report.
 */

const LOOKBACK_QUARTERS = 4;

function getEarningsSurpriseSignal(earningsHistory) {
  if (!earningsHistory || earningsHistory.length === 0) return null;

  const quarters = earningsHistory
    .filter(q => q.actual != null && q.estimate != null && q.surprisePercent != null)
    .slice(0, LOOKBACK_QUARTERS);

  if (quarters.length === 0) return null;

  const beats = quarters.filter(q => q.surprisePercent > 0).length;
  const misses = quarters.filter(q => q.surprisePercent < 0).length;
  const total = quarters.length;
  const beatPct = Math.round((beats / total) * 100);

  const avgSurprisePct = quarters.reduce((sum, q) => sum + q.surprisePercent, 0) / total;

  // Beat frequency alone can mislabel a genuinely mixed record — e.g. 3 of 4
  // quarters beaten but one severe miss drags the average negative isn't a
  // clean "positive," it's a real volatility flag. Require the average to
  // agree with the frequency before calling it positive/negative; otherwise
  // it's neutral regardless of how many quarters were individually beaten.
  const status = (beatPct >= 75 && avgSurprisePct >= 0)
    ? 'positive'
    : (beatPct <= 25 || avgSurprisePct < -5)
    ? 'negative'
    : 'neutral';

  const quarterSummary = quarters
    .map(q => `${q.period}: ${q.surprisePercent >= 0 ? '+' : ''}${q.surprisePercent.toFixed(1)}%`)
    .join(', ');

  return {
    score: beatPct,
    status,
    headline: beats === total
      ? `Beat estimates in all ${total} recent quarters`
      : misses === total
      ? `Missed estimates in all ${total} recent quarters`
      : `Beat estimates in ${beats} of ${total} recent quarters`,
    detail: `Average surprise: ${avgSurprisePct >= 0 ? '+' : ''}${avgSurprisePct.toFixed(1)}% vs. estimate. Recent quarters — ${quarterSummary}.`,
    validation: {
      timing: `Most recent quarter: ${quarters[0].period}. Earnings surprises are backward-looking, not predictive of the next report.`,
      scaleVsSalary: 'Not applicable to earnings surprise data.',
      trackRecord: `${total} quarter(s) on file — a longer track record is a stronger signal.`,
      corroboration: total >= 4
        ? 'At least a full year of quarters on file.'
        : `Only ${total} quarter(s) on file — thin sample.`
    },
    freshness: {
      lastChecked: null,
      schedule: 'Fetched live every time this page loads'
    }
  };
}

module.exports = { getEarningsSurpriseSignal };
