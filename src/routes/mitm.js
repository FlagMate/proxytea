/**
 * Transparent Server-Side MITM Reverse Proxy Route.
 *
 * Capabilities:
 * 1. Transparent Forwarding:
 *    - Client calls /mitm with header `x-target-url: https://...` (or `x-sdm-target-url` or ?url=).
 *    - Forwards request method, raw body, and sanitized headers server-to-server.
 *    - Upstream server sees the request originating from this server's IP (e.g. USA server).
 *    - Streams/sends back the exact raw response status, headers, and body with permissive CORS.
 *
 * 2. Optional Server-Side MITM:
 *    - If API key is provided (`x-sdm-api-key`, `x-api-key`, `?key=`, `?apiKey=`),
 *      active workspace rules are evaluated (mocks, headers, deep merges, delays)
 *      before forwarding and before returning.
 *
 * 3. CORS Preflight:
 *    - Handles OPTIONS requests with dynamic origin mirroring, credentials support,
 *      and wildcard allowed headers.
 */
const express = require('express');
const { Readable } = require('stream');
const { mongoose } = require('../config/db');
const ApiKey = require('../models/ApiKey');
const Rule = require('../models/Rule');
const Workspace = require('../models/Workspace');
const { toProxyRule } = require('../lib/ruleSchema');
const { processServerMitm, delay } = require('../lib/mitm');

const router = express.Router();

// Parse all bodies as raw buffer to preserve exact binary, text, and JSON bytes
router.use(express.raw({ type: '*/*', limit: '50mb' }));

// Hop-by-hop headers that should not be forwarded directly
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
}

async function resolveApiKeyAndRules(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return [];
  const keyStr = rawKey.trim();
  if (!keyStr) return [];

  let keyDoc = null;
  try {
    const keyHash = ApiKey.hashKey(keyStr);
    keyDoc = await ApiKey.findOne({ keyHash, revoked: false });
  } catch {}

  if (!keyDoc && mongoose.Types.ObjectId.isValid(keyStr)) {
    try {
      keyDoc = await ApiKey.findOne({ _id: keyStr, revoked: false });
    } catch {}
  }

  if (!keyDoc) {
    try {
      keyDoc = await ApiKey.findOne({ name: keyStr, revoked: false });
    } catch {}
  }

  if (!keyDoc) return [];

  keyDoc.lastUsedAt = new Date();
  keyDoc.save().catch(() => {});

  const keyRuleCount = await Rule.countDocuments({ apiKey: keyDoc._id, enabled: true });
  let filter = { enabled: true };

  if (keyRuleCount > 0) {
    filter.apiKey = keyDoc._id;
  } else if (keyDoc.workspace) {
    const ws = await Workspace.findById(keyDoc.workspace);
    if (ws && ws.activeProfile) {
      filter.profile = ws.activeProfile;
    } else {
      filter.workspace = keyDoc.workspace;
    }
  }

  const dbRules = await Rule.find(filter).sort({ priority: 1, createdAt: 1 });
  return dbRules.map(toProxyRule);
}

// Preflight handler
router.options('*', (req, res) => {
  applyCors(req, res);
  return res.sendStatus(204);
});

