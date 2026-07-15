const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Simple file-based storage for now (upgrade to DB later)
const DATA_FILE = path.join(__dirname, 'data.json');

// Load or initialize data
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  return {
    stocks: [
      { ticker: 'BRC', name: 'Brinks' },
      { ticker: 'SKHY', name: 'Skyline' }
    ],
    email: 'joshuamost726@gmail.com',
    briefings: []
  };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let data = loadData();

// Email setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASSWORD
  }
});

// Get stock data from multiple sources
async function getStockData(ticker) {
  try {
    // Alpha Vantage for price data
    const priceRes = await axios.get(`https://www.alphavantage.co/query`, {
      params: {
        function: 'GLOBAL_QUOTE',
        symbol: ticker,
        apikey: process.env.ALPHA_VANTAGE_KEY
      }
    });

    const quote = priceRes.data['Global Quote'] || {};
    
    // NewsAPI for latest news
    let news = [];
    try {
      const newsRes = await axios.get(`https://newsapi.org/v2/everything`, {
        params: {
          q: ticker,
          sortBy: 'publishedAt',
          language: 'en',
          apikey: process.env.NEWS_API_KEY,
          pageSize: 3
        }
      });
      news = newsRes.data.articles || [];
    } catch (e) {
      console.log(`News fetch failed for ${ticker}`);
    }

    return {
      ticker,
      price: quote['05. price'],
      change: quote['09. change'],
      changePercent: quote['10. change percent'],
      volume: quote['06. volume'],
      timestamp: new Date().toISOString(),
      news: news.slice(0, 2).map(a => ({
        title: a.title,
        source: a.source.name,
        url: a.url,
        publishedAt: a.publishedAt
      }))
    };
  } catch (error) {
    console.error(`Error fetching data for ${ticker}:`, error.message);
    return {
      ticker,
      error: 'Failed to fetch data'
    };
  }
}

// Generate briefing text
function generateBriefing(stocksData) {
  let briefing = '📊 STOCK BRIEFING REPORT\n\n';
  briefing += `Generated: ${new Date().toLocaleString()}\n\n`;

  stocksData.forEach(stock => {
    if (stock.error) {
      briefing += `❌ ${stock.ticker}: ${stock.error}\n\n`;
      return;
    }

    briefing += `━━━ ${stock.ticker} ━━━\n`;
    briefing += `Price: $${stock.price} | Change: ${stock.change} (${stock.changePercent})\n`;
    briefing += `Volume: ${stock.volume}\n`;
    
    if (stock.news.length > 0) {
      briefing += `\nLatest News:\n`;
      stock.news.forEach(n => {
        briefing += `• ${n.title}\n  Source: ${n.source}\n`;
      });
    }
    briefing += '\n';
  });

  return briefing;
}

// Send briefing email
async function sendBriefing() {
  try {
    const stocksData = await Promise.all(
      data.stocks.map(stock => getStockData(stock.ticker))
    );

    const briefingText = generateBriefing(stocksData);

    // Save to history
    data.briefings.push({
      timestamp: new Date().toISOString(),
      content: briefingText,
      stocks: stocksData
    });

    // Keep only last 30 briefings
    if (data.briefings.length > 30) {
      data.briefings = data.briefings.slice(-30);
    }
    saveData(data);

    // Send email
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: data.email,
      subject: `📈 Stock Briefing - ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
      text: briefingText,
      html: `<pre>${briefingText}</pre>`
    });

    console.log(`✅ Briefing sent at ${new Date().toISOString()}`);
  } catch (error) {
    console.error('Error sending briefing:', error);
  }
}

// Schedule briefings
// 8 AM
cron.schedule('0 8 * * *', sendBriefing);
// 1 PM
cron.schedule('0 13 * * *', sendBriefing);
// 5 PM
cron.schedule('0 17 * * *', sendBriefing);

// API Routes
app.get('/api/stocks', (req, res) => {
  res.json(data.stocks);
});

app.post('/api/stocks', (req, res) => {
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
    const briefing = generateBriefing(stocksData);
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
