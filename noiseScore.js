/**
 * noiseScore.js
 *
 * "Signal vs Noise" reliability badge — not a conviction signal itself,
 * but a meta-read on how much to trust the composite convictionScore.
 *
 * Takes the status ('positive' | 'neutral' | 'negative') of each signal
 * that actually contributed to the composite score (i.e. was active),
 * and returns a badge + plain-English explanation of how reliable that
 * composite score actually is.
 */

function getNoiseScore(activeStatuses) {
  const total = 6; // total possible signals
  const activeCount = activeStatuses.length;

  const positiveCount = activeStatuses.filter(s => s === 'positive').length;
  const negativeCount = activeStatuses.filter(s => s === 'negative').length;

  if (activeCount === 0) {
    return {
      badge: 'No Data',
      explanation: `0 of ${total} signals active. There is no evidence basis for a score yet.`,
    };
  }

  if (activeCount === 1) {
    return {
      badge: 'Low Reliability',
      explanation:
        `Only 1 of ${total} signals active, with no corroboration from any other source. ` +
        `This score is a single data point, not a conviction call — treat it with real caution.`,
    };
  }

  const disagrees = positiveCount > 0 && negativeCount > 0;

  if (disagrees) {
    return {
      badge: 'Signals Disagree',
      explanation:
        `${activeCount} of ${total} signals active, but they disagree — ${positiveCount} lean bullish, ` +
        `${negativeCount} lean bearish. The blended score above is an average that hides this disagreement. ` +
        `Look at the individual signals before trusting the composite number.`,
    };
  }

  if (activeCount >= 4) {
    return {
      badge: 'High Reliability',
      explanation:
        `${activeCount} of ${total} signals active and mostly pointing the same direction. ` +
        `This score reflects broad, corroborated evidence — not a single data point.`,
    };
  }

  return {
    badge: 'Moderate Reliability',
    explanation:
      `${activeCount} of ${total} signals active, generally agreeing. There's real evidence here, but ` +
      `half the picture is still missing — treat this as directional, not definitive.`,
  };
}

module.exports = { getNoiseScore };
