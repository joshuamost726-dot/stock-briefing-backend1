const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');

// Used directly by this file for routes that read daily_prices (price
// history, portfolio value) — everything else goes through each *Score.js
// module's own pool, matching the existing (if imperfect) per-file pattern.
const dbPool = new Pool({ connectionString: process.env.DATABASE_URL });

// SEC's free public bulk ticker->CIK lookup — used to auto-resolve a CIK
// when a new stock is added via /api/stocks, so tracked_companies (the
// shared source the Python fetch scripts read their ticker list from) gets
// a working CIK without a manual SEC EDGAR lookup. Cached in memory for the
// life of the process — this list only changes when SEC adds/removes
// registrants, not in real time, so refetching per request would be
// wasteful. Returns cik: null for tickers with no SEC registration at all
// (e.g. foreign private issuers like SKHY) — that's expected, not an error.
let secTickerCikCache = null;
async function resolveCikForTicker(ticker) {
  try {
    if (!secTickerCikCache) {
      const res = await axios.get('https://www.sec.gov/files/company_tickers.json', {
        headers: { 'User-Agent': 'Josh Most joshuamost726@gmail.com' },
      });
      secTickerCikCache = Object.values(res.data);
    }
    const match = secTickerCikCache.find(v => v.ticker === ticker.toUpperCase());
    if (!match) return { cik: null, secName: null };
    return { cik: String(match.cik_str).padStart(10, '0'), secName: match.title };
  } catch (err) {
    console.error(`CIK lookup failed for ${ticker}:`, err.message);
    return { cik: null, secName: null };
  }
}
const { getInstitutionalBuyingSignal } = require('./convictionScore.js');
const { getInsiderBuyingSignal } = require('./insiderScore.js');
const { getShortInterestSignal } = require('./shortInterestScore.js');
const { getOptionsVolumeSignal } = require('./optionsVolumeScore.js');
const { getCongressTradingSignal } = require('./congressTradingScore.js');
const { getGovContractsSignal } = require('./govContractsScore.js');
const { getOffExchangeSignal } = require('./offExchangeScore.js');
const { getWsbSentimentSignal } = require('./wsbSentimentScore.js');
const { getKoreaOwnershipSignal } = require('./koreaOwnershipScore.js');
const { getKoreaMajorShareholderSignal } = require('./koreaMajorShareholderScore.js');
const { getKoreaCapitalActionsSignal } = require('./koreaCapitalActionsScore.js');
const { getTechnicalSignal } = require('./technicalScore.js');
const { getPriceTarget } = require('./priceTargetData.js');
const { getVerdict } = require('./noiseScore.js');
const { explainSignalPlainly } = require('./signalExplainer.js');
const { explainNewsForTicker } = require('./newsExplainer.js');
const { getUpcomingEvents } = require('./upcomingEvents.js');
const { getAiTake } = require('./aiTakeScore.js');
const { applyPositionAwareAdvice } = require('./positionAdvice.js');
const { getEarningsSurpriseSignal } = require('./earningsSurpriseScore.js');
const { extractCompanyEvents } = require('./companyEventsScore.js');
const { explainPriceMove } = require('./priceMoveExplainer.js');
const { parsePositionsCsv } = require('./positionImport.js');
const etradeAuth = require('./etradeAuth.js');
const etradeSync = require('./etradeSync.js');
const {
  getInsiderBuyingTrackRecord,
  getCongressTradingTrackRecord,
  getKoreaOwnershipTrackRecord,
} = require('./signalTrackRecord.js');

// Scores analyst consensus 0-100 from Finnhub recommendation trends.
function getAnalystSignal(recommendations) {
  if (!recommendations) return null;

  const sb = recommendations.strongBuy || 0;
  const b  = recommendations.buy || 0;
  const h  = recommendations.hold || 0;
  const s  = recommendations.sell || 0;
  const ss = recommendations.strongSell || 0;
  const total = sb + b + h + s + ss;

  if (total === 0) return null;

  // Weighted bullishness: strongBuy=1.0 down to strongSell=0
  const score = Math.round(
    ((sb * 1.0 + b * 0.75 + h * 0.5 + s * 0.25 + ss * 0) / total) * 100
  );

  const bullish = sb + b;
  const bullishPct = Math.round((bullish / total) * 100);

  return {
    score,
    status: score >= 70 ? 'positive' : score >= 50 ? 'neutral' : 'negative',
    headline: `${bullishPct}% bullish across ${total} analysts`,
    detail: `Strong Buy ${sb} · Buy ${b} · Hold ${h} · Sell ${s} · Strong Sell ${ss}`,
    validation: {
      timing: `Consensus as of ${recommendations.period || 'latest period'}. Ratings lag price moves.`,
      scaleVsSalary: 'Not applicable to analyst ratings.',
      trackRecord: 'No data available — requires logging past rating changes vs outcomes.',
     corroboration: total >= 10
        ? `${total} analysts covering — broad coverage.`
        : `Only ${total} analyst(s) covering — thin coverage.`
    },
    freshness: {
      lastChecked: null,
      schedule: 'Fetched live every time this page loads'
    }
  };
}

// Turns a signalTrackRecord.js result (or null, when there isn't enough
// computable history yet) into the plain-English string the Track Record
// validation field shows — same fallback text as before when null, so
// signals/tickers without enough data yet look exactly as they did.
function formatTrackRecord(tr, eventNounPlural) {
  if (!tr) {
    return `No data available — requires accumulated history of past ${eventNounPlural} vs. subsequent price moves.`;
  }
  return `Looking back at ${tr.sampleSize} past ${eventNounPlural} with enough price history to check: ` +
    `the stock was up ${tr.hitRate}% of the time ${tr.holdingDays} trading days later (avg ${tr.avgReturnPct >= 0 ? '+' : ''}${tr.avgReturnPct}%).`;
}