// All HTTP methods handler
router.all('*', async (req, res) => {
  if (req.method === 'OPTIONS') {
    applyCors(req, res);
    return res.sendStatus(204);
  }

  const targetUrl =
    req.headers['x-target-url'] ||
    req.headers['x-sdm-target-url'] ||
    req.headers['x-forwarded-url'] ||
    req.query?.url;

  if (!targetUrl || typeof targetUrl !== 'string') {
    applyCors(req, res);
    res.setHeader('x-sdm-error', 'Missing target URL');
    return res.status(400).json({
      error: 'Missing required target URL header "x-target-url" or query param "?url="'
    });
  }

  try {
    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
    } catch (parseErr) {
      applyCors(req, res);
      res.setHeader('x-sdm-error', 'Invalid target URL');
      return res.status(400).json({ error: `Invalid target URL: ${targetUrl}` });
    }

    // Filter incoming headers
    const incomingHeaders = req.headers || {};
    const cleanHeaders = {};
    for (const [key, val] of Object.entries(incomingHeaders)) {
      const lowerKey = key.toLowerCase();
      if (
        !HOP_BY_HOP_HEADERS.has(lowerKey) &&
        lowerKey !== 'x-target-url' &&
        lowerKey !== 'x-sdm-target-url' &&
        lowerKey !== 'x-forwarded-url' &&
        lowerKey !== 'x-sdm-api-key' &&
        lowerKey !== 'x-api-key' &&
        lowerKey !== 'x-server-override'
      ) {
        cleanHeaders[key] = val;
      }
    }
    // Set proper upstream host header
    cleanHeaders['host'] = parsedTarget.host;

    // Check for API key to evaluate workspace rules
    const apiKey =
      req.headers['x-sdm-api-key'] ||
      req.headers['x-api-key'] ||
      req.query?.key ||
      req.query?.apiKey;

    let rules = [];
    if (apiKey) {
      rules = await resolveApiKeyAndRules(apiKey);
    }

    let mitmPlan = null;
    if (rules.length > 0) {
      const rawBodyStr = Buffer.isBuffer(req.body)
        ? req.body.toString('utf8')
        : (typeof req.body === 'string' ? req.body : undefined);

      mitmPlan = await processServerMitm({
        url: targetUrl,
        method: req.method,
        headers: cleanHeaders,
        body: rawBodyStr,
        rules,
      });

      if (mitmPlan.isBlocked) {
        applyCors(req, res);
        res.setHeader('x-sdm-mitm', 'blocked');
        return res.status(403).send('Blocked by Super Debug rule');
      }

      if (mitmPlan.isMocked) {
        if (mitmPlan.preDelay > 0) await delay(mitmPlan.preDelay);
        applyCors(req, res);
        res.setHeader('x-sdm-mitm', 'mocked');
        const mockStatus = mitmPlan.mockResponse.status || 200;
        if (mitmPlan.mockResponse.headers) {
          for (const [k, v] of Object.entries(mitmPlan.mockResponse.headers)) {
            res.setHeader(k, v);
          }
        }
        return res.status(mockStatus).send(
          typeof mitmPlan.mockResponse.data === 'string'
            ? mitmPlan.mockResponse.data
            : JSON.stringify(mitmPlan.mockResponse.data)
        );
      }

      if (mitmPlan.preDelay > 0) {
        await delay(mitmPlan.preDelay);
      }
    }

    const fetchOpts = {
      method: mitmPlan ? mitmPlan.targetMethod : req.method,
      headers: mitmPlan ? mitmPlan.reqHeaders : cleanHeaders,
    };

    if (fetchOpts.method !== 'GET' && fetchOpts.method !== 'HEAD') {
      if (mitmPlan && mitmPlan.reqBody !== undefined) {
        fetchOpts.body = mitmPlan.reqBody;
      } else if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        fetchOpts.body = req.body;
      }
    }

    const upstreamTarget = mitmPlan ? mitmPlan.targetUrl : targetUrl;
    const upstreamRes = await fetch(upstreamTarget, fetchOpts);

    applyCors(req, res);

    // Forward upstream response headers (strip content-encoding since fetch automatically decompresses body)
    upstreamRes.headers.forEach((val, key) => {
      const lower = key.toLowerCase();
      if (!HOP_BY_HOP_HEADERS.has(lower) && !lower.startsWith('access-control-') && lower !== 'content-encoding') {
        res.setHeader(key, val);
      }
    });

    res.status(upstreamRes.status);

    if (mitmPlan && mitmPlan.postDelay > 0) {
      await delay(mitmPlan.postDelay);
    }

    // Apply response transforms if rules defined them
    if (mitmPlan && mitmPlan.transformResponse) {
      const text = await upstreamRes.text();
      const upstreamHeaders = {};
      upstreamRes.headers.forEach((v, k) => { upstreamHeaders[k] = v; });
      let rawData = text;
      try { rawData = JSON.parse(text); } catch {}
      const transformed = mitmPlan.transformResponse(upstreamRes.status, upstreamRes.statusText, upstreamHeaders, rawData);
      res.status(transformed.status || upstreamRes.status);
      return res.send(typeof transformed.data === 'string' ? transformed.data : JSON.stringify(transformed.data));
    }

    // Stream raw media chunks/binary directly to caller with zero memory buffering for instant TTFB
    if (upstreamRes.body && typeof Readable.fromWeb === 'function') {
      return Readable.fromWeb(upstreamRes.body).pipe(res);
    }

    // Fallback: arrayBuffer
    const arrayBuffer = await upstreamRes.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    applyCors(req, res);
    res.setHeader('x-sdm-error', err.message || 'Forwarding failed');
    return res.status(502).json({
      error: `Failed to forward request to upstream: ${err.message}`,
    });
  }
});

module.exports = router;
