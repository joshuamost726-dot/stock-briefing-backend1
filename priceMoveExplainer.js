/**
 * priceMoveExplainer.js
 *
 * "Why is this stock moving" — a short Claude explanation grounded in
 * today's actual price change plus whatever recent news/events/active
 * signals this page already computed. Distinct from Ask Claude (a broader
 * standing opinion on the stock, not tied to today specifically) and from
 * newsExplainer.js (per-headline, one sentence each, no synthesis across
 * articles) — this is the one place that tries to connect today's specific
 * price move to a likely cause, or say plainly that nothing in the data
 * explains it. Small moves on ordinary days often have no single cause,
 * and it's told explicitly to say so rather than force one — same
 * "don't perform confidence you don't have" pattern as aiTakeScore.js.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { parseBulletArray } = require('./claudeBullets.js');
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

async function explainPriceMove({ ticker, companyName, changePercent, news, companyEvents, plainParts }) {
  if (!anthropic) {
    return { available: false, bullets: ['Price-move commentary is unavailable right now (no API key configured).'] };
  }

  const context = {
    ticker,
    companyName,
    todayChangePercent: changePercent,
    recentNews: (news || []).slice(0, 5).map(n => ({ title: n.title, publishedAt: n.publishedAt })),
    recentCompanyEvents: companyEvents || [],
    activeSignalSummary: plainParts || [],
  };

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 350,
      system:
        'Explain why this stock is likely moving the way it is today, using ONLY the context given ' +
        '(today\'s % change, recent news, recent company events, active signal summary) plus your own general ' +
        'knowledge of the company/industry for interpretation — do not invent specific news you were not given. ' +
        'If the day\'s move is small (roughly within +/-1%) and nothing in the context plausibly explains it, ' +
        'say plainly that it looks like ordinary day-to-day noise rather than forcing a cause onto it. Plain, ' +
        'direct, no hedging filler, no "as an AI". Respond with ONLY a raw JSON array of strings, no markdown ' +
        'fences, no text before or after it. Each string is one short sentence, one idea only — do not chain ' +
        'two thoughts together with a semicolon, em-dash, or "and". Aim for 2-4 bullets.',
      messages: [{ role: 'user', content: JSON.stringify(context) }],
    });

    const text = message.content.find(b => b.type === 'text')?.text?.trim();
    return { available: true, bullets: parseBulletArray(text, ['No response generated.']) };
  } catch (err) {
    console.error(`Price move explanation failed for ${ticker}:`, err);
    return { available: false, bullets: ['Price-move commentary failed to generate this time — try reloading.'] };
  }
}

module.exports = { explainPriceMove };