// Runs every signal for a ticker (insider buying, institutional buying, short
// interest, options volume, congressional trading, analyst rating) and
// returns the raw per-signal detail plus the aggregation inputs
// (scores/plainParts/activeStatuses) both /api/ticker/:ticker and
// /api/briefing/latest need. Shared so the two endpoints can't drift out of
// sync on which signals actually get checked.
async function computeAllSignals(ticker, stockData, position = null) {
  const signalsById = {};
  const scores = [];
  const plainParts = [];
  const activeStatuses = [];

  // Each signal below hits its own DB query or external API independently of
  // every other one — they used to run one after another (8 sequential round
  // trips), which was a real chunk of this page's load time. Collecting them
  // as promises and awaiting together at the end runs them concurrently
  // instead; each callback still mutates the shared arrays/object above, but
  // since only one callback body executes at a time on JS's single event
  // loop, that's safe without any locking.
  const signalPromises = [];

  // Signal 0: Insider buying (Form 4)
  signalPromises.push((async () => {
  try {
    const [insider, insiderTrackRecord] = await Promise.all([
      getInsiderBuyingSignal(ticker, position),
      getInsiderBuyingTrackRecord(ticker),
    ]);

    if (insider.hasSignal && insider.confidenceScore > 0) {
      scores.push({ id: 'insider_buying', score: insider.confidenceScore });
      plainParts.push(insider.explanation);
    }
    const insiderActive = insider.hasSignal && insider.confidenceScore > 0;

    const d = insider.detail || {};

    signalsById.insider_buying = {
      hasData: insider.hasSignal,
      status: !insider.hasSignal ? 'neutral'
            : insider.confidenceScore >= 70 ? 'positive'
            : insider.confidenceScore >= 50 ? 'neutral'
            : 'negative',
      headline: insider.hasSignal
        ? `${d.buyCount} insider buy(s) from ${d.distinctBuyers} insider(s)`
        : insider.label,
      detail: insider.explanation,
      positionContext: d.positionContext || null,
      validation: {
        timing: d.timingScore != null
          ? `Timing sub-score ${d.timingScore}. Form 4s are filed within 2 business days of the transaction.`
          : 'No buy activity to time.',
        scaleVsSalary: insider.hasSignal
          ? `Average scale-vs-salary sub-score ${Math.round(d.avgScale ?? 0)}/100 across ${d.buyCount} buy(s).`
          : 'No buy activity to compare against compensation.',
        trackRecord: formatTrackRecord(insiderTrackRecord, 'Form 4 buys'),
        corroboration: d.distinctBuyers > 1
          ? `${d.distinctBuyers} distinct insiders bought — corroborated.`
          : d.distinctBuyers === 1
          ? 'Only one insider bought — no corroboration from others yet.'
          : `${d.sellCount ?? 0} routine sell(s) on file — not counted as corroboration.`
      },
      freshness: {
        lastChecked: d.lastChecked,
        schedule: 'Updates automatically, daily'
      }
    };
    if (insiderActive) activeStatuses.push(signalsById.insider_buying.status);
  } catch (err) {
    console.error(`Insider signal failed for ${ticker}:`, err);
  }
  })());

  // Signal 1: Institutional buying
  signalPromises.push((async () => {
  try {
    const signal = await getInstitutionalBuyingSignal(ticker, position);
    const instScore = signal?.confidenceScore ?? 0;
    const d = signal?.detail || {};

    if (instScore > 0) {
      // signal.multiplier (0.4x-1.3x, see convictionScore.js's labelFor())
      // reflects how much momentum data backs this particular reading —
      // thread it through as a per-instance weight adjustment instead of
      // letting a low-confidence "ownership only" snapshot count exactly as
      // much as a high-conviction, momentum-confirmed one.
      scores.push({ id: 'institutional_buying', score: instScore, instanceMultiplier: signal.multiplier });
      plainParts.push(signal.explanation);
    }

    signalsById.institutional_buying = {
      hasData: !!d.holderCount,
      status: d.tooFewHoldersToScore ? 'neutral' : instScore >= 70 ? 'positive' : instScore >= 50 ? 'neutral' : 'negative',
      headline: d.holderCount
        ? `${d.holderCount.toLocaleString()} institutional holder(s) on file`
        : 'No institutional holdings on file',
      detail: signal?.explanation || '',
      positionContext: d.positionContext || null,
      validation: {
        timing: `Timing sub-score ${d.timingScore ?? 'n/a'}. 13F filings lag up to 45 days.`,
        scaleVsSalary: 'Not applicable to institutional filings.',
        trackRecord: `Track record sub-score ${d.trackRecordScore ?? 'n/a'}.`,
        corroboration: d.holderCount > 1
          ? `${d.holderCount} funds hold a position.`
          : 'Single holder — no corroboration.'
      },
      freshness: {
        lastChecked: d.period || null,
        schedule: 'Updates weekly automatically. Full quarterly sweep is manual — run it mid-to-late Aug, Nov, Feb, or May.'
      }
    };
  } catch (err) {
    console.error(`Institutional signal failed for ${ticker}:`, err);
  }
  })());

  // Signal: Short interest
  signalPromises.push((async () => {
  try {
    const shortInt = await getShortInterestSignal(ticker);
    const d = shortInt.detail || {};

    if (shortInt.hasSignal && shortInt.confidenceScore > 0) {
      // Convert strength+direction into a bullish-oriented contribution:
      // falling short interest (shorts covering) leans bullish;
      // rising short interest leans bearish absent a confirmed squeeze.
      const bullishContribution = shortInt.direction === 'decreasing'
        ? shortInt.confidenceScore
        : shortInt.direction === 'increasing'
        ? 100 - shortInt.confidenceScore
        : 50;

      scores.push({ id: 'short_interest', score: bullishContribution });
      plainParts.push(shortInt.explanation);
    }

    signalsById.short_interest = {
      hasData: shortInt.hasSignal,
      status: !shortInt.hasSignal ? 'neutral'
            : shortInt.direction === 'decreasing' ? 'positive'
            : shortInt.direction === 'increasing' ? 'negative'
            : 'neutral',
      headline: shortInt.hasSignal
        ? `Short interest ${shortInt.direction} as of ${d.settlementDate}`
        : shortInt.label,
      detail: shortInt.explanation,
      validation: {
        timing: d.settlementDate
          ? `Settlement date ${d.settlementDate}. FINRA short interest is published twice monthly.`
          : 'No settlement data available.',
        scaleVsSalary: 'Not applicable to short interest.',
        trackRecord: 'No data available — requires logging past short interest moves vs. subsequent price outcomes.',
        corroboration: d.trendScore >= 80
          ? shortInt.explanation.match(/consistent .*?trend/)?.[0] || 'Consistent multi-period trend.'
          : 'No confirmed multi-period trend yet.'
      },
      freshness: {
        lastChecked: d.settlementDate || null,
        schedule: 'Updates twice monthly (matches FINRA settlement dates)'
      }
    };
    if (shortInt.hasSignal && shortInt.confidenceScore > 0) activeStatuses.push(signalsById.short_interest.status);
  } catch (err) {
    console.error(`Short interest signal failed for ${ticker}:`, err);
  }
  })());

  // Signal: Options call volume
  signalPromises.push((async () => {
  try {
    const optVol = await getOptionsVolumeSignal(ticker);
    const d = optVol.detail || {};

    if (optVol.hasSignal && optVol.confidenceScore > 0) {
      scores.push({ id: 'options_volume', score: optVol.confidenceScore });
      plainParts.push(optVol.explanation);
    }

    signalsById.options_volume = {
      hasData: optVol.hasSignal,
      status: !optVol.hasSignal ? 'neutral'
            : optVol.confidenceScore >= 70 ? 'positive'
            : optVol.confidenceScore >= 50 ? 'neutral'
            : 'negative',
      headline: optVol.hasSignal
        ? `${d.volumeRatio?.toFixed(1)}x average call volume, ${d.callPutRatio?.toFixed(1)}:1 call/put ratio`
        : optVol.label,
      detail: optVol.explanation,
      validation: {
        timing: optVol.hasSignal
          ? `Snapshot taken after market close. ${d.daysOfHistory} day(s) of baseline history.`
          : `${d.daysAvailable ?? 0}/${d.daysNeeded ?? 5} days of history collected so far.`,
        scaleVsSalary: 'Not applicable to options volume.',
        trackRecord: 'No data available — requires logging past volume spikes vs. subsequent price moves.',
        corroboration: optVol.hasSignal && d.volumeScore >= 70 && d.skewScore >= 70
          ? 'Both volume and call/put skew are elevated together — mutually reinforcing.'
          : 'No corroborating signal within options data alone.'
      },
      freshness: {
        lastChecked: d.lastChecked || null,
        schedule: 'Updates automatically, daily (weekdays)'
      }
    };
    if (optVol.hasSignal && optVol.confidenceScore > 0) activeStatuses.push(signalsById.options_volume.status);
  } catch (err) {
    console.error(`Options volume signal failed for ${ticker}:`, err);
  }
  })());

  // Signal: Congressional trading
  signalPromises.push((async () => {
  try {
    const [congress, congressTrackRecord] = await Promise.all([
      getCongressTradingSignal(ticker),
      getCongressTradingTrackRecord(ticker),
    ]);
    const d = congress.detail || {};

    if (congress.hasSignal && congress.confidenceScore > 0) {
      scores.push({ id: 'congress_trading', score: congress.confidenceScore });
      plainParts.push(congress.explanation);
    }

    signalsById.congress_trading = {
      hasData: congress.hasSignal,
      status: !congress.hasSignal ? 'neutral'
            : congress.confidenceScore >= 70 ? 'positive'
            : congress.confidenceScore >= 50 ? 'neutral'
            : 'negative',
      headline: congress.hasSignal
        ? `${d.buyCount} purchase(s) from ${d.distinctBuyers} member(s) of Congress`
        : congress.label,
      detail: congress.explanation,
      validation: {
        timing: d.timingScore != null
          ? `Timing sub-score ${d.timingScore}. STOCK Act disclosures can lag up to 45 days behind the trade.`
          : 'No purchase activity to time.',
        scaleVsSalary: 'Not applicable to congressional trading.',
        trackRecord: formatTrackRecord(congressTrackRecord, 'congressional purchases'),
        corroboration: d.distinctBuyers > 1
          ? `${d.distinctBuyers} distinct members of Congress bought — corroborated.`
          : d.distinctBuyers === 1
          ? 'Only one member bought — no corroboration from others yet.'
          : `${d.sellCount ?? 0} sale(s)/exchange(s) on file — not counted as corroboration.`
      },
      freshness: {
        lastChecked: d.lastChecked || null,
        schedule: 'Updates automatically, daily'
      }
    };
    if (congress.hasSignal && congress.confidenceScore > 0) activeStatuses.push(signalsById.congress_trading.status);
  } catch (err) {
    console.error(`Congressional trading signal failed for ${ticker}:`, err);
  }
  })());

  // Signal: Government contracts
  signalPromises.push((async () => {
  try {
    const gov = await getGovContractsSignal(ticker);
    const d = gov.detail || {};

    if (gov.hasSignal && gov.confidenceScore > 0) {
      scores.push({ id: 'gov_contracts', score: gov.confidenceScore });
      plainParts.push(gov.explanation);
    }

    signalsById.gov_contracts = {
      hasData: gov.hasSignal,
      status: !gov.hasSignal ? 'neutral'
            : gov.confidenceScore >= 70 ? 'positive'
            : gov.confidenceScore >= 50 ? 'neutral'
            : 'negative',
      headline: gov.hasSignal
        ? `$${Math.round(d.recentTotal || 0).toLocaleString()} in recent federal contracts`
        : gov.label,
      detail: gov.explanation,
      validation: {
        timing: d.timingScore != null
          ? `Timing sub-score ${d.timingScore}. Most recent contract: ${d.mostRecentPeriod || 'n/a'}.`
          : 'No recent contract activity to time.',
        scaleVsSalary: 'Not applicable to government contracts.',
        trackRecord: d.baseline != null
          ? `Compared against this company's own historical average contract size.`
          : 'No prior contract history for this company to compare against.',
        corroboration: d.corroborationScore >= 70
          ? 'Contracts reported across multiple recent quarters.'
          : 'Single quarter of recent activity — not yet a multi-period pattern.'
      },
      freshness: {
        lastChecked: d.lastChecked || null,
        schedule: 'Updates automatically, daily on weekdays'
      }
    };
    if (gov.hasSignal && gov.confidenceScore > 0) activeStatuses.push(signalsById.gov_contracts.status);
  } catch (err) {
    console.error(`Government contracts signal failed for ${ticker}:`, err);
  }
  })());

  // Signal: Off-exchange (dark pool) volume
  signalPromises.push((async () => {
  try {
    const offEx = await getOffExchangeSignal(ticker);
    const d = offEx.detail || {};

    if (offEx.hasSignal && offEx.confidenceScore > 0) {
      // Rising short-side share off-exchange leans bearish-ish, falling leans
      // less-bearish — same bullish-contribution convention as short_interest.
      const bullishContribution = offEx.direction === 'decreasing'
        ? offEx.confidenceScore
        : offEx.direction === 'increasing'
        ? 100 - offEx.confidenceScore
        : 50;

      scores.push({ id: 'off_exchange', score: bullishContribution });
      plainParts.push(offEx.explanation);
    }

    signalsById.off_exchange = {
      hasData: offEx.hasSignal,
      status: !offEx.hasSignal ? 'neutral'
            : offEx.direction === 'decreasing' ? 'positive'
            : offEx.direction === 'increasing' ? 'negative'
            : 'neutral',
      headline: offEx.hasSignal
        ? `Off-exchange short-side share ${offEx.direction}`
        : offEx.label,
      detail: offEx.explanation,
      validation: {
        timing: d.lastChecked
          ? `Snapshot as of ${d.lastChecked}. FINRA off-exchange data updates daily.`
          : 'No settlement data available.',
        scaleVsSalary: 'Not applicable to off-exchange volume.',
        trackRecord: 'No data available — requires logging past off-exchange moves vs. subsequent price outcomes.',
        corroboration: d.volumeScore >= 70
          ? 'Both overall off-exchange volume and short-side share are elevated together.'
          : 'No corroborating volume spike alongside this move.'
      },
      freshness: {
        lastChecked: d.lastChecked || null,
        schedule: 'Updates automatically, daily (weekdays)'
      }
    };
    if (offEx.hasSignal && offEx.confidenceScore > 0) activeStatuses.push(signalsById.off_exchange.status);
  } catch (err) {
    console.error(`Off-exchange signal failed for ${ticker}:`, err);
  }
  })());

  // Signal: WallStreetBets / Reddit retail attention
  signalPromises.push((async () => {
  try {
    const wsb = await getWsbSentimentSignal(ticker);
    const d = wsb.detail || {};

    if (wsb.hasSignal && wsb.confidenceScore > 0) {
      plainParts.push(wsb.explanation);
      // Deliberately NOT pushed into `scores` — mention volume has no
      // established directional relationship to price the way the other
      // signals do, so it's surfaced as context, not averaged into
      // convictionScore. See wsbSentimentScore.js's design note.
    }

    signalsById.wsb_sentiment = {
      hasData: wsb.hasSignal,
      status: !wsb.hasSignal ? 'neutral' : 'neutral',
      headline: wsb.hasSignal
        ? `${d.todayMentions} Reddit mention(s) today${d.todayRank != null ? ` (rank #${d.todayRank})` : ''}`
        : wsb.label,
      detail: wsb.explanation,
      validation: {
        timing: d.lastChecked
          ? `Snapshot as of ${d.lastChecked}. Updates daily, including weekends.`
          : 'No mention data available.',
        scaleVsSalary: 'Not applicable to Reddit mention volume.',
        trackRecord: 'No data available — mention volume has no established directional relationship to price.',
        corroboration: 'Mention volume only — does not corroborate or contradict other signals by design.'
      },
      freshness: {
        lastChecked: d.lastChecked || null,
        schedule: 'Updates automatically, daily (including weekends)'
      }
    };
  } catch (err) {
    console.error(`WSB sentiment signal failed for ${ticker}:`, err);
  }
  })());

  // Signal: Korea ownership changes (SKHY only — its Form 4/insider-buying
  // equivalent, since it's a genuine foreign private issuer with no US
  // insider disclosure at all)
  signalPromises.push((async () => {
  try {
    const [korea, koreaTrackRecord] = await Promise.all([
      getKoreaOwnershipSignal(ticker),
      getKoreaOwnershipTrackRecord(ticker),
    ]);
    const d = korea.detail || {};

    if (korea.hasSignal && korea.confidenceScore > 0) {
      scores.push({ id: 'korea_ownership', score: korea.confidenceScore });
      plainParts.push(korea.explanation);
    }

    signalsById.korea_ownership = {
      hasData: korea.hasSignal,
      status: !korea.hasSignal ? 'neutral'
            : korea.confidenceScore >= 70 ? 'positive'
            : korea.confidenceScore >= 50 ? 'neutral'
            : 'negative',
      headline: korea.hasSignal
        ? `${d.increaseCount} ownership increase(s) from ${d.distinctReporters} reporter(s)`
        : korea.label,
      detail: korea.explanation,
      validation: {
        timing: d.timingScore != null
          ? `Timing sub-score ${d.timingScore}.`
          : 'No increase activity to time.',
        scaleVsSalary: 'Not applicable — Korean disclosure reports no compensation data here.',
        trackRecord: formatTrackRecord(koreaTrackRecord, 'ownership increases'),
        corroboration: d.distinctReporters > 1
          ? `${d.distinctReporters} distinct reporters increased holdings — corroborated.`
          : d.distinctReporters === 1
          ? 'Only one reporter increased holdings — no corroboration from others yet.'
          : `${d.decreaseCount ?? 0} decrease(s) on file — not counted as corroboration.`
      },
      freshness: {
        lastChecked: d.lastChecked || null,
        schedule: 'Updates automatically, daily'
      }
    };
    if (korea.hasSignal && korea.confidenceScore > 0) activeStatuses.push(signalsById.korea_ownership.status);
  } catch (err) {
    console.error(`Korea ownership signal failed for ${ticker}:`, err);
  }
  })());

  // Signal: Korea major shareholder changes (SKHY only — its institutional-
  // buying equivalent, since it's a genuine foreign private issuer with no
  // US 13F coverage of its own)
  signalPromises.push((async () => {
  try {
    const koreaInst = await getKoreaMajorShareholderSignal(ticker);
    const d = koreaInst.detail || {};

    if (koreaInst.hasSignal && koreaInst.confidenceScore > 0) {
      // Bidirectional like short_interest/off_exchange — decreasing stakes
      // lean bearish, increasing stakes lean bullish, mixed stays neutral.
      const bullishContribution = koreaInst.direction === 'increasing'
        ? koreaInst.confidenceScore
        : koreaInst.direction === 'decreasing'
        ? 100 - koreaInst.confidenceScore
        : 50;

      scores.push({ id: 'korea_major_shareholder', score: bullishContribution });
      plainParts.push(koreaInst.explanation);
    }

    signalsById.korea_major_shareholder = {
      hasData: koreaInst.hasSignal,
      status: !koreaInst.hasSignal ? 'neutral'
            : koreaInst.direction === 'increasing' ? 'positive'
            : koreaInst.direction === 'decreasing' ? 'negative'
            : 'neutral',
      headline: koreaInst.hasSignal
        ? `${d.filingCount} major shareholder filing(s), net ${koreaInst.direction}`
        : koreaInst.label,
      detail: koreaInst.explanation,
      validation: {
        timing: d.timingScore != null
          ? `Timing sub-score ${d.timingScore}.`
          : 'No recent filings to time.',
        scaleVsSalary: 'Not applicable — Korean disclosure reports no compensation data here.',
        trackRecord: 'No data available — requires accumulated history of past filings vs. subsequent price moves.',
        corroboration: d.distinctReporters > 1
          ? `${d.distinctReporters} distinct institutions filed — corroborated.`
          : 'Only one institution filed — no corroboration from others yet.'
      },
      freshness: {
        lastChecked: d.lastChecked || null,
        schedule: 'Updates automatically, daily'
      }
    };
    if (koreaInst.hasSignal && koreaInst.confidenceScore > 0) activeStatuses.push(signalsById.korea_major_shareholder.status);
  } catch (err) {
    console.error(`Korea major shareholder signal failed for ${ticker}:`, err);
  }
  })());

  // Signal: Korea capital actions (SKHY only — buybacks/share issuances,
  // the closest Korean equivalent to US buyback/offering disclosures)
  signalPromises.push((async () => {
  try {
    const capActions = await getKoreaCapitalActionsSignal(ticker);
    const d = capActions.detail || {};

    if (capActions.hasSignal && capActions.confidenceScore > 0) {
      // Buybacks lean bullish, issuances lean dilutive/bearish-ish, mixed
      // stays neutral — same bullish-contribution convention as
      // off_exchange/short_interest.
      const bullishContribution = capActions.direction === 'buyback'
        ? capActions.confidenceScore
        : capActions.direction === 'issuance'
        ? 100 - capActions.confidenceScore
        : 50;

      scores.push({ id: 'korea_capital_actions', score: bullishContribution });
      plainParts.push(capActions.explanation);
    }

    signalsById.korea_capital_actions = {
      hasData: capActions.hasSignal,
      status: !capActions.hasSignal ? 'neutral'
            : capActions.direction === 'buyback' ? 'positive'
            : capActions.direction === 'issuance' ? 'negative'
            : 'neutral',
      headline: capActions.hasSignal
        ? `${d.buybackCount} buyback(s), ${d.issuanceCount} issuance(s) on file`
        : capActions.label,
      detail: capActions.explanation,
      validation: {
        timing: 'Based on filings seen in our own daily fetch history (these report types don\'t return a convenient filing date).',
        scaleVsSalary: 'Not applicable to corporate capital actions.',
        trackRecord: 'No data available — requires accumulated history of past actions vs. subsequent price moves.',
        corroboration: 'Single company\'s own decision — no multi-party corroboration concept applies here.'
      },
      freshness: {
        lastChecked: d.lastChecked || null,
        schedule: 'Updates automatically, daily'
      }
    };
    if (capActions.hasSignal && capActions.confidenceScore > 0) activeStatuses.push(signalsById.korea_capital_actions.status);
  } catch (err) {
    console.error(`Korea capital actions signal failed for ${ticker}:`, err);
  }
  })());

  // Signal: Technical momentum — the one signal that applies to every
  // tracked ticker equally, since it doesn't depend on any country's
  // disclosure regime at all.
  signalPromises.push((async () => {
  try {
    const tech = await getTechnicalSignal(ticker);
    const d = tech.detail || {};

    if (tech.hasSignal && tech.confidenceScore > 0) {
      // Bidirectional like short_interest/off_exchange — bearish trend
      // leans bearish, bullish trend leans bullish.
      const bullishContribution = tech.direction === 'bullish'
        ? tech.confidenceScore
        : tech.direction === 'bearish'
        ? 100 - tech.confidenceScore
        : 50;

      scores.push({ id: 'technical_momentum', score: bullishContribution });
      plainParts.push(tech.explanation);
    }

    signalsById.technical_momentum = {
      hasData: tech.hasSignal,
      status: !tech.hasSignal ? 'neutral'
            : tech.direction === 'bullish' ? 'positive'
            : tech.direction === 'bearish' ? 'negative'
            : 'neutral',
      headline: tech.hasSignal
        ? `${tech.label} — ${d.rangePosition != null ? d.rangePosition.toFixed(0) : '?'}% of 52-week range`
        : tech.label,
      detail: tech.explanation,
      validation: {
        timing: d.lastChecked
          ? `Snapshot as of ${d.lastChecked}. Price history updates daily (weekdays).`
          : `${d.daysAvailable ?? 0}/${d.daysNeeded ?? 200} days of history collected so far.`,
        scaleVsSalary: 'Not applicable to technical price/volume data.',
        trackRecord: 'No data available — requires logging past trend signals vs. subsequent price moves.',
        corroboration: tech.hasSignal && d.volumeConfirmationScore >= 70
          ? 'Volume confirms the price trend — mutually reinforcing.'
          : 'No strong volume confirmation for this trend.'
      },
      freshness: {
        lastChecked: d.lastChecked || null,
        schedule: 'Updates automatically, daily (weekdays)'
      }
    };
    if (tech.hasSignal && tech.confidenceScore > 0) activeStatuses.push(signalsById.technical_momentum.status);
  } catch (err) {
    console.error(`Technical signal failed for ${ticker}:`, err);
  }
  })());

  await Promise.all(signalPromises);

  // Signal 2: Analyst ratings
  const analyst = getAnalystSignal(stockData.recommendations);
  if (analyst) {
    scores.push({ id: 'analyst_rating', score: analyst.score });
    signalsById.analyst_rating = { ...analyst, hasData: true };
    plainParts.push(`Analyst consensus: ${analyst.headline}.`);
    activeStatuses.push(analyst.status);
  }

  // Signal 3: Earnings surprise history
  const earningsSurprise = getEarningsSurpriseSignal(stockData.earningsSurpriseHistory);
  if (earningsSurprise) {
    scores.push({ id: 'earnings_surprise', score: earningsSurprise.score });
    signalsById.earnings_surprise = { ...earningsSurprise, hasData: true };
    plainParts.push(`Earnings surprise history: ${earningsSurprise.headline}.`);
    activeStatuses.push(earningsSurprise.status);
  }

  return { signalsById, scores, plainParts, activeStatuses };
}

// Reliability weight per signal type — how much a signal should move the
// overall conviction score, independent of what score it happens to report.
// Based on how direct/timely/hard-to-fake each data source actually is:
// real transaction disclosures with an enforced filing deadline outweigh
// lagged/implied/opinion-based reads. This is what was missing before —
// every active signal previously counted exactly the same regardless of
// how much it should actually be trusted, which is the biggest reason the
// aggregate score could feel arbitrary.
const SIGNAL_WEIGHTS = {
  insider_buying: 1.0,          // real Form 4 transaction, filed within 2 business days
  korea_ownership: 1.0,         // Korean equivalent — real disclosed ownership change
  earnings_surprise: 0.85,      // real reported actual-vs-estimate track record
  institutional_buying: 0.75,   // 13F — real but lags up to 45 days, implied price only
  korea_major_shareholder: 0.75,
  short_interest: 0.65,         // real FINRA data, but a positioning proxy, not a trade
  technical_momentum: 0.6,      // price-derived, no fundamental/disclosure content
  korea_capital_actions: 0.6,
  analyst_rating: 0.55,         // opinion-based, not a disclosed transaction
  options_volume: 0.5,          // noisy, short-lived
  off_exchange: 0.5,
  congress_trading: 0.45,       // sparse, STOCK Act disclosure can lag up to 45 days
  gov_contracts: 0.45,
};

// Turns the flat list of {id, score, instanceMultiplier?} entries collected
// above into one aggregate 0-100 conviction score, weighted by how much each
// signal type should actually be trusted (SIGNAL_WEIGHTS) and, where a
// signal computes its own per-instance confidence (currently only
// institutional_buying's momentum-availability multiplier), by that too.
//
// Coverage matters as much as the weighted average itself: a score built
// from 2 of 12 applicable signals is a much shakier read than one built
// from 9 of 12, even if the raw weighted average comes out identical. When
// coverage is thin, the score is pulled toward neutral (50) proportional to
// how much weight is missing — same "say 'I don't know' instead of a false
// confident number" philosophy already used elsewhere in this codebase
// (see convictionScore.js's MAX_SCORE_WITHOUT_MOMENTUM). Coverage is
// measured against getApplicableSignalOrder(ticker), not the full 14, so a
// ticker like SKHY isn't penalized for signals that are structurally
// impossible for it anyway.
function computeConviction(scores, ticker) {
  if (scores.length === 0) {
    return { score: 0, confidence: 'None', coveragePct: 0, breakdown: [] };
  }

  const totalApplicableWeight = getApplicableSignalOrder(ticker)
    .reduce((sum, m) => sum + (SIGNAL_WEIGHTS[m.id] ?? 0.5), 0);

  let weightedSum = 0;
  let activeWeight = 0;
  const breakdown = [];

  for (const { id, score, instanceMultiplier } of scores) {
    const w = (SIGNAL_WEIGHTS[id] ?? 0.5) * (instanceMultiplier ?? 1);
    weightedSum += score * w;
    activeWeight += w;
    breakdown.push({ id, score, weight: Number(w.toFixed(2)) });
  }

  const rawScore = activeWeight > 0 ? weightedSum / activeWeight : 50;
  const coverage = totalApplicableWeight > 0
    ? Math.min(1, activeWeight / totalApplicableWeight)
    : 1;

  const score = Math.round(rawScore * coverage + 50 * (1 - coverage));
  const confidence = coverage >= 0.55 ? 'High' : coverage >= 0.3 ? 'Medium' : 'Low';

  // Biggest movers first — how far a signal pulls from neutral (50) times
  // how much weight it carries, so the breakdown surfaces what actually
  // drove the number rather than just listing signals in fetch order.
  breakdown.sort((a, b) => Math.abs(b.score - 50) * b.weight - Math.abs(a.score - 50) * a.weight);

  return { score, confidence, coveragePct: Math.round(coverage * 100), breakdown };
}

// Rewrites each data-bearing signal's headline into a short plain-English
// explanation via Claude, in parallel. Signals with no data keep their
// existing headline as-is — already about as simple as it gets, not worth a
// Claude call. Deliberately NOT part of computeAllSignals() — it only
// touches signalsById.simpleExplanation, which nothing else (verdict, news,
// AI take) depends on, so the caller runs this alongside those instead of
// waiting for it first.
async function explainSignalsPlainly(signalsById) {
  await Promise.all(
    Object.values(signalsById)
      .filter(s => s.hasData)
      .map(async s => {
        s.simpleExplanation = await explainSignalPlainly({
          headline: s.headline,
          detail: s.detail,
          positionContext: s.positionContext || null,
        });
      })
  );
  return signalsById;
}

const SIGNAL_ORDER = [
  { id: 'insider_buying',       label: 'Insider Buying',        source: 'SEC EDGAR (Form 4)',    category: 'Company Filings' },
  { id: 'institutional_buying', label: 'Institutional Buying',  source: 'SEC EDGAR (13F)',       category: 'Company Filings' },
  { id: 'korea_ownership',      label: 'Korea Ownership Change', source: 'Open DART (Korea FSS)', category: 'Company Filings' },
  { id: 'korea_major_shareholder', label: 'Korea Major Shareholder', source: 'Open DART (Korea FSS)', category: 'Company Filings' },
  { id: 'korea_capital_actions', label: 'Korea Capital Actions', source: 'Open DART (Korea FSS)', category: 'Company Filings' },
  { id: 'earnings_surprise',    label: 'Earnings Surprise History', source: 'Finnhub',          category: 'Analyst & Estimates' },
  { id: 'analyst_rating',       label: 'Analyst Rating Change', source: 'Finnhub',               category: 'Analyst & Estimates' },
  { id: 'short_interest',       label: 'Short Interest',        source: 'FINRA (via Nasdaq)',    category: 'Market Activity' },
  { id: 'options_volume',       label: 'Options Call Volume',   source: 'Yahoo Finance',         category: 'Market Activity' },
  { id: 'off_exchange',        label: 'Off-Exchange Volume',   source: 'Quiver Quantitative',   category: 'Market Activity' },
  { id: 'technical_momentum',  label: 'Technical Momentum',    source: 'Yahoo Finance',         category: 'Market Activity' },
  { id: 'congress_trading',     label: 'Congressional Trading', source: 'Quiver Quantitative',   category: 'Government & Political' },
  { id: 'gov_contracts',        label: 'Government Contracts',  source: 'Quiver Quantitative',   category: 'Government & Political' },
  { id: 'wsb_sentiment',        label: 'Reddit / WSB Attention', source: 'ApeWisdom',            category: 'Retail Sentiment' }
];

// Signals that are structurally impossible for a given ticker — not just
// currently empty, but confirmed (via direct testing, see TASKS.md) to have
// no path to ever populating — get filtered out of that ticker's signal
// list and total count entirely, rather than sitting forever as dead "No
// Data" cards. Deliberately conservative: a signal only goes here once
// there's real evidence it can never work (e.g. an API confirming "no such
// symbol"), not just because it's currently unpopulated — institutional_buying
// stays for SKHY/CWBHF despite being thin right now, since more holders
// could genuinely show up in a future 13F sweep. off_exchange stays for
// CWBHF too — it returned a Quiver server error, not a confirmed empty
// result, so it might just be a temporary bug on Quiver's end.
const INAPPLICABLE_SIGNALS_BY_TICKER = {
  // SKHY: genuine foreign private issuer (Korea Exchange primary listing,
  // OTC-only in the US) — no Form 4 (Section 16 exempt), no FINRA short
  // interest ("not available" per Nasdaq's own API), no US options market,
  // and Quiver's congressional trading/gov contracts/off-exchange all
  // returned confirmed-empty (not error) results.
  SKHY: ['insider_buying', 'short_interest', 'options_volume', 'off_exchange', 'congress_trading', 'gov_contracts'],
  // CWBHF: thinly-traded OTC penny stock — no FINRA short interest
  // ("Symbol not exists" per Nasdaq's API), no meaningful US options
  // market, and Quiver's congressional trading/gov contracts both
  // returned confirmed-empty results.
  CWBHF: ['short_interest', 'options_volume', 'congress_trading', 'gov_contracts'],
};

// Korea DART signals are structurally inapplicable to every ticker except
// SKHY — there's no Korean disclosure regime to look up for a US company.
const KOREA_ONLY_SIGNALS = ['korea_ownership', 'korea_major_shareholder', 'korea_capital_actions'];

function getApplicableSignalOrder(ticker) {
  const inapplicable = new Set([
    ...(INAPPLICABLE_SIGNALS_BY_TICKER[ticker] || []),
    ...(ticker === 'SKHY' ? [] : KOREA_ONLY_SIGNALS),
  ]);
  return SIGNAL_ORDER.filter(m => !inapplicable.has(m.id));
}

function normalize(meta, raw) {
  const v = (raw && raw.validation) || {};
  const f = (raw && raw.freshness) || {};
  return {
    id: meta.id,
    label: meta.label,
    source: meta.source || null,
    category: meta.category || 'Other',
    hasData: !!(raw && raw.hasData),
    status: (raw && raw.status) || 'neutral',
    headline: (raw && raw.headline) || 'No signal detected',
    detail: (raw && raw.detail) || '',
    simpleExplanation: (raw && raw.simpleExplanation) || [(raw && raw.headline) || 'No signal detected'],
    positionContext: (raw && raw.positionContext) || null,
    validation: {
      timing:        v.timing        || 'No data available',
      scaleVsSalary: v.scaleVsSalary || 'No data available',
      trackRecord:   v.trackRecord   || 'No data available',
      corroboration: v.corroboration || 'No data available'
    },
    freshness: {
      lastChecked: f.lastChecked || null,
      schedule: f.schedule || 'No schedule data available'
    }
  };
}

const app = express();
// Default 100kb limit is too small for a full brokerage transaction-history
// CSV (see positionImport.js) pasted into a JSON body — a few years of
// trades can run past that easily.
app.use(express.json({ limit: '5mb' }));
app.use(cors());

// Access gate — a single shared code, not a full account system. Added
// before any public launch so a random visitor who finds the URL can't run
// up API costs (Quiver Quantitative, Claude, etc.) or trigger the on-demand
// per-ticker data backfill. If ACCESS_CODE isn't set (e.g. plain local dev),
// the gate is a no-op rather than locking out development.
const ACCESS_CODE = process.env.ACCESS_CODE;

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on mismatched lengths — comparing against a
  // same-length hash of both sides keeps the length check itself constant
  // time instead of short-circuiting on a wrong-length guess.
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

app.post('/api/auth/verify', (req, res) => {
  if (!ACCESS_CODE) return res.json({ valid: true });
  const code = String(req.body?.code || '');
  res.json({ valid: timingSafeEqualStrings(code, ACCESS_CODE) });
});

app.use((req, res, next) => {
  if (!ACCESS_CODE) return next();
  const provided = String(req.headers['x-access-code'] || '');
  if (!timingSafeEqualStrings(provided, ACCESS_CODE)) {
    return res.status(401).json({ error: 'Access code required' });
  }
  next();
});

// Tracked stocks + cost-basis positions live in tracked_companies (Postgres)
// rather than a local data.json file. That file used to sit on a persistent
// Railway volume specifically because the app's own working directory is
// ephemeral and gets wiped on every deploy — moving this into the database
// we already run removes that dependency entirely, so hosting no longer
// needs volume support.
function rowToStock(row) {
  const stock = { ticker: row.ticker, name: row.company_name || row.ticker };
  if (row.cost_per_share != null && row.shares != null) {
    stock.position = {
      costPerShare: Number(row.cost_per_share),
      shares: Number(row.shares),
      updatedAt: row.position_updated_at ? new Date(row.position_updated_at).toISOString() : null,
    };
  }
  return stock;
}

async function getTrackedStocks() {
  const { rows } = await dbPool.query(
    'SELECT ticker, company_name, cost_per_share, shares, position_updated_at FROM tracked_companies ORDER BY ticker'
  );
  return rows.map(rowToStock);
}

async function getTrackedStock(ticker) {
  const { rows } = await dbPool.query(
    'SELECT ticker, company_name, cost_per_share, shares, position_updated_at FROM tracked_companies WHERE ticker = $1',
    [ticker]
  );
  return rows[0] ? rowToStock(rows[0]) : null;
}

async function setPosition(ticker, costPerShare, shares) {
  const { rows } = await dbPool.query(
    `UPDATE tracked_companies
        SET cost_per_share = $1, shares = $2, position_updated_at = NOW()
      WHERE ticker = $3
      RETURNING ticker, company_name, cost_per_share, shares, position_updated_at`,
    [costPerShare, shares, ticker]
  );
  return rows[0] ? rowToStock(rows[0]) : null;
}

async function clearPosition(ticker) {
  const { rows } = await dbPool.query(
    `UPDATE tracked_companies
        SET cost_per_share = NULL, shares = NULL, position_updated_at = NULL
      WHERE ticker = $1
      RETURNING ticker, company_name, cost_per_share, shares, position_updated_at`,
    [ticker]
  );
  return rows[0] ? rowToStock(rows[0]) : null;
}

// API Keys
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;

// Finnhub API calls
async function getStockQuote(ticker) {
  try {
    const res = await axios.get(`https://finnhub.io/api/v1/quote`, {
      params: {
        symbol: ticker,
        token: FINNHUB_KEY
      }
    });
    return res.data;
  } catch (e) {
    console.error(`Error fetching quote for ${ticker}:`, e.message);
    return null;
  }
}

async function getCompanyProfile(ticker) {
  try {
    const res = await axios.get(`https://finnhub.io/api/v1/stock/profile2`, {
      params: {
        symbol: ticker,
        token: FINNHUB_KEY
      }
    });
    return res.data;
  } catch (e) {
    console.error(`Error fetching profile for ${ticker}:`, e.message);
    return null;
  }
}

async function getRecommendationTrends(ticker) {
  try {
    const res = await axios.get(`https://finnhub.io/api/v1/stock/recommendation`, {
      params: {
        symbol: ticker,
        token: FINNHUB_KEY
      }
    });
    return res.data;
  } catch (e) {
    console.error(`Error fetching recommendations for ${ticker}:`, e.message);
    return null;
  }
}

// Finnhub's calendar/earnings requires an explicit from/to range — without
// one it silently returns an empty earningsCalendar every time, which is why
// nextEarnings has never actually populated. Window covers the next ~2
// quarters, which is enough to always catch the next confirmed date.
async function getEarningsCalendar(ticker) {
  try {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await axios.get(`https://finnhub.io/api/v1/calendar/earnings`, {
      params: {
        symbol: ticker,
        from,
        to,
        token: FINNHUB_KEY
      }
    });
    const calendar = res.data?.earningsCalendar || [];
    // Finnhub doesn't guarantee sort order — take the soonest upcoming date.
    return [...calendar].sort((a, b) => new Date(a.date) - new Date(b.date));
  } catch (e) {
    console.error(`Error fetching earnings for ${ticker}:`, e.message);
    return null;
  }
}

// Historical actual-vs-estimate EPS surprises — a different, real signal
// from a "whisper number" (which has no viable free data source; same
// dead-end as SEDAR+ for CWBHF), but a legitimate replacement for the
// earnings_whisper slot that sat unbuilt since the project's early days.
async function getEarningsSurpriseHistory(ticker) {
  try {
    const res = await axios.get(`https://finnhub.io/api/v1/stock/earnings`, {
      params: { symbol: ticker, token: FINNHUB_KEY }
    });
    return Array.isArray(res.data) ? res.data : [];
  } catch (e) {
    console.error(`Error fetching earnings surprise history for ${ticker}:`, e.message);
    return null;
  }
}

// Searching by bare ticker (e.g. "QCOM") matches unrelated noise — NewsAPI's
// qInTitle restricted to the company's actual name is much more precise,
// since it requires the name to appear in the headline itself, not just
// somewhere in the article body.
async function getNews(ticker, companyName) {
  try {
    const res = await axios.get(`https://newsapi.org/v2/everything`, {
      params: {
        qInTitle: companyName || ticker,
        sortBy: 'publishedAt',
        language: 'en',
        apikey: NEWS_API_KEY,
        pageSize: 10
      }
    });
    const articles = res.data.articles || [];
    // NewsAPI occasionally returns syndicated duplicates of the same story.
    const seen = new Set();
    return articles.filter(a => {
      if (seen.has(a.title)) return false;
      seen.add(a.title);
      return true;
    });
  } catch (e) {
    console.error(`Error fetching news for ${ticker}:`, e.message);
    return [];
  }
}

// Generate comprehensive briefing
async function getStockData(ticker) {
  try {
    // These four are independent of each other — running them sequentially
    // (as this used to) means paying for 4 round trips back to back instead
    // of 1. news needs profile.name, so it starts right after that group
    // resolves rather than joining it.
    const [quote, profile, recommendations, earnings, earningsSurpriseHistory] = await Promise.all([
      getStockQuote(ticker),
      getCompanyProfile(ticker),
      getRecommendationTrends(ticker),
      getEarningsCalendar(ticker),
      getEarningsSurpriseHistory(ticker),
    ]);
    const news = await getNews(ticker, profile?.name);

    if (!quote) {
      return { ticker, error: 'Failed to fetch quote' };
    }

    return {
      ticker,
      quote: {
        price: quote.c,
        open: quote.o,
        high: quote.h,
        low: quote.l,
        change: quote.d,
        changePercent: quote.dp,
        volume: quote.v,
        timestamp: new Date().toISOString()
      },
      profile: {
        name: profile?.name || 'N/A',
        industry: profile?.finnhubIndustry || 'N/A',
        marketCap: profile?.marketCapitalization || 'N/A',
        pe: profile?.pe || 'N/A',
        website: profile?.weburl || 'N/A'
      },
      recommendations: recommendations?.[0] || null,
      nextEarnings: earnings?.[0] || null,
      earningsSurpriseHistory: earningsSurpriseHistory || [],
      news: news.slice(0, 5).map(n => ({
        title: n.title,
        description: n.description || null,
        source: n.source.name,
        url: n.url,
        publishedAt: n.publishedAt
      }))
    };
  } catch (error) {
    console.error(`Error getting data for ${ticker}:`, error.message);
    return { ticker, error: 'Failed to fetch stock data' };
  }
}

// API Routes
app.get('/api/stocks', async (req, res) => {
  res.json(await getTrackedStocks());
});

// Shared by POST /api/stocks and the CSV/E*TRADE position-import apply
// route below — both need "start tracking a new ticker" to behave
// identically (same CIK auto-resolution, same upsert).
async function trackNewTicker(ticker, name) {
  const { cik, secName } = await resolveCikForTicker(ticker);
  const stockName = name || secName || ticker;
  await dbPool.query(
    `INSERT INTO tracked_companies (ticker, company_name, cik)
     VALUES ($1, $2, $3)
     ON CONFLICT (ticker) DO UPDATE SET company_name = EXCLUDED.company_name, cik = EXCLUDED.cik, updated_at = NOW()`,
    [ticker, stockName, cik]
  );
}

app.post('/api/stocks', async (req, res) => {
  const { ticker, name } = req.body;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });

  const upperTicker = ticker.toUpperCase();
  const exists = await getTrackedStock(upperTicker);
  if (exists) return res.status(400).json({ error: 'Stock already tracked' });

  await trackNewTicker(upperTicker, name);

  res.json(await getTrackedStocks());
});

