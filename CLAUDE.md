# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal stock briefing tool for a single user (joshuamost726@gmail.com). A Node.js backend serves
a "conviction score" API and dashboard/portfolio data; a set of Python scripts (run on schedule via
GitHub Actions) fill a Postgres database with SEC/market/Korean-disclosure data that the backend's
scoring functions read from. Three separate, independently deployed pieces:

- **Backend** (`stock-briefing-backend.js`) — Express, deployed to **Render** (free tier).
- **Frontend** (`src/`) — Create React App, deployed to Vercel, talks to the backend via
  `REACT_APP_API_URL`.
- **Data pipeline** (`fetch_*.py`, `sweep_13f.py`, `probe_13f.py`, `parse_def14a.py`) — scheduled
  independently via `.github/workflows/*.yml`, writes directly to the same Postgres DB
  (`DATABASE_URL`) the backend reads from. There is no API between the Python scripts and the
  Node backend — Postgres tables are the integration point.

**Database is Neon** (free tier, serverless Postgres) — migrated off Railway Postgres 2026-07-27.
Everything the app persists lives there now, including tracked stocks and cost-basis positions
(previously a `data.json` file on a mounted volume — folded into `tracked_companies` so hosting no
longer needs persistent-volume support).

**Hosting history**: originally Railway (backend + Postgres). Migrated off entirely 2026-07-27 after
hitting a confirmed, recurring Railway bug (Trial/Free-tier deploys get stuck in a queue with a
misleading "queued due to upstream GitHub issues" message — verified via GitHub's own status page
showing no actual incident, and confirmed as a known bug on Railway's community forum). Now $0/month:
Render (backend, free — spins down after 15 min idle, ~30-60s cold start on first request after a
gap) + Neon (Postgres, free — 0.5GB, the whole DB is ~12MB so nowhere close to a squeeze). Old
Railway project may still exist as a safety net; check before assuming it's gone.

## Commands

Backend (run from repo root):
```
npm start   # node stock-briefing-backend.js
npm run dev # nodemon stock-briefing-backend.js
```

Frontend (Create React App):
```
npm install
npm start   # dev server, expects REACT_APP_API_URL (defaults to http://localhost:5000)
npm run build
```

Python data pipeline (`pip install -r requirements.txt` first; each script needs `DATABASE_URL` set):
```
python fetch_form4.py                       # incremental Form 4 (insider txns), last 7 days
python fetch_form4.py --backfill 365        # one-time backfill
python fetch_sec_data.py                    # institutional holdings (13F) for the smart-money watchlist + exec comp (DEF 14A)
python probe_13f.py                         # dry-run timing probe before running a full 13F sweep
python sweep_13f.py                         # full 13F-HR sweep for one quarter (auto-computes YEAR/QUARTER from run date)
python fetch_short_interest.py              # FINRA short interest via Nasdaq
python fetch_options_volume.py              # Yahoo Finance options call/put volume snapshot
python fetch_price_targets.py               # Yahoo Finance analyst price targets
python fetch_congress_trades.py             # Quiver Quantitative congressional trading
python fetch_gov_contracts.py               # Quiver Quantitative government contracts
python fetch_offexchange.py                 # Quiver Quantitative off-exchange/dark pool volume
python fetch_wsb_mentions.py                # ApeWisdom Reddit/WSB mention volume (free, keyless)
python fetch_technical_prices.py            # yfinance daily price history (technical momentum + per-stock charts)
python fetch_korea_ownership.py             # Open DART executive/major-shareholder ownership changes (SKHY only)
python fetch_korea_major_shareholders.py    # Open DART 5%+ ownership crossings (SKHY only)
python fetch_korea_capital_actions.py       # Open DART buybacks/share issuances (SKHY only)
```

There is no test suite, linter, or CI check configured in this repo — GitHub Actions runs the
scheduled data-fetch scripts (each now pings a healthchecks.io dead-man's-switch on success/failure;
see "Uptime monitoring" below), not any validation.

## Architecture

### Conviction score system — 14 signals

The backend combines every *applicable* signal (see `getApplicableSignalOrder(ticker)` — not every
signal applies to every ticker) into one 0-100 "conviction score" per ticker, returned by
`GET /api/ticker/:ticker`. Each signal lives in its own `*Score.js` module (or inline in
`stock-briefing-backend.js` for a couple of the simpler ones) and is deliberately conservative about
claiming a signal exists — insufficient data means `hasSignal: false` / a "No Data" state, never an
invented number. `SIGNAL_ORDER` in `stock-briefing-backend.js` is the canonical list:

**Company Filings**: `insider_buying` (Form 4, only open-market buys scored), `institutional_buying`
(13F, capped until quarter-over-quarter data exists), `korea_ownership`/`korea_major_shareholder`/
`korea_capital_actions` (SKHY-only, Open DART).

**Analyst & Estimates**: `earnings_surprise` (Finnhub actual-vs-estimate EPS history, last 4
quarters — status requires the *average* surprise to agree with the beat/miss *frequency* before
calling it positive/negative, otherwise neutral; don't let one severe miss get diluted into a
misleadingly "positive" label just because 3 of 4 quarters technically beat), `analyst_rating`
(Finnhub recommendation trends).

**Market Activity**: `short_interest` (FINRA via Nasdaq), `options_volume` (Yahoo Finance),
`off_exchange` (Quiver Quantitative dark pool volume — known persistent Quiver-side 500 for RILY),
`technical_momentum` (50/200-day moving average cross + 52-week range + volume confirmation — the
one signal that applies to every ticker regardless of disclosure regime; SKHY uses `000660.KS`
(actual KRX listing) for this, not the thin US OTC line).

**Government & Political**: `congress_trading`, `gov_contracts` (both Quiver Quantitative, only
purchases/awards scored as conviction).

**Retail Sentiment**: `wsb_sentiment` (ApeWisdom mention volume — context-only, deliberately NOT
factored into the blended conviction score since mention volume alone has no established directional
relationship to price).

`getApplicableSignalOrder(ticker)` filters out signals that are structurally impossible for a given
ticker (`INAPPLICABLE_SIGNALS_BY_TICKER`) and Korea-only signals for every ticker except SKHY
(`KOREA_ONLY_SIGNALS`) — these are removed from that ticker's list and total count entirely, not left
as dead "No Data" cards.

Each module returns `{ confidenceScore/score, hasSignal/hasData, label, explanation/headline, detail }`
and a `validation` object (`timing`, `scaleVsSalary`, `trackRecord`, `corroboration`). When adding or
modifying a signal, preserve this pattern — a signal with insufficient data says plainly why rather
than inventing a number.

`GET /api/ticker/:ticker` averages whichever signals returned a nonzero score into `convictionScore`,
then maps it to `tier`/`action` (>=70 High/BUY, >=50 Moderate/HOLD, else Low/SELL) —
**position-adjusted** via `positionAdvice.js` if the user has a tracked cost basis (see below). The
separate `bottomLine.verdict` comes from `noiseScore.js`'s `getVerdict()`, classifying "Real vs.
Noise" from active signal count/agreement — badge/headline are rule-based and deterministic; only
`reasoning` is Claude-rewritten (`claude-haiku-4-5`), falling back to rule-based text if
`ANTHROPIC_API_KEY` is unset or the call fails.

### Claude-generated text is bullet points, not prose (as of 2026-07-27)

Three places generate Claude prose, and all three now return a **JSON array of short bullet
strings**, not a paragraph — `signalExplainer.js` (per-signal-card explanation), `noiseScore.js`
(Bottom Line reasoning), `aiTakeScore.js` (Ask Claude). Parsed via shared `claudeBullets.js`
(`parseBulletArray`, handles markdown-fenced JSON and falls back to line-splitting). Frontend renders
via `BulletList.jsx` (falls back to a plain `<p>` for a single-item array). System prompts explicitly
forbid chaining two ideas into one bullet with a semicolon/em-dash/"and" — Claude will still do this
occasionally in Ask Claude specifically (which is deliberately allowed to reason freely, unlike the
fact-constrained signal cards/Bottom Line), so some bullet length there is inherent to the feature,
not a bug to keep chasing.

### Ask Claude vs. Bottom Line vs. per-signal explanations

Three distinct Claude call sites with different constraints — don't blur them:
- **Per-signal explanation** (`signalExplainer.js`) — restricted to restating only the structured
  facts given for that one signal.
- **Bottom Line** (`noiseScore.js`) — restricted to explaining the rule-based classification (badge/
  headline are fixed and must not be contradicted), synthesizing across all active signals.
- **Ask Claude** (`aiTakeScore.js`) — deliberately unrestricted, may draw on Claude's own knowledge
  and disagree with the tool's own verdict. Never scored into `convictionScore`. The one place that
  synthesizes "what should I do with MY position" when a cost basis is tracked (see
  `signalPriceContext.js` for the shared price-vs-cost-basis comparison facts feeding this and the
  insider/institutional signal cards).

### Position-aware advice

`positionAdvice.js` — a BUY call only survives already-in-profit if score >= 80, and only survives
averaging-down-at-a-loss if score >= 85 (deliberately the higher bar, since catching a falling
position is the riskier chase pattern). SELL/HOLD are never blocked by position status. Position data
(`cost_per_share`, `shares`, `position_updated_at`) lives on `tracked_companies` in Postgres — see
"Data flow" below.

### Data flow

1. GitHub Actions cron jobs run the Python scripts on independent schedules (see
   `.github/workflows/`), each writing to its own Postgres table. Scripts use `INSERT ... ON
   CONFLICT` upserts keyed on natural keys, so they're safe to re-run. **Every workflow pings a
   healthchecks.io check on success/failure** (see "Uptime monitoring" below) — this catches a
   script that exits 0 but silently wrote nothing, which GitHub's own failure-only email alert can't.
2. `stock-briefing-backend.js` queries Postgres (via the `*Score.js` modules) and external live
   APIs (Finnhub for quotes/profile/recommendations/earnings/earnings-surprise-history, NewsAPI for
   news) on each request — there's no caching layer.
3. **Tracked stocks + cost-basis positions live in `tracked_companies` (Postgres)**, not a
   `data.json` file — `getTrackedStocks()`/`getTrackedStock()`/`setPosition()`/`clearPosition()` in
   `stock-briefing-backend.js`. This table is also the single ticker-list source every Python fetch
   script reads from (`SELECT ticker FROM tracked_companies`), so adding a stock via Settings
   automatically gives it every signal that's structurally possible — no manual script edits.
4. `POST`/`DELETE /api/stocks` auto-resolve a new ticker's CIK via SEC's free bulk
   `company_tickers.json` lookup and write straight to `tracked_companies`.
5. **Smart-money fund watchlist** (`smart_money_watchlist` table, read by `fetch_sec_data.py`) — same
   source-of-truth pattern as `tracked_companies`: `fund_name` is the primary key (not `fund_cik`,
   which would block storing a fund before its CIK is resolved), `fund_cik` nullable and cached back
   to the DB the first time it's resolved by name search, so it's never re-resolved on subsequent
   runs. Hardcoded fallback list (`FALLBACK_WATCHLIST`) only used if the table is unreachable. No
   Settings UI for managing this list (unlike tracked stocks) — edit the table directly if the
   watchlist ever needs to change.
6. `sweep_13f.py` computes `YEAR`/`QUARTER` from the run date automatically (20th of Feb/May/Aug/Nov,
   a few days after each quarter's 45-day SEC filing deadline) — scheduled, not manual-only.
7. Foreign-listed tickers (SKHY, CWBHF) are intentionally excluded from US-only data sources — see
   `getApplicableSignalOrder`'s `INAPPLICABLE_SIGNALS_BY_TICKER`.

### Uptime monitoring (added 2026-07-27)

Two layers, deliberately redundant since they catch different failure modes:
1. **GitHub's own failure-only email notification** — catches a script that crashes (non-zero exit).
   Confirmed enabled in account notification settings (Settings → Notifications → Actions).
2. **healthchecks.io dead-man's-switch** — one check per scheduled workflow (12 total), each
   matching that workflow's real cron schedule, pinged as the last step of each `.yml` (`if:
   success()` / `if: failure()`). Catches a script that exits 0 but wrote nothing — which actually
   happened once already: a schema migration silently dropped `DEFAULT NOW()` on `fetched_at`
   columns, causing every upsert to fail on a `NOT NULL` violation that the Python scripts'
   per-ticker `try/except` swallowed without failing the job. **Lesson: a workflow's "success" status
   is not proof data actually landed — check the database directly when it matters.**

## Environment variables

Backend (Render): `FINNHUB_API_KEY`, `NEWS_API_KEY`, `DATABASE_URL` (Neon connection string),
`ANTHROPIC_API_KEY` (optional — without it, Claude-written bullets fall back to rule-based text
everywhere), `ALPHA_VANTAGE_KEY` (documented but not currently called by any code path). Frontend
(Vercel): `REACT_APP_API_URL` (must point at the Render backend's URL — this is baked in at React
*build* time, not read at runtime, so changing it requires a redeploy, and verifying it took effect
means checking the actual bundled JS, not just the env var setting).

Python scripts (GitHub Actions secrets): `DATABASE_URL` (same Neon string), plus
`QUIVER_API_KEY`/`OPENDART_API_KEY` for the scripts that need them.

There used to be an automated email briefing feature (Nodemailer + node-cron, `GMAIL_USER`/
`GMAIL_PASSWORD`) — removed entirely (2026-07-24) in favor of the website as the only interface.
