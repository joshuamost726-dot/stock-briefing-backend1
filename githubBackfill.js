/**
 * githubBackfill.js
 *
 * Triggers an on-demand, single-ticker run of the GitHub Actions workflows
 * that would otherwise only fetch data for a newly tracked stock on their
 * next scheduled run (up to a day away). Reuses the exact same Python fetch
 * scripts as the scheduled jobs — via GitHub's workflow_dispatch API with a
 * `ticker` input — rather than duplicating any fetch logic here or running
 * Python on the Node backend itself (Render's Node service was never set up
 * with a Python runtime; GitHub Actions runners already have it).
 *
 * Only 9 of the fetch scripts qualify: each loops independently over
 * tracked_companies, so scoping to one ticker is a real shortcut. 13F
 * institutional buying (sweep_13f.py) is deliberately excluded — it works
 * by scanning each smart-money fund's *entire* quarterly filing, not by
 * ticker, so there's no faster path for one new stock; it stays tied to the
 * real quarterly SEC filing cycle regardless.
 */

const axios = require('axios');

const GITHUB_TOKEN = process.env.GITHUB_ACTIONS_PAT;
const REPO_OWNER = 'joshuamost726-dot';
const REPO_NAME = 'stock-briefing-backend1';
const BRANCH = 'main';

const BACKFILL_WORKFLOWS = [
  'fetch-form4.yml',
  'fetch-short-interest.yml',
  'fetch-options-volume.yml',
  'fetch-price-targets.yml',
  'fetch-congress-trades.yml',
  'fetch-gov-contracts.yml',
  'fetch-offexchange.yml',
  'fetch-wsb-mentions.yml',
  'fetch-technical-prices.yml',
];

function isConfigured() {
  return !!GITHUB_TOKEN;
}

async function dispatchWorkflow(workflowFile, ticker) {
  await axios.post(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${workflowFile}/dispatches`,
    { ref: BRANCH, inputs: { ticker } },
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );
}

// Fire-and-forget by design — callers don't await this (see
// trackNewTicker() in stock-briefing-backend.js). A slow or failed GitHub
// dispatch shouldn't block or fail the "start tracking this stock" request
// itself, and one bad dispatch shouldn't stop the other 8 from firing.
async function triggerBackfill(ticker) {
  if (!isConfigured()) {
    console.log(`[backfill] Skipped for ${ticker} — GITHUB_ACTIONS_PAT not configured.`);
    return;
  }

  console.log(`[backfill] Triggering on-demand fetch for ${ticker} across ${BACKFILL_WORKFLOWS.length} workflows...`);
  const results = await Promise.allSettled(
    BACKFILL_WORKFLOWS.map(wf => dispatchWorkflow(wf, ticker))
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[backfill] ${BACKFILL_WORKFLOWS[i]} dispatch failed for ${ticker}:`, r.reason?.response?.data || r.reason?.message);
    }
  });
}

module.exports = { triggerBackfill, isConfigured, BACKFILL_WORKFLOWS };