app.delete('/api/stocks/:ticker', async (req, res) => {
  const upperTicker = req.params.ticker.toUpperCase();
  await dbPool.query('DELETE FROM tracked_companies WHERE ticker = $1', [upperTicker]);
  res.json(await getTrackedStocks());
});

// Phase 6 — cost basis / position tracking, stored in tracked_companies
// alongside the tracked stock list (personal portfolio data, not market
// data, but no reason to keep it in a separate store any more).
app.put('/api/stocks/:ticker/position', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const stock = await getTrackedStock(ticker);
  if (!stock) return res.status(404).json({ error: 'Ticker not tracked', ticker });

  const costPerShare = Number(req.body.costPerShare);
  const shares = Number(req.body.shares);

  if (!Number.isFinite(costPerShare) || costPerShare <= 0) {
    return res.status(400).json({ error: 'costPerShare must be a positive number' });
  }
  if (!Number.isFinite(shares) || shares <= 0) {
    return res.status(400).json({ error: 'shares must be a positive number' });
  }

  res.json(await setPosition(ticker, costPerShare, shares));
});

app.delete('/api/stocks/:ticker/position', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const stock = await getTrackedStock(ticker);
  if (!stock) return res.status(404).json({ error: 'Ticker not tracked', ticker });

  res.json(await clearPosition(ticker));
});

