/**
 * Lightweight server-side CORS forwarder & Server-Side MITM proxy route.
 *
 * Capabilities:
 * 1. Dumb Forwarding: Forwards requests server-to-server with no browser CORS restrictions.
 * 2. Server Side Resource Override (Server MITM):
 *    - When serverOverride flag is set or apiKey is provided:
 *    - Retrieves rules from DB for the specified apiKey / workspace.
 *    - Evaluates URL pattern, method, priority, redirects, request headers, request bodies.
 *    - Synthesizes mocks or blocks without hitting network if configured.
 *    - Forwards request with all mutations applied.
 *    - Evaluates response transforms (status override, response headers, merge-json, replace, js-transform).
 *    - Returns response matching exact frontend expectations.
 */
const express = require('express');
const { mongoose } = require('../config/db');
const ApiKey = require('../models/ApiKey');
const Rule = require('../models/Rule');
const Workspace = require('../models/Workspace');
const { toProxyRule } = require('../lib/ruleSchema');
const { processServerMitm, delay } = require('../lib/mitm');

const router = express.Router();

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

async function resolveApiKeyAndRules(rawKey) {
  if (!rawKey || typeof rawKey !== 'string') return [];
  const keyStr = rawKey.trim();
  if (!keyStr) return [];

  let keyDoc = null;
  // 1. Try hashed lookup (for sdm_live_... keys)
  try {
    const keyHash = ApiKey.hashKey(keyStr);
    keyDoc = await ApiKey.findOne({ keyHash, revoked: false });
  } catch {}

  // 2. Try ObjectId lookup
  if (!keyDoc && mongoose.Types.ObjectId.isValid(keyStr)) {
    try {
      keyDoc = await ApiKey.findOne({ _id: keyStr, revoked: false });
    } catch {}
  }

  // 3. Try name lookup
  if (!keyDoc) {
    try {
      keyDoc = await ApiKey.findOne({ name: keyStr, revoked: false });
    } catch {}
  }

  if (!keyDoc) return [];

  // Best-effort update lastUsedAt
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

async function handleForward(req, res) {
  const startTime = Date.now();
  const targetUrl = req.body?.url || req.query?.url;

  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).json({
      success: false,
      status: 400,
      statusText: 'Bad Request',
      error: 'Missing required "url" parameter',
      time: 0,
    });
  }

  try {
    const rawMethod = (req.body?.method || req.query?.method || req.method || 'GET').toUpperCase();
    const method = rawMethod === 'POST' && req.body?.method ? req.body.method.toUpperCase() : rawMethod;

    // Filter incoming headers
    const incomingHeaders = req.body?.headers || {};
    const cleanHeaders = {};
    for (const [key, val] of Object.entries(incomingHeaders)) {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && typeof val === 'string') {
        cleanHeaders[key] = val;
      }
    }

    const rawBody = req.body?.body;
    let initialBody = undefined;
    if (method !== 'GET' && method !== 'HEAD' && rawBody !== undefined && rawBody !== null) {
      initialBody = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
    }

    // Check Server Override flag and API Key
    const apiKey = req.body?.apiKey || req.headers['x-api-key'] || req.query?.key || req.query?.apiKey;
    const serverOverrideRequested = Boolean(
      req.body?.serverOverride ||
      req.body?.serverSideOverride ||
      req.query?.serverOverride ||
      req.headers['x-server-override'] ||
      (apiKey && req.body?.serverOverride !== false)
    );

    let rules = [];
    if (serverOverrideRequested && apiKey) {
      rules = await resolveApiKeyAndRules(apiKey);
    }

    // If caller provided explicit rules directly in the payload
    if (Array.isArray(req.body?.rules) && req.body.rules.length > 0) {
      rules = req.body.rules;
    }

    // Process MITM (if rules are present)
    const mitmPlan = await processServerMitm({
      url: targetUrl,
      method,
      headers: cleanHeaders,
      body: initialBody,
      rules,
    });

    const rulesApplied = mitmPlan.matched.map((r) => r.name);

    // If blocked or synthesized mock, return without calling upstream network
    if (mitmPlan.isBlocked || mitmPlan.isMocked) {
      if (mitmPlan.preDelay > 0) {
        await delay(mitmPlan.preDelay);
      }
      return res.json({
        success: true,
        status: mitmPlan.mockResponse.status,
        statusText: mitmPlan.mockResponse.statusText,
        headers: mitmPlan.mockResponse.headers,
        data: mitmPlan.mockResponse.data,
        time: Date.now() - startTime,
        serverOverride: rulesApplied.length > 0,
        rulesApplied,
      });
    }

    // Pre-request artificial latency
    if (mitmPlan.preDelay > 0) {
      await delay(mitmPlan.preDelay);
    }

    const fetchOpts = {
      method: mitmPlan.targetMethod === 'HEAD' ? 'HEAD' : mitmPlan.targetMethod,
      headers: mitmPlan.reqHeaders,
    };

    if (mitmPlan.targetMethod !== 'GET' && mitmPlan.targetMethod !== 'HEAD' && mitmPlan.reqBody !== undefined && mitmPlan.reqBody !== null) {
      fetchOpts.body = typeof mitmPlan.reqBody === 'string' ? mitmPlan.reqBody : JSON.stringify(mitmPlan.reqBody);
    }

    const upstreamRes = await fetch(mitmPlan.targetUrl, fetchOpts);
    const text = await upstreamRes.text();

    const upstreamHeaders = {};
    upstreamRes.headers.forEach((val, key) => {
      upstreamHeaders[key] = val;
    });

    let rawData = text;
    try {
      rawData = JSON.parse(text);
    } catch {
      // Keep string if not JSON
    }

    // Post-request artificial latency
    if (mitmPlan.postDelay > 0) {
      await delay(mitmPlan.postDelay);
    }

    // Apply response transforms (status, headers, body replace/merge-json/js-transform)
    const finalTransformed = mitmPlan.transformResponse
      ? mitmPlan.transformResponse(upstreamRes.status, upstreamRes.statusText, upstreamHeaders, rawData)
      : { status: upstreamRes.status, statusText: upstreamRes.statusText, headers: upstreamHeaders, data: rawData };

    return res.json({
      success: true,
      status: finalTransformed.status,
      statusText: finalTransformed.statusText,
      headers: finalTransformed.headers,
      data: finalTransformed.data,
      time: Date.now() - startTime,
      serverOverride: rulesApplied.length > 0,
      rulesApplied,
    });
  } catch (err) {
    return res.json({
      success: false,
      status: 0,
      statusText: 'Error',
      headers: {},
      data: null,
      error: err.message || 'Failed to forward request',
      time: Date.now() - startTime,
    });
  }
}

router.options('*', (req, res) => res.sendStatus(204));
router.post('/', handleForward);
router.get('/', handleForward);

module.exports = router;
