/**
 * claudeBullets.js
 *
 * Shared parser for the "respond with a JSON array of short bullet strings"
 * prompt pattern used by signalExplainer.js, noiseScore.js, and
 * aiTakeScore.js. Claude is asked for raw JSON, but occasionally wraps it in
 * a markdown code fence anyway — this strips that before parsing, and falls
 * back to splitting on newlines/leading dash-or-bullet characters if the
 * response isn't valid JSON at all, before giving up and returning the
 * caller's fallback array.
 */

function parseBulletArray(text, fallback) {
  if (!text) return fallback;

  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(x => typeof x === 'string')) {
      const items = parsed.map(s => s.trim()).filter(Boolean);
      if (items.length > 0) return items;
    }
  } catch (err) {
    // not valid JSON — fall through to best-effort line splitting
  }

  const lines = cleaned
    .split('\n')
    .map(l => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);

  return lines.length > 0 ? lines : fallback;
}

module.exports = { parseBulletArray };