// Brokerage position import — Robinhood has no official API, so this is the
// credential-free path: the user exports their own CSV from Robinhood (or
// any brokerage) and uploads it here. Preview never writes anything; the
// user reviews/edits the parsed result in the UI and only /apply commits it.
app.post('/api/positions/preview-csv', async (req, res) => {
  const { csvText } = req.body;
  if (!csvText || typeof csvText !== 'string') {
    return res.status(400).json({ error: 'csvText required' });
  }

  const { format, positions, warnings } = parsePositionsCsv(csvText);

  const withTrackedStatus = await Promise.all(positions.map(async p => ({
    ...p,
    isTracked: !!(await getTrackedStock(p.ticker)),
  })));

  res.json({ format, positions: withTrackedStatus, warnings });
});

// E*TRADE connection (OAuth 1.0a — see etradeAuth.js). Read-only: this only
// ever calls E*TRADE's accounts-list and portfolio endpoints, never an
// order/trading endpoint, and everything it finds still goes through the
// same review-then-apply flow as CSV import (POST /api/positions/apply) —
// nothing is written to tracked_companies just from connecting.
app.get('/api/etrade/status', async (req, res) => {
  const connection = await etradeAuth.getConnection();
  res.json({
    configured: etradeAuth.isConfigured(),
    live: etradeAuth.isLive,
    connected: connection?.status === 'connected',
    connectedAt: connection?.connected_at || null,
  });
});

