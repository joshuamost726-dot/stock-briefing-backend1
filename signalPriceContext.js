/**
 * signalPriceContext.js
 *
 * Shared helper for the two signals that have a real per-share price point
 * (insiderScore.js's Form 4 transactionPricePerShare, convictionScore.js's
 * implied 13F value/shares average) — computes how that price compares to
 * the user's own cost basis, when they have a position tracked.
 *
 * DESIGN NOTE: this only computes the comparison FACTS (prices, % gap,
 * direction) — it deliberately does not decide what the comparison MEANS.
 * That reasoning belongs to signalExplainer.js (Claude, given these facts
 * plus the rest of the signal's detail) and aiTakeScore.js, since "smart
 * money paid more than you" and "smart money paid less than you" both cut
 * multiple ways depending on timing and magnitude — this module just
 * supplies the numbers honestly, including for the 13F case where the
 * "price" is an approximation (quarter-end value/shares), never a real
 * transaction price, and says so.
 */

const SIMILAR_BAND_PCT = 3;

function buildPositionContext(signalPrice, position, { approximate = false } = {}) {
  if (signalPrice == null || !position || !position.costPerShare) return null;

  const costBasis = position.costPerShare;
  const pctDifference = ((signalPrice - costBasis) / costBasis) * 100;
  const direction = pctDifference > SIMILAR_BAND_PCT ? 'above'
    : pctDifference < -SIMILAR_BAND_PCT ? 'below'
    : 'similar';

  return {
    signalPrice,
    userCostBasis: costBasis,
    pctDifference,
    direction,
    approximate,
  };
}

module.exports = { buildPositionContext };
