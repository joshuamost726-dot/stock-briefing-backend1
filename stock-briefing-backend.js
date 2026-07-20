const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getInstitutionalBuyingSignal } = require('./convictionScore.js');

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

async function getEarningsCalendar(ticker) {
  try {
    const res = await axios.get(`https://finnhub.io/api/v1/calendar/earnings`, {
      params: {
        symbol: ticker,
        token: FINNHUB_KEY
      }
    });
    return res.data;
  } catch (e) {
    console.error(`Error fetching earnings for ${ticker}:`, e.message);
    return null;
  }
}

async function getNews(ticker) {
  try {
    const res = await axios.get(`https://newsapi.org/v2/everything`, {
      params: {
        q: ticker,
        sortBy: 'publishedAt',
        language: 'en',
        apikey: NEWS_API_KEY,
        pageSize: 5
      }
    });
    return res.data.articles || [];
  } catch (e) {
    console.error(`Error fetching news for ${ticker}:`, e.message);
    return [];
  }
}

// Generate comprehensive briefing
async function getStockData(ticker) {
  try {
    const quote = await getStockQuote(ticker);
    const profile = await getCompanyProfile(ticker);
    const recommendations = await getRecommendationTrends(ticker);
    const earnings = await getEarningsCalendar(ticker);
    const news = await getNews(ticker);

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
      news: news.slice(0, 3).map(n => ({
        title: n.title,
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

app.get('/api/briefings', (req, res) => {
  res.json(data.briefings.slice(-10));
});

app.get('/api/briefing/latest', async (req, res) => {
  try {
    const stocksData = await Promise.all(
      data.stocks.map(stock => getStockData(stock.ticker))
    );

    // Attach conviction score to each stock
    for (const stock of stocksData) {
      try {
        const signal = await getInstitutionalBuyingSignal(stock.ticker);
        stock.convictionScore = signal?.score ?? signal?.convictionScore ?? 0;
        stock.explanation = signal?.explanation ?? 'No signal data available';
      } catch (err) {
        console.error(`Conviction score failed for ${stock.ticker}:`, err.message);
        stock.convictionScore = 0;
        stock.explanation = 'Score unavailable';
      }
    }

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
   

app.post('/api/settings', (req, res) => {
  data.email = req.body.email || data.email;
  saveData(data);
  res.json({ email: data.email });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