app.post('/api/etrade/connect', async (req, res) => {
  if (!etradeAuth.isConfigured()) {
    return res.status(400).json({ error: 'ETRADE_CONSUMER_KEY/ETRADE_CONSUMER_SECRET aren\'t set yet — see Settings for setup steps.' });
  }
  try {
    const { authorizeUrl } = await etradeAuth.getRequestToken();
    res.json({ authorizeUrl });
  } catch (err) {
    console.error('[etrade/connect]', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to start E*TRADE authorization.' });
  }
});

app.post('/api/etrade/verify', async (req, res) => {
  const { verifierCode } = req.body;
  if (!verifierCode) return res.status(400).json({ error: 'verifierCode required' });

  try {
    await etradeAuth.completeAuthorization(verifierCode);
    res.json({ connected: true });
  } catch (err) {
    console.error('[etrade/verify]', err.response?.data || err.message);
    const msg = err.message === 'NO_PENDING_REQUEST'
      ? 'No pending E*TRADE connection found — click Connect again first.'
      : 'Failed to complete E*TRADE authorization — double check the code.';
    res.status(400).json({ error: msg });
  }
});

app.post('/api/etrade/disconnect', async (req, res) => {
  await etradeAuth.disconnect();
  res.json({ connected: false });
});

app.get('/api/etrade/positions', async (req, res) => {
  try {
    const { positions, warnings } = await etradeSync.getAllPositions();
    const withTrackedStatus = await Promise.all(positions.map(async p => ({
      ...p,
      isTracked: !!(await getTrackedStock(p.ticker)),
    })));
    res.json({ positions: withTrackedStatus, warnings });
  } catch (err) {
    console.error('[etrade/positions]', err.response?.data || err.message);
    const msg = err.message === 'NOT_CONNECTED'
      ? 'Not connected to E*TRADE yet.'
      : 'Failed to fetch E*TRADE positions — see server logs.';
    res.status(err.message === 'NOT_CONNECTED' ? 400 : 500).json({ error: msg });
  }
});

app.post('/api/positions/apply', async (req, res) => {
  const { positions } = req.body;
  if (!Array.isArray(positions) || positions.length === 0) {
    return res.status(400).json({ error: 'positions array required' });
  }

  const applied = [];
  const skipped = [];

  for (const p of positions) {
    const ticker = String(p.ticker || '').toUpperCase();
    const shares = Number(p.shares);
    const costPerShare = Number(p.costPerShare);

    if (!ticker || !Number.isFinite(shares) || shares <= 0 || !Number.isFinite(costPerShare) || costPerShare <= 0) {
      skipped.push({ ticker: ticker || '(blank)', reason: 'Invalid ticker, shares, or cost per share.' });
      continue;
    }

    let stock = await getTrackedStock(ticker);
    if (!stock) {
      if (!p.track) {
        skipped.push({ ticker, reason: 'Not tracked and "track this stock" wasn\'t checked.' });
        continue;
      }
      await trackNewTicker(ticker, p.companyName);
    }

    await setPosition(ticker, costPerShare, shares);
    applied.push(ticker);
  }

  res.json({ applied, skipped, stocks: await getTrackedStocks() });
});

// Per-stock summary feeding the Dashboard's ticker grid — name kept as
// "briefing" for now since the URL is unchanged, but this no longer has
// anything to do with the (removed) email feature.
app.get('/api/briefing/latest', async (req, res) => {
  try {
    const trackedStocks = await getTrackedStocks();
    const stocksData = await Promise.all(
      trackedStocks.map(stock => getStockData(stock.ticker))
    );

    // Sparkline data for the Dashboard cards — one bulk query for every
    // tracked ticker's last 30 trading days instead of N round trips.
    // Shape only (a mini trend line), not an absolute-value comparison
    // across tickers, so SKHY's KRW-denominated rows are fine here even
    // though they're not directly comparable in dollar terms to the rest.
    const sparklineByTicker = {};
    try {
      const { rows: sparkRows } = await dbPool.query(
        `SELECT ticker, trade_date, close FROM daily_prices
          WHERE ticker = ANY($1) AND trade_date >= NOW() - INTERVAL '30 days'
          ORDER BY trade_date ASC`,
        [trackedStocks.map(s => s.ticker)]
      );
      for (const row of sparkRows) {
        (sparklineByTicker[row.ticker] ??= []).push(Number(row.close));
      }
    } catch (err) {
      console.error('Sparkline data fetch failed:', err);
    }

    // Each stock's signal computation is independent of every other stock's,
    // so run all of them concurrently instead of one at a time.
    await Promise.all(stocksData.map(async (stock) => {
      const { scores, plainParts } = await computeAllSignals(stock.ticker, stock);

      stock.explanation = plainParts.length ? plainParts.join(' ') : 'No signal data available';
      stock.activeSignals = scores.length;
      stock.totalSignals = getApplicableSignalOrder(stock.ticker).length;
      const conviction = computeConviction(scores, stock.ticker);
      stock.convictionScore = conviction.score;
      stock.scoreConfidence = conviction.confidence;
      stock.scoreCoveragePct = conviction.coveragePct;
      stock.sparkline = sparklineByTicker[stock.ticker] || [];
    }));

    res.json({ stocks: stocksData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
   
// Builds the full ticker-detail payload (signals, conviction score, bottom
// line, Ask Claude, news, etc). `tracked` may be null — used by
// /api/buy-check/:ticker for a ticker the user hasn't added to tracking yet,
// falling back to the live company profile name and no position/cost basis.
// Throws Error('TICKER_NOT_FOUND') if the ticker has no live quote data at
// all, so callers can 404 instead of the generic 500.
async function buildTickerDetail(ticker, tracked) {
  // stockData (Finnhub/NewsAPI) and priceTarget (Yahoo) are independent —
  // no reason to fetch them one after another.
  const [stockData, priceTargetResult] = await Promise.all([
    getStockData(ticker),
    getPriceTarget(ticker).catch(err => {
      console.error(`Price target lookup failed for ${ticker}:`, err);
      return null;
    }),
  ]);
  const priceTarget = priceTargetResult;

  // Finnhub returns a 200 with an all-zero quote (not an error) for an
  // unknown symbol, so a missing/zero price is the real "not found" signal,
  // not just a missing quote object.
  if (stockData.error || !stockData.quote || !stockData.quote.price) {
    throw new Error('TICKER_NOT_FOUND');
  }

  const companyName = tracked?.name || stockData.profile?.name || ticker;
  const position = tracked?.position || null;

  const { signalsById, scores, plainParts, activeStatuses } = await computeAllSignals(ticker, stockData, position);

  const conviction = computeConviction(scores, ticker);
  const score = conviction.score;
  const scoreBreakdown = conviction.breakdown
    .slice(0, 5)
    .map(b => ({ ...b, label: SIGNAL_ORDER.find(m => m.id === b.id)?.label || b.id }));

  const rawTier = score >= 70 ? 'High' : score >= 50 ? 'Moderate' : 'Low';
  const rawAction = score >= 70 ? 'BUY' : score >= 50 ? 'HOLD' : 'SELL';

  const positionAdvice = applyPositionAwareAdvice({
    score,
    tier: rawTier,
    action: rawAction,
    currentPrice: stockData.quote.price,
    position,
  });
  const { tier, action } = positionAdvice;

  const signalsSummary = plainParts.length
    ? plainParts.join(' ')
    : `No signal data available for ${ticker} yet.`;

  // companyEvents only needs stockData/priceTarget (already resolved), so
  // it can start alongside everything else below; priceMove needs
  // companyEvents' result, so it's chained off that same promise rather
  // than blocking the whole batch on it finishing first.
  const companyEventsPromise = extractCompanyEvents(ticker, companyName, stockData.news, priceTarget, stockData.quote);

  // The verdict, news explanations, upcoming dates, the AI take, the
  // per-signal-card Claude rewrites, company events, and the price-move
  // explainer don't depend on each other (aside from priceMove on
  // companyEvents, handled via the chain above) — run them all
  // concurrently instead of one finishing before the next starts.
  // (aiTake used to wait on the verdict just to mention it as context; it
  // gets the same score/tier directly instead, so that dependency was
  // removable.)
  const [{ badge, headline, reasoning }, newsWithMeaning, upcoming, aiTake, , companyEvents, priceMove] = await Promise.all([
    getVerdict({
      activeCount: scores.length,
      statuses: activeStatuses,
      priceTarget,
      totalSignals: getApplicableSignalOrder(ticker).length,
    }),
    explainNewsForTicker(ticker, companyName, stockData.news),
    Promise.resolve(getUpcomingEvents(stockData.nextEarnings)),
    getAiTake({
      ticker,
      companyName,
      quote: stockData.quote,
      profile: stockData.profile,
      convictionScore: score,
      tier,
      plainParts,
      priceTarget,
      position,
      positionAdvice,
      signalPriceContexts: [
        signalsById.insider_buying?.positionContext && { signal: 'insider_buying', ...signalsById.insider_buying.positionContext },
        signalsById.institutional_buying?.positionContext && { signal: 'institutional_buying', ...signalsById.institutional_buying.positionContext },
      ].filter(Boolean),
    }),
    explainSignalsPlainly(signalsById),
    companyEventsPromise,
    companyEventsPromise.then(events => explainPriceMove({
      ticker,
      companyName,
      changePercent: stockData.quote.changePercent,
      news: stockData.news,
      companyEvents: events,
      plainParts,
    })),
  ]);

  const bottomLine = { verdict: headline, reasoning };

  return {
    ticker,
    companyName,
    quote: stockData.quote,
    profile: stockData.profile,
    priceTarget,
    convictionScore: score,
    scoreConfidence: conviction.confidence,
    scoreCoveragePct: conviction.coveragePct,
    scoreBreakdown,
    tier,
    action,
    activeSignals: scores.length,
    signalQuality: { badge, headline },
    plainEnglish: signalsSummary,
    bottomLine,
    priceMove,
    companyEvents,
    news: newsWithMeaning,
    upcoming,
    aiTake,
    position,
    positionAdvice,
    signals: getApplicableSignalOrder(ticker).map(m => normalize(m, signalsById[m.id]))
  };
}

app.get('/api/ticker/:ticker', async (req, res) => {
  const ticker = String(req.params.ticker || '').toUpperCase();
  const tracked = await getTrackedStock(ticker);

  if (!tracked) {
    return res.status(404).json({ error: 'Ticker not tracked', ticker });
  }

  try {
    res.json(await buildTickerDetail(ticker, tracked));
  } catch (error) {
    console.error(`[ticker/${ticker}]`, error);
    res.status(500).json({ error: 'Failed to build ticker detail' });
  }
});

// "Should I Buy?" — same full breakdown as /api/ticker/:ticker, but works
// for a ticker the user hasn't added to tracking yet (tracked=null), so
// they can get an instant first look before committing to full tracking.
// An untracked ticker only has live-fetched signals available (analyst
// rating, earnings surprise history) — everything sourced from the Python/
// Postgres pipeline (insider buying, congressional trading, etc.) will show
// as "no data yet" until they track it and the scheduled jobs run.
app.get('/api/buy-check/:ticker', async (req, res) => {
  const ticker = String(req.params.ticker || '').toUpperCase();
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(ticker)) {
    return res.status(400).json({ error: `"${ticker}" doesn't look like a valid ticker symbol.` });
  }

  const tracked = await getTrackedStock(ticker);

  try {
    const detail = await buildTickerDetail(ticker, tracked);
    res.json({ ...detail, isTracked: !!tracked });
  } catch (error) {
    if (error.message === 'TICKER_NOT_FOUND') {
      return res.status(404).json({ error: `No market data found for "${ticker}" — double check the ticker symbol.` });
    }
    console.error(`[buy-check/${ticker}]`, error);
    res.status(500).json({ error: 'Failed to build buy check' });
  }
});

// Daily close/volume history for the per-stock price chart — same
// daily_prices table technicalScore.js reads from (see
// fetch_technical_prices.py for why SKHY's rows are actually SK Hynix's
// Korea Exchange listing, priced in KRW, not the thin US OTC line).
app.get('/api/ticker/:ticker/history', async (req, res) => {
  const ticker = String(req.params.ticker || '').toUpperCase();
  const tracked = await getTrackedStock(ticker);

  if (!tracked) {
    return res.status(404).json({ error: 'Ticker not tracked', ticker });
  }

  try {
    const { rows } = await dbPool.query(
      `SELECT trade_date, close, volume
         FROM daily_prices
        WHERE ticker = $1
        ORDER BY trade_date ASC`,
      [ticker]
    );

    res.json({
      ticker,
      currency: ticker === 'SKHY' ? 'KRW' : 'USD',
      history: rows.map(r => ({
        date: r.trade_date instanceof Date ? r.trade_date.toISOString().slice(0, 10) : String(r.trade_date).slice(0, 10),
        close: Number(r.close),
        volume: Number(r.volume),
      })),
    });
  } catch (error) {
    console.error(`[ticker/${ticker}/history]`, error);
    res.status(500).json({ error: 'Failed to load price history' });
  }
});

// Daily conviction-score snapshots for the per-stock score-history chart —
// see the POST /api/internal/snapshot-scores route (near app.listen) for how
// this table gets filled in.
app.get('/api/ticker/:ticker/score-history', async (req, res) => {
  const ticker = String(req.params.ticker || '').toUpperCase();
  const tracked = await getTrackedStock(ticker);

  if (!tracked) {
    return res.status(404).json({ error: 'Ticker not tracked', ticker });
  }

  try {
    const { rows } = await dbPool.query(
      `SELECT snapshot_date, score, confidence, coverage_pct
         FROM score_history
        WHERE ticker = $1
        ORDER BY snapshot_date ASC`,
      [ticker]
    );

    res.json({
      ticker,
      history: rows.map(r => ({
        date: r.snapshot_date instanceof Date ? r.snapshot_date.toISOString().slice(0, 10) : String(r.snapshot_date).slice(0, 10),
        score: r.score,
        confidence: r.confidence,
        coveragePct: r.coverage_pct,
      })),
    });
  } catch (error) {
    console.error(`[ticker/${ticker}/score-history]`, error);
    res.status(500).json({ error: 'Failed to load score history' });
  }
});

// Aggregates every tracked stock that has a position into one portfolio
// summary: total value, today's $/% change (both from live quotes, accurate
// for every ticker), and an approximated 1-year value trend for the
// dashboard chart.
app.get('/api/portfolio', async (req, res) => {
  try {
    const trackedStocks = await getTrackedStocks();
    const positioned = trackedStocks.filter(s => s.position && s.position.shares && s.position.costPerShare);

    if (positioned.length === 0) {
      return res.json({
        holdings: [],
        totalValue: 0,
        totalCostBasis: 0,
        totalGainLossDollar: 0,
        totalGainLossPercent: null,
        totalDayChangeDollar: 0,
        totalDayChangePercent: null,
        history: [],
        historyNote: null,
      });
    }

    const quotes = await Promise.all(positioned.map(s => getStockQuote(s.ticker)));

    const holdings = positioned.map((stock, i) => {
      const quote = quotes[i];
      const price = quote?.c ?? null;
      const changeToday = quote?.d ?? 0;
      const { shares, costPerShare } = stock.position;

      const currentValue = price != null ? shares * price : null;
      const costBasisValue = shares * costPerShare;
      const gainLossDollar = currentValue != null ? currentValue - costBasisValue : null;
      const gainLossPercent = currentValue != null && costBasisValue > 0
        ? (gainLossDollar / costBasisValue) * 100
        : null;
      const dayChangeDollar = price != null ? shares * changeToday : null;

      return {
        ticker: stock.ticker,
        name: stock.name,
        shares,
        costPerShare,
        currentPrice: price,
        currentValue,
        costBasisValue,
        gainLossDollar,
        gainLossPercent,
        dayChangeDollar,
      };
    });

    const totalValue = holdings.reduce((sum, h) => sum + (h.currentValue || 0), 0);
    const totalCostBasis = holdings.reduce((sum, h) => sum + h.costBasisValue, 0);
    const totalDayChangeDollar = holdings.reduce((sum, h) => sum + (h.dayChangeDollar || 0), 0);
    const totalGainLossDollar = totalValue - totalCostBasis;
    const totalGainLossPercent = totalCostBasis > 0 ? (totalGainLossDollar / totalCostBasis) * 100 : null;
    const yesterdayValue = totalValue - totalDayChangeDollar;
    const totalDayChangePercent = yesterdayValue > 0 ? (totalDayChangeDollar / yesterdayValue) * 100 : null;

    // Historical trend — approximate using CURRENT share count x historical
    // close price, not necessarily when the position was actually opened.
    // SKHY is excluded: its daily_prices come from the KRX listing (Korean
    // won), a different currency/series than the actual USD OTC price the
    // position is denominated in — combining them would silently produce a
    // wrong total, so it's left out rather than guessed at.
    const skhyHasPosition = positioned.some(s => s.ticker === 'SKHY');
    const chartable = positioned.filter(s => s.ticker !== 'SKHY');

    let history = [];
    if (chartable.length > 0) {
      const tickers = chartable.map(s => s.ticker);
      const { rows } = await dbPool.query(
        `SELECT ticker, trade_date, close FROM daily_prices WHERE ticker = ANY($1) ORDER BY trade_date ASC`,
        [tickers]
      );

      const byDate = new Map();
      for (const row of rows) {
        const dateKey = row.trade_date instanceof Date
          ? row.trade_date.toISOString().slice(0, 10)
          : String(row.trade_date).slice(0, 10);
        const stock = chartable.find(s => s.ticker === row.ticker);
        const value = stock.position.shares * Number(row.close);
        byDate.set(dateKey, (byDate.get(dateKey) || 0) + value);
      }

      history = Array.from(byDate.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, value]) => ({ date, value }));
    }

    const historyNote = skhyHasPosition
      ? 'Approximated using your current share count × each day\'s historical close price, not necessarily when you actually bought. SKHY is excluded from this trend — its price history comes from a different listing/currency than your tracked position, so it can\'t be reliably combined here (its current value is still included in the totals above).'
      : 'Approximated using your current share count × each day\'s historical close price for the period shown, not necessarily when you actually bought.';

    res.json({
      holdings,
      totalValue,
      totalCostBasis,
      totalGainLossDollar,
      totalGainLossPercent,
      totalDayChangeDollar,
      totalDayChangePercent,
      history,
      historyNote,
    });
  } catch (error) {
    console.error('[portfolio]', error);
    res.status(500).json({ error: 'Failed to build portfolio summary' });
  }
});

// Computes and stores today's conviction score for every tracked stock, one
// row per (ticker, day) — feeds the score-history chart on the ticker page.
// Meant to be called once a day by a scheduled GitHub Actions workflow
// (same pattern as the Python fetch scripts, just hitting this endpoint
// instead of writing to Postgres directly, since the score computation
// itself lives in this file, not a standalone script). Upserts on
// (ticker, snapshot_date) so re-running it the same day is harmless. No
// auth, matching every other route in this API — nothing here is
// sensitive, worst case is an extra snapshot row.
app.post('/api/internal/snapshot-scores', async (req, res) => {
  try {
    const trackedStocks = await getTrackedStocks();
    const results = [];

    for (const stock of trackedStocks) {
      try {
        const stockData = await getStockData(stock.ticker);
        const { scores } = await computeAllSignals(stock.ticker, stockData);
        const conviction = computeConviction(scores, stock.ticker);

        await dbPool.query(
          `INSERT INTO score_history (ticker, snapshot_date, score, confidence, coverage_pct)
           VALUES ($1, CURRENT_DATE, $2, $3, $4)
           ON CONFLICT (ticker, snapshot_date)
           DO UPDATE SET score = EXCLUDED.score, confidence = EXCLUDED.confidence, coverage_pct = EXCLUDED.coverage_pct`,
          [stock.ticker, conviction.score, conviction.confidence, conviction.coveragePct]
        );
        results.push({ ticker: stock.ticker, score: conviction.score, confidence: conviction.confidence });
      } catch (err) {
        console.error(`Score snapshot failed for ${stock.ticker}:`, err);
        results.push({ ticker: stock.ticker, error: err.message });
      }
    }

    res.json({ snapshotDate: new Date().toISOString().slice(0, 10), results });
  } catch (error) {
    console.error('[snapshot-scores]', error);
    res.status(500).json({ error: 'Failed to snapshot scores' });
  }
});

// Every other table in this app is created by the Python fetch scripts
// (each does its own `CREATE TABLE IF NOT EXISTS` on run) — this is the
// first table the Node backend itself owns, so it gets the same idempotent
// pattern rather than a separate migrations setup for one table.
async function ensureSchema() {
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS broker_connections (
      provider TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      request_token TEXT,
      request_token_secret TEXT,
      access_token TEXT,
      access_token_secret TEXT,
      connected_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

const PORT = process.env.PORT || 5000;
ensureSchema()
  .then(() => app.listen(PORT, () => console.log(`Backend running on port ${PORT}`)))
  .catch(err => {
    console.error('Failed to ensure DB schema on startup:', err);
    process.exit(1);
  });
