---
name: stock-signals
description: Conventions for building and modifying scoring signals in the Conviction Score system (convictionScore.js, insiderScore.js, shortInterestScore.js, optionsVolumeScore.js). Use when adding a new signal, modifying scoring logic, or touching how signals combine into the final 0-100 score.
---

# Stock Signal Scoring Conventions

## Architecture
Each signal module (e.g. `insiderScore.js`) is a standalone scorer that:
- Takes raw data as input (from DB tables like `tracked_companies`, `executive_compensation`)
- Returns a normalized score from 0-100
- Includes a `signalQuality`/`freshness` indicator alongside the score

`convictionScore.js` is itself just one signal module (institutional buying), same
shape as `insiderScore.js`. The actual aggregation — averaging whichever signals
returned a nonzero score into the final composite score — happens in the
`/api/ticker/:ticker` route handler in `stock-briefing-backend.js`, not in
`convictionScore.js`.

## Adding a new signal
1. Create `newSignalScore.js` following the same input/output shape as existing
   signal modules (score 0-100 + signalQuality + freshness)
2. Wire it into the aggregation logic in `stock-briefing-backend.js`'s
   `/api/ticker/:ticker` route handler (fetch the signal, push its score into
   `scores` if nonzero, add it to `SIGNAL_ORDER`/`signalsById`)
3. Add a data-fetching step if new data is needed (follow the pattern in
   `fetch_sec_data.py` for scraped data, or a new fetch script for API data)
4. Update `/api/ticker/:ticker` response shape if the frontend needs the new field
5. Update the Glossary page to explain the new signal in plain English

## Data conventions
- Tickers are pulled from the `tracked_companies` DB table — never hardcode ticker
  lists in new scripts
- SEC filing data goes through Python scripts (`parse_def14a.py` pattern);
  API-based data goes through Node/Express

## Things to double check before committing
- Validate any package.json changes are syntactically correct JSON (this has
  broken Vercel/deploy builds before)
- Confirm new frontend fields are actually wired into the relevant page
  (TickerDetail.jsx, Dashboard.jsx) — don't assume a backend field auto-appears
