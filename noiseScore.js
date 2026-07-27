/**
 * noiseScore.js
 *
 * "Real vs. Noise" verdict — synthesizes the active signals and price
 * target into one plain-English read: is this genuine conviction worth
 * acting on, or noise/incomplete evidence to wait out?
 *
 * badge/headline are classification, not prose — kept fully rule-based so
 * they stay deterministic and auditable (other code keys off exact headline
 * strings). Only the `reasoning` paragraph is optionally rewritten by Claude
 * for better prose; the rule-based sentence is always computed first and
 * used verbatim if ANTHROPIC_API_KEY isn't set or the API call fails.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { parseBulletArray } = require('./claudeBullets.js');
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

function classify({ activeCount, statuses, totalSignals }) {
  const total = totalSignals;
  const positiveCount = statuses.filter(s => s === 'positive').length;
  const negativeCount = statuses.filter(s => s === 'negative').length;
  const disagrees = positiveCount > 0 && negativeCount > 0;

  let badge, headline, reasoning;

  if (activeCount === 0) {
    badge = 'No Data';
    headline = 'NO EVIDENCE YET — NOTHING TO ACT ON';
    reasoning = `No signals are active yet for this ticker. There's nothing here to base a decision on — this isn't a "no" or "yes," it's simply unmeasured.`;
  } else if (activeCount === 1) {
    badge = 'Low Reliability';
    headline = "MOSTLY NOISE — DON'T ACT ON THIS YET";
    reasoning = `Only 1 of ${total} signals is active, with nothing else to corroborate it. This is a single weak data point dressed up as a score — wait for more signals to activate before drawing any conclusion.`;
  } else if (disagrees) {
    badge = 'Signals Disagree';
    headline = 'MIXED SIGNALS — TREAT WITH CAUTION';
    reasoning = `${activeCount} of ${total} signals are active, but they disagree — ${positiveCount} lean bullish, ${negativeCount} lean bearish. This is a genuine conflict in the evidence, not a clean read. Don't trust the blended score alone; weigh the individual signals yourself before acting.`;
  } else if (activeCount >= 4) {
    badge = 'High Reliability';
    headline = 'REAL SIGNAL — WORTH ACTING ON';
    reasoning = `${activeCount} of ${total} signals are active and mostly agree. This is broad, corroborated evidence, not a single data point — worth taking seriously, though no signal set guarantees an outcome.`;
  } else {
    badge = 'Moderate Reliability';
    headline = 'REAL, BUT INCOMPLETE — WATCH CLOSELY';
    reasoning = `${activeCount} of ${total} signals are active and generally agree. There's a real, if incomplete, case here — but half the picture is still missing, so this isn't strong enough to act on aggressively yet.`;
  }

  return { badge, headline, reasoning, positiveCount, negativeCount, disagrees };
}

async function rewriteReasoning({ badge, headline, activeCount, totalSignals, positiveCount, negativeCount, priceTarget, fallback }) {
  const facts = {
    classification: badge,
    activeSignals: activeCount,
    totalSignals,
    bullishSignals: positiveCount,
    bearishSignals: negativeCount,
    priceTarget: priceTarget?.available
      ? {
          upsidePct: Number(priceTarget.upsidePct.toFixed(1)),
          meanTarget: priceTarget.mean,
          numAnalysts: priceTarget.numAnalysts,
        }
      : null,
  };

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 200,
    system:
      'You explain a stock conviction verdict to a retail investor, given only these structured ' +
      'facts — do not add facts not present in the input. Match this voice: plain, direct, ' +
      'conservative about what the evidence supports, willing to say "this isn\'t enough to act on" ' +
      'when true. No hedging filler, no "as an AI". Respond with ONLY a raw JSON array of strings — ' +
      'no markdown code fences, no text before or after it. Each string is exactly ONE short sentence, ' +
      'one idea only — do not chain two thoughts together with a semicolon, em-dash, or "and"; if you ' +
      'have two ideas, that\'s two separate array entries, not one long one. Do not include a leading ' +
      'dash or bullet character in the string itself. Aim for 2-3 bullets. The classification field is ' +
      'fixed and must not be contradicted, only explained.',
    messages: [{ role: 'user', content: JSON.stringify(facts) }],
  });

  const text = message.content.find(b => b.type === 'text')?.text?.trim();
  return parseBulletArray(text, fallback);
}

async function getVerdict({ activeCount, statuses, priceTarget, totalSignals }) {
  const priceTargetAvailable = !!priceTarget?.available;
  let priceTargetSentence = '';
  if (priceTargetAvailable) {
    const direction = priceTarget.upsidePct >= 0 ? 'upside' : 'downside';
    priceTargetSentence = ` Combined with a ${Math.abs(priceTarget.upsidePct).toFixed(1)}% ${direction} to the average analyst price target ($${priceTarget.mean.toFixed(2)} from ${priceTarget.numAnalysts} analysts), this adds context to the picture above.`;
  }

  const { badge, headline, reasoning, positiveCount, negativeCount } = classify({ activeCount, statuses, totalSignals });
  const fallbackReasoning = [reasoning, priceTargetSentence.trim()].filter(Boolean);

  if (!anthropic) {
    return { badge, headline, reasoning: fallbackReasoning };
  }

  try {
    const rewritten = await rewriteReasoning({
      badge,
      headline,
      activeCount,
      totalSignals,
      positiveCount,
      negativeCount,
      priceTarget,
      fallback: fallbackReasoning,
    });
    return { badge, headline, reasoning: rewritten };
  } catch (err) {
    console.error('Claude verdict rewrite failed, using rule-based reasoning:', err);
    return { badge, headline, reasoning: fallbackReasoning };
  }
}

module.exports = { getVerdict };
