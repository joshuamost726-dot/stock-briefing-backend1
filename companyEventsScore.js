/**
 * companyEventsScore.js
 *
 * Extracts concrete company-specific events from the same recent-headlines
 * list newsExplainer.js already explains: acquisitions, product launches,
 * partnerships, leadership changes, regulatory actions. Deliberately
 * narrower than News — a headline only qualifies if it describes something
 * the company itself DID or that happened TO it, not analyst opinion,
 * price commentary, or sector-wide coverage that merely mentions the
 * ticker in passing.
 *
 * Also emits one deterministic (non-Claude) event when the stock is
 * currently trading at or beyond its average analyst price target — a
 * factual current-state read from priceTargetData.js, not a claim about
 * WHEN the crossing happened (this app doesn't track crossing history, so
 * it never says "just hit" — only "currently at/above").
 */

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const CATEGORIES = ['Acquisition', 'Product Launch', 'Partnership', 'Leadership Change', 'Regulatory', 'Other'];

function priceTargetEvent(priceTarget, quote) {
  if (!priceTarget?.available || !quote?.price) return null;

  const price = Number(quote.price);

  if (priceTarget.high != null && price >= priceTarget.high) {
    return {
      category: 'Price Target',
      headline: `Currently trading above the highest analyst price target ($${priceTarget.high.toFixed(2)})`,
      date: null,
      source: 'Computed from analyst price target data',
      url: null,
    };
  }
  if (priceTarget.mean != null && price >= priceTarget.mean) {
    return {
      category: 'Price Target',
      headline: `Currently trading at or above the average analyst price target ($${priceTarget.mean.toFixed(2)})`,
      date: null,
      source: 'Computed from analyst price target data',
      url: null,
    };
  }
  return null;
}

async function extractCompanyEvents(ticker, companyName, articles, priceTarget, quote) {
  const events = [];

  const ptEvent = priceTargetEvent(priceTarget, quote);
  if (ptEvent) events.push(ptEvent);

  if (!articles || articles.length === 0 || !anthropic) return events;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      system:
        `You are scanning recent headlines about ${companyName || ticker} (ticker ${ticker}) for concrete ` +
        `COMPANY EVENTS — things the company itself did or that happened to it directly: acquisitions/being ` +
        `acquired, new product or service launches, partnerships or major contracts, leadership changes ` +
        `(CEO/CFO hires or departures), regulatory or legal actions. Do NOT include general market commentary, ` +
        `analyst opinion pieces, sector roundups, or anything that only mentions the company in passing. For ` +
        `each article given, decide if it describes a real company event. Respond with ONLY a raw JSON array ` +
        `(no markdown fences, no text before or after), containing one entry per article that qualifies — ` +
        `skip non-qualifying articles entirely, do not include them. Each entry must look like: {"index": ` +
        `<0-based index into the input array>, "category": one of ${JSON.stringify(CATEGORIES)}, "headline": ` +
        `a short factual one-sentence summary of what happened, in your own words, not copied verbatim from ` +
        `the title}. If nothing qualifies, respond with exactly [].`,
      messages: [{
        role: 'user',
        content: JSON.stringify(articles.map(a => ({ title: a.title, description: a.description }))),
      }],
    });

    const text = message.content.find(b => b.type === 'text')?.text?.trim() || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const article = articles[item.index];
        if (!article) continue;
        events.push({
          category: CATEGORIES.includes(item.category) ? item.category : 'Other',
          headline: typeof item.headline === 'string' && item.headline.trim() ? item.headline.trim() : article.title,
          date: article.publishedAt || null,
          source: article.source || null,
          url: article.url || null,
        });
      }
    }
  } catch (err) {
    console.error(`Company event extraction failed for ${ticker}:`, err);
  }

  return events;
}

module.exports = { extractCompanyEvents };
