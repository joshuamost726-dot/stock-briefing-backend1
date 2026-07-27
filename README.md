# 📈 Stock Briefing Tool

A personal "smart money tracker" dashboard for a small set of tracked stocks. Combines 14
independent signals (insider buying, institutional/13F activity, short interest, options volume,
congressional trading, government contracts, Reddit/WSB attention, Korean disclosure data for
foreign-listed tickers, technical momentum, earnings surprise history, and more) into one 0-100
conviction score per ticker, with Claude-generated plain-English bullet points throughout.

There's no automated email — everything lives on the website (Dashboard + per-ticker pages +
Settings), updated by scheduled data-fetch jobs running in the background.

## What it does

- **Dashboard** — every tracked stock's conviction score at a glance, plus a portfolio summary
  (total value, today's $/% change, a value trend chart) if you've entered cost-basis positions.
- **Per-ticker pages** — the full signal breakdown grouped by category, a price history chart, news
  with a one-line Claude explanation of what each headline means for the stock, upcoming dates
  (earnings, next 13F sweep, etc.), a "bottom line" verdict, and a separate "Ask Claude" section with
  a genuinely opinionated (not fact-restricted) AI take — all Claude-generated text renders as short
  bullet points, not paragraphs.
- **Position tracking** — enter your cost basis and share count per ticker (on the ticker page or in
  bulk via Settings) and BUY/HOLD/SELL calls adjust for whether you'd be chasing a stock that's
  already run, or averaging down on a loser.
- **Settings** — manage your tracked stock list and every position in one place.

Signals that are structurally impossible for a given ticker (e.g. FINRA short interest for a
foreign-listed stock) are automatically excluded from that ticker's signal count, rather than sitting
around forever as an empty "No Data" card.

## Architecture

Three independently deployed pieces:

- **Backend** (`stock-briefing-backend.js`) — Express, deployed to **Render** (free tier). Serves the
  API; reads from Postgres (via each `*Score.js` signal module) and calls a few live APIs (Finnhub,
  NewsAPI, Anthropic) directly on each request.
- **Frontend** (`src/`) — Create React App, deployed to Vercel, talks to the backend via
  `REACT_APP_API_URL`.
- **Data pipeline** (`fetch_*.py`, `sweep_13f.py`) — Python scripts scheduled independently via
  GitHub Actions (see `.github/workflows/`), writing directly to the same **Neon** Postgres database
  the backend reads from. No API between the scripts and the backend — Postgres is the integration
  point.

**Database**: Neon (free tier, serverless Postgres). Tracked stocks and cost-basis positions live in
the `tracked_companies` table — there's no separate `data.json` file or persistent-volume dependency.

See `CLAUDE.md` for the full architecture writeup (signal-by-signal breakdown, data flow, known
quirks, migration history).

## Setup

### 1. Environment variables

Backend (Render) needs, at minimum:
```
FINNHUB_API_KEY=...      # quotes, profile, analyst ratings, earnings calendar + surprise history
NEWS_API_KEY=...         # news headlines
DATABASE_URL=...         # Neon Postgres connection string
ANTHROPIC_API_KEY=...    # optional — without it, Claude-written bullets fall back to rule-based text everywhere
ALPHA_VANTAGE_KEY=...    # documented but not currently called by any code path
```
See `.env.example`.

The Python data pipeline (run via GitHub Actions — set these as **repository secrets**, not backend
env vars) needs `DATABASE_URL` (same Neon string), plus `QUIVER_API_KEY` and `OPENDART_API_KEY` for
the specific scripts that use them (congressional trading/gov contracts/off-exchange volume, and the
Korea-specific signals, respectively).

### 2. Deploy

- **Backend**: push to the GitHub repo Render is connected to; it auto-deploys. Build command
  `npm install`, start command `node stock-briefing-backend.js` (Render may auto-detect the repo as
  Python since `requirements.txt` sits at the same root — override both commands manually if so).
- **Frontend**: push to the GitHub repo Vercel is connected to, with `REACT_APP_API_URL` set to the
  Render backend's URL. This env var is baked in at build time — a redeploy is required after
  changing it, and the fastest way to verify it took effect is checking the actual bundled JS for the
  new hostname, not just the env var setting or a 200 status.
- **Data pipeline**: each script in `.github/workflows/*.yml` runs on its own schedule automatically
  once its secrets are set; most also support a manual `workflow_dispatch` trigger from the Actions
  tab for testing. Each workflow also pings a healthchecks.io check on success/failure — see
  "Uptime monitoring" in `CLAUDE.md`.

### 3. Adding a stock

Add it in the Settings page. The backend auto-resolves its SEC CIK and writes it to the shared
`tracked_companies` table, which every Python fetch script reads its ticker list from — so a newly
added stock automatically picks up every signal that's structurally possible for it, no manual script
edits needed.

## Cost

Personal-use budget, roughly $50/month target: hosting **$0** (Render + Neon, both free tier —
moved off Railway 2026-07-27 after a confirmed, recurring Railway deploy-queue bug), Quiver
Quantitative Hobbyist tier ($30/mo), Anthropic API usage (~$0.50-1.50/mo at Haiku pricing), domain
(~$1-2/mo if you set one up). Open DART, ApeWisdom, Finnhub's free tier, NewsAPI's free tier, and
yfinance are all free.

## Troubleshooting

**"A signal always shows 'No Data' for one ticker"** — check whether that signal is structurally
possible for that ticker at all (see `CLAUDE.md`'s per-ticker exclusion notes) before assuming
something's broken.

**"The Render backend feels slow on first load"** — free tier spins down after 15 minutes of
inactivity; the first request after a gap takes ~30-60 seconds to wake it back up. Not a bug.

**"A scheduled fetch script's GitHub Actions run says success, but the data doesn't look fresh"** —
don't trust the green checkmark alone; a script can exit 0 while silently writing nothing (this has
happened before — see `CLAUDE.md`'s uptime-monitoring note). Check the actual database, or the
matching healthchecks.io check's last-ping time.
