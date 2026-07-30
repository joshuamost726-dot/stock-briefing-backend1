/**
 * etradeAuth.js
 *
 * E*TRADE's API uses 3-legged OAuth 1.0a — the older request-token/
 * authorize/access-token dance, not a modern OAuth2 redirect. The user's
 * actual E*TRADE password is never seen by this app at any point: they log
 * in on E*TRADE's own site (us.etrade.com), and what comes back is a
 * request token this app exchanges for an access token, using a
 * consumer key/secret that identify the app itself (from
 * ETRADE_CONSUMER_KEY/ETRADE_CONSUMER_SECRET — the user registers a free
 * developer app at developer.etrade.com to get these; see Settings for the
 * exact steps).
 *
 * Signing (HMAC-SHA1 over a normalized request) is delegated to the
 * `oauth-1.0a` library rather than hand-rolled — this is exactly the kind
 * of security-sensitive plumbing where a well-tested library beats custom
 * code, unlike most of this codebase's "no dependency, hand-roll it"
 * pattern (see PriceChart.jsx, CategoryIcon.jsx).
 *
 * Defaults to E*TRADE's Sandbox environment (fake account data, no real
 * money or real holdings touched) via ETRADE_ENV — nothing points at a
 * live account until that's explicitly switched to "live".
 */

const axios = require('axios');
const crypto = require('crypto');
const OAuth = require('oauth-1.0a');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const CONSUMER_KEY = process.env.ETRADE_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.ETRADE_CONSUMER_SECRET;
const IS_LIVE = (process.env.ETRADE_ENV || 'sandbox').toLowerCase() === 'live';

const API_BASE = IS_LIVE ? 'https://api.etrade.com' : 'https://apisb.etrade.com';
// The user-facing authorize page always lives on etrade.com itself, even
// when the request/access token calls above go to the sandbox API host.
const AUTHORIZE_BASE = 'https://us.etrade.com/e/t/etws/authorize';

function isConfigured() {
  return !!(CONSUMER_KEY && CONSUMER_SECRET);
}

const oauth = CONSUMER_KEY && CONSUMER_SECRET
  ? new OAuth({
      consumer: { key: CONSUMER_KEY, secret: CONSUMER_SECRET },
      signature_method: 'HMAC-SHA1',
      hash_function(baseString, key) {
        return crypto.createHmac('sha1', key).update(baseString).digest('base64');
      },
    })
  : null;

async function signedRequest({ url, method = 'GET', token }) {
  const requestData = { url, method };
  const authHeader = oauth.toHeader(oauth.authorize(requestData, token));
  const res = await axios({ url, method, headers: { ...authHeader, Accept: 'application/json' } });
  return res.data;
}

// E*TRADE's request/access-token responses are classic
// "oauth_token=x&oauth_token_secret=y" query-string form, not JSON.
function parseTokenResponse(body) {
  const params = new URLSearchParams(body);
  return { token: params.get('oauth_token'), secret: params.get('oauth_token_secret') };
}

async function getRequestToken() {
  if (!isConfigured()) throw new Error('ETRADE_NOT_CONFIGURED');

  const url = `${API_BASE}/oauth/request_token`;
  const requestData = { url, method: 'GET', data: { oauth_callback: 'oob' } };
  const authHeader = oauth.toHeader(oauth.authorize(requestData));
  const res = await axios.get(url, { headers: authHeader, params: { oauth_callback: 'oob' } });
  const { token, secret } = parseTokenResponse(res.data);

  // Request tokens are only good for a few minutes while the user is over
  // on E*TRADE's site approving access — stored just long enough to survive
  // that round trip, not treated as a durable credential.
  await pool.query(
    `INSERT INTO broker_connections (provider, request_token, request_token_secret, status, updated_at)
     VALUES ('etrade', $1, $2, 'pending', NOW())
     ON CONFLICT (provider) DO UPDATE SET
       request_token = EXCLUDED.request_token,
       request_token_secret = EXCLUDED.request_token_secret,
       status = 'pending',
       updated_at = NOW()`,
    [token, secret]
  );

  return {
    token,
    authorizeUrl: `${AUTHORIZE_BASE}?key=${encodeURIComponent(CONSUMER_KEY)}&token=${encodeURIComponent(token)}`,
  };
}

async function completeAuthorization(verifierCode) {
  if (!isConfigured()) throw new Error('ETRADE_NOT_CONFIGURED');

  const { rows } = await pool.query(
    `SELECT request_token, request_token_secret FROM broker_connections WHERE provider = 'etrade' AND status = 'pending'`
  );
  if (!rows[0]) throw new Error('NO_PENDING_REQUEST');

  const url = `${API_BASE}/oauth/access_token`;
  const token = { key: rows[0].request_token, secret: rows[0].request_token_secret };
  const requestData = { url, method: 'GET', data: { oauth_verifier: verifierCode } };
  const authHeader = oauth.toHeader(oauth.authorize(requestData, token));
  const res = await axios.get(url, {
    headers: authHeader,
    params: { oauth_verifier: verifierCode },
  });
  const { token: accessToken, secret: accessSecret } = parseTokenResponse(res.data);

  await pool.query(
    `UPDATE broker_connections
        SET access_token = $1, access_token_secret = $2, status = 'connected',
            request_token = NULL, request_token_secret = NULL, connected_at = NOW(), updated_at = NOW()
      WHERE provider = 'etrade'`,
    [accessToken, accessSecret]
  );

  return { connected: true };
}

async function getConnection() {
  const { rows } = await pool.query(
    `SELECT status, connected_at FROM broker_connections WHERE provider = 'etrade'`
  );
  return rows[0] || null;
}

async function getAccessToken() {
  const { rows } = await pool.query(
    `SELECT access_token, access_token_secret FROM broker_connections WHERE provider = 'etrade' AND status = 'connected'`
  );
  if (!rows[0]) throw new Error('NOT_CONNECTED');
  return { key: rows[0].access_token, secret: rows[0].access_token_secret };
}

async function disconnect() {
  await pool.query(`DELETE FROM broker_connections WHERE provider = 'etrade'`);
}

module.exports = {
  isConfigured,
  isLive: IS_LIVE,
  apiBase: API_BASE,
  getRequestToken,
  completeAuthorization,
  getConnection,
  getAccessToken,
  signedRequest,
  disconnect,
};
