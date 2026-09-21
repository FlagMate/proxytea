const express = require('express');
const { asyncHandler, HttpError } = require('../lib/http');
const ApiKey = require('../models/ApiKey');
const Workspace = require('../models/Workspace');
const Rule = require('../models/Rule');
const { toProxyRule } = require('../lib/ruleSchema');

/**
 * Public, API-key-authenticated endpoints consumed by the SDK (TV app) and by
 * the Chrome extension's cloud sync. CORS is fully open for these routes (set
 * in app.js) so the SDK works from any origin.
 */
const router = express.Router();

/** Resolve + authenticate an API key from the X-API-Key header (or ?key=). */
async function authenticateApiKey(req) {
  const raw = req.headers['x-api-key'] || req.query.key;
  if (!raw) throw new HttpError(401, 'Missing API key (X-API-Key header)');

  const keyHash = ApiKey.hashKey(String(raw));
  const key = await ApiKey.findOne({ keyHash, revoked: false });
  if (!key) throw new HttpError(401, 'Invalid or revoked API key');

  // Best-effort last-used timestamp (don't block the response on it).
  key.lastUsedAt = new Date();
  key.save().catch(() => {});
  return key;
}

/**
 * GET /public/rules
 * Returns the ACTIVE profile's ENABLED rules for the API key's workspace, in the
 * exact ProxyRule wire shape the extension + SDK understand.
 *
 * Query:
 *   includeDisabled=1  → include disabled rules too (default: only enabled)
 */
router.get(
  '/rules',
  asyncHandler(async (req, res) => {
    const key = await authenticateApiKey(req);
    const workspace = await Workspace.findById(key.workspace);
    if (!workspace) throw new HttpError(404, 'Workspace not found');

    const keyRuleCount = await Rule.countDocuments({ apiKey: key._id });
    const filter = keyRuleCount > 0
      ? { apiKey: key._id }
      : workspace.activeProfile
        ? { profile: workspace.activeProfile }
        : { workspace: workspace._id };

    if (req.query.includeDisabled !== '1') filter.enabled = true;

    const rules = await Rule.find(filter).sort({ priority: 1, createdAt: 1 });
    res.json({
      success: true,
      data: {
        workspace: String(workspace._id),
        apiKey: {
          id: String(key._id),
          name: key.name || key.label || 'Default Key',
        },
        profile: workspace.activeProfile ? String(workspace.activeProfile) : null,
        rules: rules.map(toProxyRule),
      },
    });
  })
);

/**
 * GET /public/rules.json
 * A raw ProxyRule[] array (no envelope) — CDN-file-compatible. This lets the
 * extension point its existing CDN "Override URL" at
 *   {SERVER}/public/rules.json?key=sdm_live_...
 * and reuse its normalizeImportedRules → mergeEffectiveRules path unchanged.
 */
router.get(
  '/rules.json',
  asyncHandler(async (req, res) => {
    const key = await authenticateApiKey(req);
    const workspace = await Workspace.findById(key.workspace);
    if (!workspace) return res.json([]);

    const keyRuleCount = await Rule.countDocuments({ apiKey: key._id });
    const filter = keyRuleCount > 0
      ? { apiKey: key._id }
      : workspace.activeProfile
        ? { profile: workspace.activeProfile }
        : { workspace: workspace._id };

    if (req.query.includeDisabled !== '1') filter.enabled = true;
    const rules = await Rule.find(filter).sort({ priority: 1, createdAt: 1 });
    res.json(rules.map(toProxyRule));
  })
);

/** GET /public/verify — lightweight key check used by SDK/extension on connect. */
router.get(
  '/verify',
  asyncHandler(async (req, res) => {
    const key = await authenticateApiKey(req);
    const workspace = await Workspace.findById(key.workspace);
    res.json({
      success: true,
      data: {
        workspace: workspace ? { id: String(workspace._id), name: workspace.name } : null,
        apiKey: { id: String(key._id), name: key.name || key.label || 'Default Key' },
        activeProfile: workspace && workspace.activeProfile ? String(workspace.activeProfile) : null,
      },
    });
  })
);

module.exports = router;
