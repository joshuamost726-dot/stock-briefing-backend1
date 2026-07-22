/**
 * signalExplainer.js
 *
 * Turns one signal's rule-based headline/detail into a short, plain-English
 * explanation via Claude (claude-haiku-4-5) — same fallback philosophy as
 * noiseScore.js's verdict rewrite: if ANTHROPIC_API_KEY is unset or the call
 * fails, falls back to the original headline rather than breaking anything.
 *
 * Callers should only invoke this for signals that actually have data to
 * explain — a "no data" signal's headline is already about as simple as it
 * gets, so there's nothing worth spending a Claude call on.
 */

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

async function explainSignalPlainly({ headline, detail }) {
  const fallback = headline;

  if (!anthropic) return fallback;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 120,
      system:
        'You explain one financial data signal to a retail investor in 1-2 short, ' +
        'plain sentences — what it found and what it means, using only the ' +
        'structured facts given. Do not add facts not present in the input. No ' +
        'hedging filler, no "as an AI", no bullet points — prose only.',
      messages: [{ role: 'user', content: JSON.stringify({ headline, detail }) }],
    });

    const text = message.content.find(b => b.type === 'text')?.text?.trim();
    return text || fallback;
  } catch (err) {
    console.error('Signal explanation rewrite failed, using rule-based headline:', err);
    return fallback;
  }
}

module.exports = { explainSignalPlainly };
