const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getInstitutionalBuyingSignal } = require('./convictionScore.js');
const { getInsiderBuyingSignal } = require('./insiderScore.js');
const { getShortInterestSignal } = require('./shortInterestScore.js');
const { getOptionsVolumeSignal } = require('./optionsVolumeScore.js');
const { getCongressTradingSignal } = require('./congressTradingScore.js');
const { getGovContractsSignal } = require('./govContractsScore.js');
const { getOffExchangeSignal } = require('./offExchangeScore.js');
const { getWsbSentimentSignal } = require('./wsbSentimentScore.js');
const { getPriceTarget } = require('./priceTargetData.js');
const { getVerdict } = require('./noiseScore.js');
const { explainSignalPlainly } = require('./signalExplainer.js');
const { explainNewsForTicker } = require('./newsExplainer.js');
const { getUpcomingEvents } = require('./upcomingEvents.js');
const { getAiTake } = require('./aiTakeScore.js');
const { applyPositionAwareAdvice } = require('./positionAdvice.js');

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
    const insider = await getInsiderBuyingSignal(ticker, position);

    if (insider.hasSignal && insider.confidenceScore > 0) {
      scores.push(insider.confidenceScore);
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
        trackRecord: 'No data available — requires accumulated history of past buys vs. subsequent price moves.',
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
      scores.push(instScore);
      plainParts.push(signal.explanation);
    }

    signalsById.institutional_buying = {
      hasData: !!d.holderCount,
      status: instScore >= 70 ? 'positive' : instScore >= 50 ? 'neutral' : 'negative',
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

      scores.push(bullishContribution);
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
      scores.push(optVol.confidenceScore);
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
    const congress = await getCongressTradingSignal(ticker);
    const d = congress.detail || {};

    if (congress.hasSignal && congress.confidenceScore > 0) {
      scores.push(congress.confidenceScore);
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
        trackRecord: 'No data available — requires accumulated history of past purchases vs. subsequent price moves.',
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
      scores.push(gov.confidenceScore);
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

      scores.push(bullishContribution);
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

  await Promise.all(signalPromises);

  // Signal 2: Analyst ratings
  const analyst = getAnalystSignal(stockData.recommendations);
  if (analyst) {
    scores.push(analyst.score);
    signalsById.analyst_rating = { ...analyst, hasData: true };
    plainParts.push(`Analyst consensus: ${analyst.headline}.`);
    activeStatuses.push(analyst.status);
  }

  return { signalsById, scores, plainParts, activeStatuses };
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
  { id: 'earnings_whisper',     label: 'Earnings Whisper',      source: null,                    category: 'Analyst & Estimates' },
  { id: 'analyst_rating',       label: 'Analyst Rating Change', source: 'Finnhub',               category: 'Analyst & Estimates' },
  { id: 'short_interest',       label: 'Short Interest',        source: 'FINRA (via Nasdaq)',    category: 'Market Activity' },
  { id: 'options_volume',       label: 'Options Call Volume',   source: 'Yahoo Finance',         category: 'Market Activity' },
  { id: 'off_exchange',        label: 'Off-Exchange Volume',   source: 'Quiver Quantitative',   category: 'Market Activity' },
  { id: 'congress_trading',     label: 'Congressional Trading', source: 'Quiver Quantitative',   category: 'Government & Political' },
  { id: 'gov_contracts',        label: 'Government Contracts',  source: 'Quiver Quantitative',   category: 'Government & Political' },
  { id: 'wsb_sentiment',        label: 'Reddit / WSB Attention', source: 'ApeWisdom',            category: 'Retail Sentiment' }
];

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
    simpleExplanation: (raw && raw.simpleExplanation) || (raw && raw.headline) || 'No signal detected',
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
app.use(express.json());
app.use(cors());

// Data file for storage
const DATA_FILE = path.join(__dirname, 'data.json');

// Load or initialize data
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  return {
   stocks: [
      { ticker: 'RILY', name: 'B. Riley Financial' },
      { ticker: 'SKHY', name: 'SK Hynix' },
      { ticker: 'ASTS', name: 'AST SpaceMobile' },
      { ticker: 'LRCX', name: 'Lam Research' },
      { ticker: 'QCOM', name: 'Qualcomm' },
      { ticker: 'CWBHF', name: 'Charlottes Web' }
    ],
    email: 'joshuamost726@gmail.com',
    briefings: []
  };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let data = loadData();

// API Keys
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;

// Email setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASSWORD
  }
});

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
    const [quote, profile, recommendations, earnings] = await Promise.all([
      getStockQuote(ticker),
      getCompanyProfile(ticker),
      getRecommendationTrends(ticker),
      getEarningsCalendar(ticker),
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

// Generate insight from data
function generateInsight(stockData) {
  if (stockData.error) {
    return `❌ ${stockData.ticker}: ${stockData.error}`;
  }

  const { ticker, quote, profile, recommendations, nextEarnings, news } = stockData;
  const changeColor = quote.change >= 0 ? '📈' : '📉';
  
  let insight = `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  insight += `${changeColor} ${ticker} - ${profile.name}\n`;
  insight += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  insight += `💰 PRICE DATA\n`;
  insight += `Current: $${quote.price.toFixed(2)}\n`;
  insight += `Change: ${quote.change.toFixed(2)} (${quote.changePercent.toFixed(2)}%)\n`;
  insight += `52W High: ${quote.high.toFixed(2)} | 52W Low: ${quote.low.toFixed(2)}\n`;
  insight += `Volume: ${quote.volume ? (quote.volume / 1000000).toFixed(2) + 'M' : 'N/A'}\n`;

  insight += `📊 FUNDAMENTALS\n`;
  insight += `PE Ratio: ${profile.pe !== 'N/A' ? profile.pe.toFixed(2) : 'N/A'}\n`;
  insight += `Market Cap: ${profile.marketCap && profile.marketCap > 0 ? '$' + (profile.marketCap / 1000000000).toFixed(2) + 'B' : 'N/A'}\n`;
  insight += `Industry: ${profile.industry}\n\n`;

  if (recommendations) {
    const total = recommendations.buy + recommendations.hold + recommendations.sell;
    insight += `⭐ ANALYST RATINGS\n`;
    insight += `Buy: ${recommendations.buy} | Hold: ${recommendations.hold} | Sell: ${recommendations.sell}\n`;
    insight += `Consensus: ${Math.round((recommendations.buy / total) * 100)}% Bullish\n\n`;
  }

  if (nextEarnings) {
    insight += `📅 UPCOMING EARNINGS\n`;
    insight += `Date: ${nextEarnings.date || 'TBD'}\n`;
    insight += `EPS Estimate: $${nextEarnings.epsEstimate || 'N/A'}\n\n`;
  }

  if (news.length > 0) {
    insight += `📰 TOP NEWS\n`;
    news.slice(0, 2).forEach((article, idx) => {
      insight += `${idx + 1}. ${article.title}\n   Source: ${article.source}\n\n`;
    });
  }

  return insight;
}

// Main briefing generator
async function sendBriefing() {
  try {
    const stocksData = await Promise.all(
      data.stocks.map(stock => getStockData(stock.ticker))
    );

    let briefingText = '📈 STOCK BRIEFING REPORT\n';
    briefingText += `Generated: ${new Date().toLocaleString()}\n`;
    briefingText += `=====================================\n\n`;

    for (const stock of stocksData) {
  briefingText += generateInsight(stock);
  
  try {
    const signal = await getInstitutionalBuyingSignal(stock.ticker);
    if (signal) {
      briefingText += `\n💡 Smart Money Signal: ${signal.explanation}\n`;
    }
  } catch (error) {
    console.error(`Error fetching conviction score for ${stock.ticker}:`, error.message);
  }
}

    briefingText += `\n=====================================\n`;
    briefingText += `Dashboard: https://stock-briefing-frontend1.vercel.app\n`;

    // Save to history
    data.briefings.push({
      timestamp: new Date().toISOString(),
      content: briefingText,
      stocks: stocksData
    });

    // Keep last 30 briefings
    if (data.briefings.length > 30) {
      data.briefings = data.briefings.slice(-30);
    }
    saveData(data);

    // Send email
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: data.email,
      subject: `📊 Stock Briefing - ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
      text: briefingText,
      html: `<pre style="font-family: monospace; white-space: pre-wrap;">${briefingText}</pre>`
    });

    console.log(`✅ Briefing sent at ${new Date().toISOString()}`);
  } catch (error) {
    console.error('Error sending briefing:', error);
  }
}

// Schedule briefings (UTC times)
// 8 AM UTC
cron.schedule('0 8 * * *', sendBriefing);
// 1 PM UTC
cron.schedule('0 13 * * *', sendBriefing);
// 5 PM UTC
cron.schedule('0 17 * * *', sendBriefing);

// API Routes
app.get('/api/stocks', (req, res) => {
  res.json(data.stocks);
});

app.post('/api/stocks', async (req, res) => {
  const { ticker, name } = req.body;
  if (!ticker) return res.status(400).json({ error: 'Ticker required' });
  
  const exists = data.stocks.find(s => s.ticker === ticker.toUpperCase());
  if (exists) return res.status(400).json({ error: 'Stock already tracked' });
  
  data.stocks.push({ ticker: ticker.toUpperCase(), name: name || ticker });
  saveData(data);
  res.json(data.stocks);
});

app.delete('/api/stocks/:ticker', (req, res) => {
  data.stocks = data.stocks.filter(s => s.ticker !== req.params.ticker.toUpperCase());
  saveData(data);
  res.json(data.stocks);
});

// Phase 6 — cost basis / position tracking, stored in data.json alongside
// the tracked stock list (personal portfolio data, not market data).
app.put('/api/stocks/:ticker/position', (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const stock = data.stocks.find(s => s.ticker === ticker);
  if (!stock) return res.status(404).json({ error: 'Ticker not tracked', ticker });

  const costPerShare = Number(req.body.costPerShare);
  const shares = Number(req.body.shares);

  if (!Number.isFinite(costPerShare) || costPerShare <= 0) {
    return res.status(400).json({ error: 'costPerShare must be a positive number' });
  }
  if (!Number.isFinite(shares) || shares <= 0) {
    return res.status(400).json({ error: 'shares must be a positive number' });
  }

  stock.position = { costPerShare, shares, updatedAt: new Date().toISOString() };
  saveData(data);
  res.json(stock);
});

app.delete('/api/stocks/:ticker/position', (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const stock = data.stocks.find(s => s.ticker === ticker);
  if (!stock) return res.status(404).json({ error: 'Ticker not tracked', ticker });

  delete stock.position;
  saveData(data);
  res.json(stock);
});

app.get('/api/briefings', (req, res) => {
  res.json(data.briefings.slice(-10));
});

app.get('/api/briefing/latest', async (req, res) => {
  try {
    const stocksData = await Promise.all(
      data.stocks.map(stock => getStockData(stock.ticker))
    );

   // Attach conviction score to each stock — same signal set as /api/ticker/:ticker.
    // Each stock's signal computation is independent of every other stock's,
    // so run all 6 concurrently instead of one at a time.
    await Promise.all(stocksData.map(async (stock) => {
      const { scores, plainParts } = await computeAllSignals(stock.ticker, stock);

      stock.explanation = plainParts.length ? plainParts.join(' ') : 'No signal data available';
      stock.activeSignals = scores.length;
      stock.totalSignals = SIGNAL_ORDER.length;
      stock.convictionScore = scores.length
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : 0;
    }));

    let briefing = '📈 STOCK BRIEFING REPORT\n';
    briefing += `Generated: ${new Date().toLocaleString()}\n`;
    briefing += `=====================================\n\n`;

    stocksData.forEach(stock => {
      briefing += generateInsight(stock);
    });

    briefing += `\n=====================================\n`;
    briefing += `Dashboard: https://stock-briefing-frontend1.vercel.app\n`;

    res.json({ briefing, stocks: stocksData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
   
app.get('/api/ticker/:ticker', async (req, res) => {
  const ticker = String(req.params.ticker || '').toUpperCase();
  const tracked = data.stocks.find(s => s.ticker === ticker);

  if (!tracked) {
    return res.status(404).json({ error: 'Ticker not tracked', ticker });
  }

  try {
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

    const { signalsById, scores, plainParts, activeStatuses } = await computeAllSignals(ticker, stockData, tracked.position || null);

    const score = scores.length
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 0;

    const rawTier = score >= 70 ? 'High' : score >= 50 ? 'Moderate' : 'Low';
    const rawAction = score >= 70 ? 'BUY' : score >= 50 ? 'HOLD' : 'SELL';

    const positionAdvice = applyPositionAwareAdvice({
      score,
      tier: rawTier,
      action: rawAction,
      currentPrice: stockData.quote.price,
      position: tracked.position || null,
    });
    const { tier, action } = positionAdvice;

    const signalsSummary = plainParts.length
      ? plainParts.join(' ')
      : `No signal data available for ${ticker} yet.`;

    // The verdict, news explanations, upcoming dates, the AI take, and the
    // per-signal-card Claude rewrites don't depend on each other — run all
    // five concurrently instead of the signal-card rewrites finishing first
    // (which is what happened while that step lived inside
    // computeAllSignals). (aiTake used to wait on the verdict just to
    // mention it as context; it gets the same score/tier directly instead,
    // so that dependency was removable.)
    const [{ badge, headline, reasoning }, newsWithMeaning, upcoming, aiTake] = await Promise.all([
      getVerdict({
        activeCount: scores.length,
        statuses: activeStatuses,
        priceTarget,
        totalSignals: SIGNAL_ORDER.length,
      }),
      explainNewsForTicker(ticker, tracked.name, stockData.news),
      Promise.resolve(getUpcomingEvents(stockData.nextEarnings)),
      getAiTake({
        ticker,
        companyName: tracked.name,
        quote: stockData.quote,
        profile: stockData.profile,
        convictionScore: score,
        tier,
        plainParts,
        priceTarget,
        position: tracked.position || null,
        positionAdvice,
        signalPriceContexts: [
          signalsById.insider_buying?.positionContext && { signal: 'insider_buying', ...signalsById.insider_buying.positionContext },
          signalsById.institutional_buying?.positionContext && { signal: 'institutional_buying', ...signalsById.institutional_buying.positionContext },
        ].filter(Boolean),
      }),
      explainSignalsPlainly(signalsById),
    ]);

    const bottomLine = { verdict: headline, reasoning };

    res.json({
      ticker,
      companyName: tracked.name || ticker,
      quote: stockData.quote,
      profile: stockData.profile,
      priceTarget,
      convictionScore: score,
      tier,
      action,
      activeSignals: scores.length,
      signalQuality: { badge, headline },
      plainEnglish: signalsSummary,
      bottomLine,
      news: newsWithMeaning,
      upcoming,
      aiTake,
      position: tracked.position || null,
      positionAdvice,
      signals: SIGNAL_ORDER.map(m => normalize(m, signalsById[m.id]))
    });
  } catch (error) {
    console.error(`[ticker/${ticker}]`, error);
    res.status(500).json({ error: 'Failed to build ticker detail' });
  }
});

app.post('/api/settings', (req, res) => {
  data.email = req.body.email || data.email;
  saveData(data);
  res.json({ email: data.email });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
