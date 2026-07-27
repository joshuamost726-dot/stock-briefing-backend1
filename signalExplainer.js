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
 *
 * POSITION CONTEXT: when detail.positionContext is present (insider buying
 * and institutional buying are currently the only two signals that can
 * supply one — see signalPriceContext.js), this isn't just told to restate
 * the price gap, it's explicitly asked to REASON about what it means for
 * someone holding at that cost basis. That reasoning genuinely depends on
 * direction and magnitude — "smart money paid more than you" reads very
 * differently from "smart money paid less than you," and neither is simply
 * good or bad on its own — so the system prompt spells out how to think
 * about each case rather than leaving Claude to guess a framing.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { parseBulletArray } = require('./claudeBullets.js');
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const POSITION_REASONING_GUIDANCE =
  'This one also includes positionContext — the user has a tracked position at their own cost ' +
  'basis, and this signal has a real (or, if positionContext.approximate is true, an approximated) ' +
  'price point to compare it against. Spend your last sentence genuinely reasoning about what the ' +
  'DIRECTION and MAGNITUDE of that gap implies for someone holding at that cost basis — don\'t just ' +
  'restate the percentage. Rough guidance, not a script: buying meaningfully ABOVE the user\'s cost ' +
  'basis tends to validate their entry and argues against urgency to sell, since informed money still ' +
  'sees room above where the user got in; buying meaningfully BELOW the user\'s cost basis is more ' +
  'ambiguous — it can mean the user paid a premium, but recent buying below their price can still ' +
  'reflect confidence at a level the user hasn\'t reached yet, not necessarily a reason to panic; a ' +
  'SIMILAR price mostly confirms the user is priced in-line with informed buyers. Weigh magnitude too — ' +
  'a 5% gap barely matters, a 100%+ gap is a much stronger signal. If positionContext.approximate is ' +
  'true (13F implied average, not a real trade price), say so plainly rather than treating it as exact.';

async function explainSignalPlainly({ headline, detail, positionContext }) {
  const fallback = [headline];

  if (!anthropic) return fallback;

  const hasPositionContext = !!positionContext;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: hasPositionContext ? 320 : 120,
      system:
        'You explain one financial data signal to a retail investor, using only the structured facts ' +
        'given. Do not add facts not present in the input. If a ticker symbol appears in the input, use ' +
        'it exactly as given — never guess or expand what company name it might stand for; if you ' +
        'don\'t already know the company, just use the ticker as-is. No hedging filler, no "as an AI". ' +
        'Respond with ONLY a raw JSON array of strings — no markdown code fences, no text before or ' +
        'after it. Each string is one short, self-contained bullet point (a phrase or short sentence, ' +
        'not a paragraph) — do not include a leading dash or bullet character in the string itself. ' +
        (hasPositionContext
          ? POSITION_REASONING_GUIDANCE + ' Aim for 2-3 bullets total.'
          : 'Aim for 1-2 bullets: what the signal found, and what it means.'),
      messages: [{ role: 'user', content: JSON.stringify({ headline, detail, positionContext }) }],
    });

    const text = message.content.find(b => b.type === 'text')?.text?.trim();
    return parseBulletArray(text, fallback);
  } catch (err) {
    console.error('Signal explanation rewrite failed, using rule-based headline:', err);
    return fallback;
  }
}

module.exports = { explainSignalPlainly };
