/**
 * insiderScore.js
 *
 * Insider Buying signal — scores genuine open-market purchases by insiders,
 * validated against their own compensation, filing timing, and whether other
 * insiders are moving the same direction.
 *
 * Design principle: sells are noise, not signal. Most Form 4 activity is
 * routine (10b5-1 scheduled sales, tax withholding, option exercises). Only
 * open-market BUYS (transactionType 'P') represent genuine discretionary
 * conviction. Sells are stored and surfaced for context but contribute ~0
 * weight to the score itself.
 */

const BUY_CODE = "P";
const SELL_CODE = "S";

async function getInsiderSignal(db, ticker) {
  const txnResult = await db.query(
    `SELECT insider_name, position, transaction_date, transaction_type,
            shares, price_per_share, value_usd, filed_at
     FROM insider_transactions
     WHERE ticker = $1
     ORDER BY transaction_date DESC`,
    [ticker]
  );

  const transactions = txnResult.rows;

  if (transactions.length === 0) {
    return {
      score: null,
      headline: "No Form 4 filings on file",
      explanation: "No insider transaction data available for this ticker.",
      hasSignal: false,
    };
  }

  const buys = transactions.filter((t) => t.transaction_type === BUY_CODE);
  const sells = transactions.filter((t) => t.transaction_type === SELL_CODE);

  if (buys.length === 0) {
    return {
      score: null,
      headline: `${sells.length} routine sell(s) on file, no buys`,
      explanation:
        "No open-market insider buying detected. Sell activity alone is not " +
        "scored — insiders sell for many routine reasons (10b5-1 plans, tax " +
        "withholding, diversification) that carry no directional signal. " +
        "This signal activates only when a genuine buy appears.",
      hasSignal: false,
    };
  }

  const compResult = await db.query(
    `SELECT executive_name, total_comp, salary
     FROM executive_compensation
     WHERE ticker = $1
     ORDER BY fiscal_year DESC`,
    [ticker]
  );
  const compByName = {};
  for (const row of compResult.rows) {
    if (!(row.executive_name in compByName)) {
      compByName[row.executive_name] = row;
    }
  }

  const scoredBuys = buys.map((buy) => scoreBuy(buy, compByName));

  const avgScale = average(scoredBuys.map((b) => b.scaleScore));
  const timingScore = scoreTiming(buys);
  const corroborationScore = scoreCorroboration(buys);

  const rawScore =
    avgScale * 0.5 + corroborationScore * 0.3 + timingScore * 0.2;
  const score = Math.round(clamp(rawScore, 0, 100));

  const distinctBuyers = new Set(buys.map((b) => b.insider_name)).size;
  const totalBuyValue = buys.reduce((sum, b) => sum + (b.value_usd || 0), 0);

  const headline = `${buys.length} insider buy(s) from ${distinctBuyers} insider(s), $${Math.round(
    totalBuyValue
  ).toLocaleString()} total`;

  const explanationParts = [
    scoredBuys.map((b) => b.note).join(" "),
    corroborationScore > 60
      ? "Multiple insiders bought in the same window — corroborated."
      : distinctBuyers === 1
      ? "Only one insider bought — no corroboration from others."
      : "",
    sells.length > 0
      ? `(${sells.length} routine sell(s) also on file — not scored.)`
      : "",
  ].filter(Boolean);

  return {
    score,
    headline,
    explanation: explanationParts.join(" "),
    hasSignal: true,
  };
}

function scoreBuy(buy, compByName) {
  const comp = compByName[buy.insider_name];

  if (!comp || !comp.total_comp) {
    return {
      scaleScore: 40,
      note: `${buy.insider_name} bought $${Math.round(
        buy.value_usd || 0
      ).toLocaleString()} — no compensation data on file to gauge scale vs. salary.`,
    };
  }

  const pctOfComp = (buy.value_usd / comp.total_comp) * 100;

  let scaleScore;
  if (pctOfComp >= 100) scaleScore = 95;
  else if (pctOfComp >= 50) scaleScore = 85;
  else if (pctOfComp >= 20) scaleScore = 70;
  else if (pctOfComp >= 5) scaleScore = 55;
  else scaleScore = 35;

  return {
    scaleScore,
    note: `${buy.insider_name} bought $${Math.round(
      buy.value_usd
    ).toLocaleString()} (~${pctOfComp.toFixed(
      0
    )}% of their reported total compensation).`,
  };
}

function scoreTiming(buys) {
  const mostRecent = buys
    .map((b) => new Date(b.transaction_date))
    .sort((a, b) => b - a)[0];
  const daysAgo = (Date.now() - mostRecent.getTime()) / (1000 * 60 * 60 * 24);

  if (daysAgo <= 7) return 90;
  if (daysAgo <= 14) return 70;
  if (daysAgo <= 30) return 50;
  return 30;
}

function scoreCorroboration(buys) {
  const distinctBuyers = new Set(buys.map((b) => b.insider_name)).size;
  if (distinctBuyers >= 3) return 90;
  if (distinctBuyers === 2) return 70;
  return 40;
}

function average(nums) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

module.exports = { getInsiderSignal };
